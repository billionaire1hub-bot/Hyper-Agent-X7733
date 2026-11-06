import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.X_AUTO_UPGRADE = "true";
process.env.X_AUTO_UPGRADE_THRESHOLD_USD = "10";

const { config } = await import("../src/config.js");
const { xAutoUpgradeStatus } = await import("../src/services/outreach.js");

const eth = (amount) => BigInt(Math.floor(amount * 1e18));

test("the auto-upgrade rule is enabled with the configured threshold", () => {
  assert.equal(config.social.xAutoUpgrade.enabled, true);
  assert.equal(config.social.xAutoUpgrade.thresholdUsd, 10);
});

test("the X auto-upgrade trigger fires once wallet earnings cover the cheapest X plan", async () => {
  // 0.005 ETH at $2000/ETH = $10 — exactly the configured threshold.
  const below = await xAutoUpgradeStatus({ ethBalance: eth(0.0049), priceUsd: 2000 });
  assert.equal(below.eligible, false);
  assert.equal(below.walletUsd, 9.8);

  const at = await xAutoUpgradeStatus({ ethBalance: eth(0.005), priceUsd: 2000 });
  assert.equal(at.eligible, true);
  assert.equal(at.walletUsd, 10);
  assert.match(at.action, /upgrade the X plan/);
});

test("an unknown wallet balance never triggers the upgrade", async () => {
  const result = await xAutoUpgradeStatus({ ethBalance: null, priceUsd: 2000 });
  assert.equal(result.eligible, false);
  assert.equal(result.walletUsd, null);
});
