import { startAgent } from "./agent.js";
import { getDashboardUrl } from "./system/runtime_paths.js";

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
