import { Octokit } from "@octokit/rest";

export const DEFAULT_REPOSITORY = {
  owner: import.meta.env.VITE_GITHUB_OWNER || "bmeshesha-hub",
  repo: import.meta.env.VITE_GITHUB_DATA_REPO || "partmaster_data",
  branch: import.meta.env.VITE_GITHUB_BRANCH || "main",
};

const QUEUE_PATH = "data/queue.json";
const APPROVED_PATH = "data/approved.json";
const INPUT_PATH = "data/input.json";
const ANALYSES_PATH = "data/analyses.json";

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

async function getOptionalJsonFileAtRef(octokit, repository, path, ref) {
  try {
    return (await getJsonFileAtRef(octokit, repository, path, ref)).data;
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

export async function fetchWorkspaceData(token, repository = DEFAULT_REPOSITORY) {
  const octokit = makeClient(token);
  const repoParams = { owner: repository.owner, repo: repository.repo };
  const refResponse = await octokit.git.getRef({
    ...repoParams,
    ref: `heads/${repository.branch}`,
  });
  const headSha = refResponse.data.object.sha;

  const [input, queue, approved, analyses] = await Promise.all([
    getOptionalJsonFileAtRef(octokit, repository, INPUT_PATH, headSha),
    getOptionalJsonFileAtRef(octokit, repository, QUEUE_PATH, headSha),
    getOptionalJsonFileAtRef(octokit, repository, APPROVED_PATH, headSha),
    getOptionalJsonFileAtRef(octokit, repository, ANALYSES_PATH, headSha),
  ]);

  return { input, queue, approved, analyses, headSha };
}

export async function addInputPart({ token, part, repository = DEFAULT_REPOSITORY }) {
  const octokit = makeClient(token);
  const repoParams = { owner: repository.owner, repo: repository.repo };
  const refResponse = await octokit.git.getRef({
    ...repoParams,
    ref: `heads/${repository.branch}`,
  });
  const headSha = refResponse.data.object.sha;

  const [inputFile, headCommit] = await Promise.all([
    getJsonFileAtRef(octokit, repository, INPUT_PATH, headSha),
    octokit.git.getCommit({ ...repoParams, commit_sha: headSha }),
  ]);

  const inputItem = {
    id: crypto.randomUUID(),
    base_part: [part.year, part.make, part.model, part.partName]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join(" "),
    year: part.year.trim() || undefined,
    make: part.make.trim() || undefined,
    model: part.model.trim() || undefined,
    part_name: part.partName.trim(),
    source_part_number: part.partNumber.trim() || undefined,
    submitted_at: new Date().toISOString(),
  };

  if (!inputItem.base_part || !inputItem.part_name) {
    throw new Error("Enter a part name or description before submitting.");
  }

  const nextInput = [...inputFile.data, inputItem];
  const blob = await octokit.git.createBlob({
    ...repoParams,
    content: encodeBase64(`${JSON.stringify(nextInput, null, 2)}\n`),
    encoding: "base64",
  });
  const tree = await octokit.git.createTree({
    ...repoParams,
    base_tree: headCommit.data.tree.sha,
    tree: [{ path: INPUT_PATH, mode: "100644", type: "blob", sha: blob.data.sha }],
  });
  const commit = await octokit.git.createCommit({
    ...repoParams,
    message: `Add part for enrichment: ${inputItem.base_part}`,
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
      throw new Error("Another part was submitted at the same time. Please submit again.");
    }
    throw error;
  }

  return inputItem;
}

export async function saveAnalysisResults({ token, analysis, repository = DEFAULT_REPOSITORY }) {
  const octokit = makeClient(token);
  const repoParams = { owner: repository.owner, repo: repository.repo };
  const refResponse = await octokit.git.getRef({
    ...repoParams,
    ref: `heads/${repository.branch}`,
  });
  const headSha = refResponse.data.object.sha;
  const headCommitPromise = octokit.git.getCommit({ ...repoParams, commit_sha: headSha });
  let existingAnalyses = [];

  try {
    existingAnalyses = (
      await getJsonFileAtRef(octokit, repository, ANALYSES_PATH, headSha)
    ).data;
  } catch (error) {
    // The first saved analysis creates data/analyses.json. Later saves append
    // to the array while remaining protected by the non-forced ref update.
    if (error.status !== 404) throw error;
  }

  const savedAnalysis = {
    id: crypto.randomUUID(),
    source_name: analysis.sourceName,
    vin: analysis.vin || undefined,
    scope: analysis.scope,
    notes: analysis.notes,
    parts: analysis.results.map((part) => ({
      item_number: part.item_number,
      oem_part_number: part.oem_part_number,
      description: part.description,
      side_position: part.side_position,
    })),
    saved_at: new Date().toISOString(),
  };
  const blob = await octokit.git.createBlob({
    ...repoParams,
    content: encodeBase64(`${JSON.stringify([...existingAnalyses, savedAnalysis], null, 2)}\n`),
    encoding: "base64",
  });
  const headCommit = await headCommitPromise;
  const tree = await octokit.git.createTree({
    ...repoParams,
    base_tree: headCommit.data.tree.sha,
    tree: [{ path: ANALYSES_PATH, mode: "100644", type: "blob", sha: blob.data.sha }],
  });
  const commit = await octokit.git.createCommit({
    ...repoParams,
    message: `Save parts analysis: ${analysis.sourceName}`,
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
      throw new Error("The data repository changed while saving. Please save again.");
    }
    throw error;
  }

  return savedAnalysis;
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
