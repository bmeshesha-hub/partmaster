import { spawn } from "node:child_process";

const remote = process.env.PARTMASTER_PUBLISH_REMOTE || "public-backup";
const target = process.env.PARTMASTER_PUBLISH_TARGET || "HEAD:main";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`)));
  });
}

await run("npm", ["run", "publish:master"]);
await run("git", ["add", "public/data/master-catalog-index.json", "public/data/master-catalog-chunks"]);
await run("git", ["commit", "-m", "Update published master data"]);
await run("git", ["push", remote, target]);
console.log(`Published the master-data portal to ${remote} (${target}).`);
