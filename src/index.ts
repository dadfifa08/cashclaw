import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startAgent } from "./agent.js";
import { getDashboardUrl } from "./system/runtime_paths.js";

function getProjectRoot(): string {
  return path.resolve(import.meta.dirname, "..");
}

function latestMtimeMs(targetPath: string): number {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    latest = Math.max(latest, latestMtimeMs(path.join(targetPath, entry.name)));
  }
  return latest;
}

function needsUiBuild(projectRoot: string): boolean {
  const uiSourceDir = path.join(projectRoot, "src", "ui");
  const builtIndex = path.join(projectRoot, "dist", "ui", "index.html");
  if (!fs.existsSync(builtIndex)) {
    return true;
  }

  return latestMtimeMs(uiSourceDir) > fs.statSync(builtIndex).mtimeMs;
}

async function buildUi(projectRoot: string): Promise<void> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ["run", "build:ui"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Dashboard build failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function ensureDashboardAssets(): Promise<void> {
  const projectRoot = getProjectRoot();
  if (!needsUiBuild(projectRoot)) {
    return;
  }

  console.log("Building dashboard assets...");
  await buildUi(projectRoot);
}

async function openBrowser(url: string) {
  const { execFile: execFileCb } = await import("node:child_process");

  if (process.platform === "win32") {
    execFileCb("cmd", ["/c", "start", "", url], { windowsHide: true }, () => {});
    return;
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  execFileCb(opener, [url], () => {});
}

async function main() {
  console.log("Starting Cateo...");
  await ensureDashboardAssets();

  const server = await startAgent();
  await openBrowser(getDashboardUrl());

  const shutdown = () => {
    console.log("\nShutting down...");
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
