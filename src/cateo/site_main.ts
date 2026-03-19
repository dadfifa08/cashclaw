import { startCateoSiteBridge, resolveCateoSiteBridgeSettings } from "./site_server.js";

async function main() {
  const settings = resolveCateoSiteBridgeSettings();
  console.log("Starting Cateo site bridge...");
  const server = await startCateoSiteBridge(settings);
  console.log(`Cateo site bridge: ${settings.baseUrl}`);

  const shutdown = () => {
    console.log("\nShutting down Cateo site bridge...");
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
