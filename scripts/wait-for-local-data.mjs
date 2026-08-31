const host = "127.0.0.1";
const port = Number(process.env.PARTMASTER_DATA_PORT || 8787);
const deadline = Date.now() + 5 * 60 * 1000;

async function check() {
  try {
    const response = await fetch(`http://${host}:${port}/api/local/health`, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ready: false, detail: `HTTP ${response.status}` };
    const health = await response.json();
    return { ready: Boolean(health.ok && !health.initializing && health.databaseReady !== false), detail: health.initializing ? "database initializing" : health.databaseReady === false ? "database unavailable" : "ready" };
  } catch (error) {
    return { ready: false, detail: error.code || error.message };
  }
}

while (Date.now() < deadline) {
  const result = await check();
  if (result.ready) {
    console.log(`Local data service is ready at http://${host}:${port}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.error(`Timed out waiting for a ready local data service at http://${host}:${port}/api/local/health`);
console.error("If another process owns the DuckDB file, stop that process and restart only one local:data server.");
process.exit(1);
