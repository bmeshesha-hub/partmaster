import { spawn } from "node:child_process";

const host = "127.0.0.1";
const port = Number(process.env.PARTMASTER_DATA_PORT || 8787);
const healthUrl = `http://${host}:${port}/api/local/health`;

async function existingService() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const health = await response.json();
    // A listening process is still the single owner of the control plane while
    // DuckDB is opening. Never launch a second server during that window: the
    // second process can only fail by competing for the database lock.
    return health?.ok === true;
  } catch {
    return false;
  }
}

if (await existingService()) {
  console.log(`Reusing local data service at http://${host}:${port}`);
  // This command is intentionally successful. It must not trigger
  // concurrently's kill-on-exit behavior when the service is already owned
  // by another terminal/process.
  process.exit(0);
}

const child = spawn(process.execPath, ["--env-file-if-exists=.env", "server/localDataServer.js"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Unable to start local data service: ${error.message}`);
  process.exit(1);
});
