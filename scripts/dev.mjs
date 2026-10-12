import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backend = join(root, "backend");
const python = join(backend, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const next = join(root, "node_modules/next/dist/bin/next");
const production = process.argv.includes("--production");
const checkOnly = process.argv.includes("--check");
if (!checkOnly && (!existsSync(python) || !existsSync(next))) {
  console.error("Dependencies are missing. On Windows run start.ps1 first.");
  process.exit(1);
}
if (production && !existsSync(join(root, ".next/BUILD_ID"))) {
  console.error("Production build is missing. Run npm run build first.");
  process.exit(1);
}

async function ensurePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is in use. Stop the existing service before starting NeuroLens.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

try {
  await Promise.all([ensurePort(3000), ensurePort(8010)]);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (checkOnly) {
  console.log("NeuroLens ports 3000 and 8010 are available.");
  process.exit(0);
}

const children = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
}

function launch(name, executable, args, cwd) {
  const child = spawn(executable, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", NEXT_TELEMETRY_DISABLED: "1", BACKEND_URL: "http://127.0.0.1:8010" },
  });
  children.push(child);
  child.stdout.on("data", (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[${name}] ${data}`));
  child.once("error", (error) => { console.error(`${name}: ${error.message}`); stop(1); });
  child.once("exit", (code) => {
    if (!stopping) { console.error(`${name} exited (${code}). Stopping both services.`); stop(code ?? 1); }
  });
}

process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
console.log("NeuroLens local workspace: http://127.0.0.1:3000");
console.log("API health: http://127.0.0.1:8010/api/health");
console.log("Research only. Press Ctrl+C to stop both services.");
launch("api", python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8010"], backend);
launch("web", process.execPath, [next, production ? "start" : "dev", "--hostname", "127.0.0.1", "--port", "3000"], root);
