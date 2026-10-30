import test from "node:test";
import assert from "node:assert/strict";

import { ONCHAIN_EXECUTION_OFFERINGS, config } from "../src/config.js";
import { onchainGasGated } from "../src/chain/client.js";
import { unlockWeiFor } from "../src/services/gas.js";
import { OFFERINGS } from "../src/services/offerings.js";

const ONCHAIN_IDS = [
  "token_swap",
  "transfer_token",
  "batch_executor",
  "fund_startup",
  "semi_batch_fund_startup",
  "batch_fund_startup",
];

test("exactly the six on-chain offerings are registered for gas gating", () => {
  assert.equal(ONCHAIN_EXECUTION_OFFERINGS.size, 6);
  const offeringIds = new Set(OFFERINGS.map((offering) => offering.id));
  for (const id of ONCHAIN_IDS) {
    assert.ok(ONCHAIN_EXECUTION_OFFERINGS.has(id), `${id} must be gated`);
    assert.ok(offeringIds.has(id), `${id} must exist in the registry`);
  }
  for (const offering of OFFERINGS) {
    if (ONCHAIN_IDS.includes(offering.id)) continue;
    assert.ok(!ONCHAIN_EXECUTION_OFFERINGS.has(offering.id), `${offering.id} must stay ungated`);
  }
});

test("on-chain offerings gate only below the USD-derived unlock threshold", () => {
  const dust = 10n ** 15n;
  for (const id of ONCHAIN_IDS) {
    assert.equal(onchainGasGated({ offeringId: id, ethBalance: 0n }), true, `${id} at 0 ETH`);
    assert.equal(onchainGasGated({ offeringId: id, ethBalance: 1n, unlockThresholdWei: 0n }), false, `${id} at 1 wei, zero threshold`);
    assert.equal(onchainGasGated({ offeringId: id, ethBalance: dust - 1n, unlockThresholdWei: dust }), true, `${id} below threshold`);
    assert.equal(onchainGasGated({ offeringId: id, ethBalance: dust, unlockThresholdWei: dust }), false, `${id} at threshold`);
  }
});

test("unknown balances never gate offerings", () => {
  for (const id of ONCHAIN_IDS) {
    assert.equal(onchainGasGated({ offeringId: id, ethBalance: null, unlockThresholdWei: 10n ** 15n }), false);
    assert.equal(onchainGasGated({ offeringId: id, ethBalance: undefined, unlockThresholdWei: 10n ** 15n }), false);
  }
});

test("USD threshold converts to wei via the live-price or fallback rate", () => {
  assert.equal(unlockWeiFor(0.75, 3000), 250_000_000_000_000n);
  assert.equal(unlockWeiFor(1, 2000), 500_000_000_000_000n);
  assert.ok(unlockWeiFor(0.75, NaN) > 0n, "non-numeric price falls back to the configured rate");
  assert.ok(config.execution.onchainUnlockMinUsd >= 0.1 && config.execution.onchainUnlockMinUsd <= 10);
  assert.ok(config.execution.ethUsdFallback >= 100 && config.execution.ethUsdFallback <= 100_000);
});

test("zero-gas intelligence and data offerings are never gated", () => {
  for (const offering of OFFERINGS) {
    if (ONCHAIN_IDS.includes(offering.id)) continue;
    assert.equal(
      onchainGasGated({ offeringId: offering.id, ethBalance: 0n }),
      false,
      `${offering.id} must execute with 0 ETH`
    );
  }
  assert.equal(onchainGasGated({ offeringId: "unknown_offering", ethBalance: 0n }), false);
});

test("the donation margin is clamped to the 20-50% service-fee band", () => {
  assert.ok(config.revenue.donationMarginBps >= 2000);
  assert.ok(config.revenue.donationMarginBps <= 5000);
});
