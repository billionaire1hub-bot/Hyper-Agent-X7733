import app from "./app.js";
import { config, walletConfigured } from "./config.js";
import { logger } from "./lib/logger.js";
import { store } from "./lib/store.js";
import { startSocialLoop, stopSocialLoop } from "./services/social.js";
import { startIntakeLoop, stopIntakeLoop } from "./services/intake.js";
import { startOutreachLoop, stopOutreachLoop } from "./services/outreach.js";
import { startRevenueLoop, stopRevenueLoop } from "./services/revenue.js";

const server = app.listen(config.port, () => {
  logger.info("agent listening", {
    port: config.port,
    env: config.env,
    chainId: config.chain.id,
    walletConfigured,
    store: store.type,
    acpContract: config.acp.contract,
  });
  startSocialLoop();
  startIntakeLoop();
  startOutreachLoop();
  startRevenueLoop();
});

const shutdown = (signal) => {
  logger.info("shutting down", { signal });
  stopIntakeLoop();
  stopOutreachLoop();
  stopSocialLoop();
  stopRevenueLoop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
