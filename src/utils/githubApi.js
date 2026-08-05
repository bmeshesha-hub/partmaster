import { Octokit } from "@octokit/rest";

export const DEFAULT_REPOSITORY = {
  owner: import.meta.env.VITE_GITHUB_OWNER || "bmeshesha-hub",
  repo: import.meta.env.VITE_GITHUB_DATA_REPO || "partmaster_data",
  branch: import.meta.env.VITE_GITHUB_BRANCH || "main",
};

const QUEUE_PATH = "data/queue.json";
const APPROVED_PATH = "data/approved.json";

function makeClient(token) {
  if (!token) throw new Error("Add a GitHub token in Settings first.");
  return new Octokit({ auth: token });
}

// GitHub's Contents API returns file bytes as base64. Decode into bytes first,
// then use TextDecoder so non-ASCII part names are preserved correctly.
export function decodeBase64(encoded) {
  const binary = atob(encoded.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// btoa only accepts single-byte strings. TextEncoder converts Unicode JSON to
// UTF-8 bytes; chunking avoids overflowing the argument stack for larger files.
export function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function parseJsonFile(file, path) {
  if (Array.isArray(file) || file.type !== "file" || !file.content) {
    throw new Error(`${path} is not a readable file.`);
  }

  const data = JSON.parse(decodeBase64(file.content));
  if (!Array.isArray(data)) throw new Error(`${path} must contain a JSON array.`);

  return { data, sha: file.sha };
}

async function getJsonFileAtRef(octokit, repository, path, ref) {
  const response = await octokit.repos.getContent({
    owner: repository.owner,
    repo: repository.repo,
    path,
    ref,
  });

  return parseJsonFile(response.data, path);
}

export async function fetchQueue(token, repository = DEFAULT_REPOSITORY) {
  const octokit = makeClient(token);
  const result = await getJsonFileAtRef(
    octokit,
    repository,
    QUEUE_PATH,
    repository.branch,
  );

  return result.data;
}

export async function approveQueueItem({
  token,
  itemId,
  variantId,
  repository = DEFAULT_REPOSITORY,
}) {
  const octokit = makeClient(token);
  const repoParams = { owner: repository.owner, repo: repository.repo };

  // Pin every read to the same branch head. In addition to giving us the two
  // requested content SHAs, this prevents queue.json and approved.json from
  // being read from different revisions during concurrent reviews.
  const refResponse = await octokit.git.getRef({
    ...repoParams,
    ref: `heads/${repository.branch}`,
  });
  const headSha = refResponse.data.object.sha;

  const [queueFile, approvedFile, headCommit] = await Promise.all([
    getJsonFileAtRef(octokit, repository, QUEUE_PATH, headSha),
    getJsonFileAtRef(octokit, repository, APPROVED_PATH, headSha),
    octokit.git.getCommit({ ...repoParams, commit_sha: headSha }),
  ]);

  const item = queueFile.data.find((candidate) => String(candidate.id) === String(itemId));
  if (!item) throw new Error("This item is no longer in the review queue. Refresh and try again.");

  const selectedVariant = item.variants?.find(
    (variant) => String(variant.id) === String(variantId),
  );
  if (!selectedVariant) throw new Error("Choose a valid variant before approving.");

  const nextQueue = queueFile.data.filter(
    (candidate) => String(candidate.id) !== String(itemId),
  );
  const nextApproved = [
    ...approvedFile.data,
    {
      ...item,
      approved_variant: selectedVariant,
      approved_at: new Date().toISOString(),
    },
  ];

  const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;
  const [queueBlob, approvedBlob] = await Promise.all([
    octokit.git.createBlob({
      ...repoParams,
      content: encodeBase64(serialize(nextQueue)),
      encoding: "base64",
    }),
    octokit.git.createBlob({
      ...repoParams,
      content: encodeBase64(serialize(nextApproved)),
      encoding: "base64",
    }),
  ]);

  // A tree + commit updates both JSON files atomically. Their original blob SHAs
  // are deliberately retained in the commit message for traceability.
  const tree = await octokit.git.createTree({
    ...repoParams,
    base_tree: headCommit.data.tree.sha,
    tree: [
      { path: QUEUE_PATH, mode: "100644", type: "blob", sha: queueBlob.data.sha },
      { path: APPROVED_PATH, mode: "100644", type: "blob", sha: approvedBlob.data.sha },
    ],
  });
  const commit = await octokit.git.createCommit({
    ...repoParams,
    message: `Approve ${item.base_part}\n\nPrevious queue SHA: ${queueFile.sha}\nPrevious approved SHA: ${approvedFile.sha}`,
    tree: tree.data.sha,
    parents: [headSha],
  });

  try {
    await octokit.git.updateRef({
      ...repoParams,
      ref: `heads/${repository.branch}`,
      sha: commit.data.sha,
      force: false,
    });
  } catch (error) {
    if (error.status === 422) {
      throw new Error("The queue changed during approval. Refresh and submit again.");
    }
    throw error;
  }

  return { approvedItem: nextApproved.at(-1), queue: nextQueue };
}
