import test from "node:test";
import assert from "node:assert/strict";
import {
  buildX402Manifest,
  findUsdcPayment,
  freeTier,
  paymentTermsJSON,
  X402_RESOURCES,
} from "../src/services/x402-worker.js";
import { USDC } from "../src/config.js";

const PAYER = "0x5425fCc20e2F9842E042d42D114a54D896Ca6192";
const PAY_TO = "0x3D8e69cA6B52dA775433D164B19E4104053E5d05";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const topic = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const transferLog = ({ from, to, value }) => ({
  address: USDC.address.toLowerCase(),
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: `0x${value.toString(16).padStart(64, "0")}`,
});

test("manifest is x402 v2 with live status, facilitator and payTo", () => {
  const manifest = buildX402Manifest("https://hyper-agent-x7733.vercel.app", PAY_TO);
  assert.equal(manifest.x402Version, 2);
  assert.equal(manifest.status, "live");
  assert.equal(manifest.facilitator, "https://api.cdp.coinbase.com/platform/v2/x402");
  assert.equal(manifest.resources.length, X402_RESOURCES.length);
  for (const resource of manifest.resources) {
    assert.equal(resource.payTo, PAY_TO);
    assert.equal(resource.asset, "USDC");
    assert.equal(resource.network, "eip155:8453");
    assert.ok(resource.resource.startsWith("https://hyper-agent-x7733.vercel.app/api/x402/"));
  }
  assert.equal(manifest.free_tier.resource, freeTier.resource);
  assert.ok(manifest.free_tier.global_per_day > 0);
});

test("token verdict and wallet dossier are listed with matching prices", () => {
  const byId = Object.fromEntries(X402_RESOURCES.map((resource) => [resource.id, resource]));
  assert.equal(byId["token-verdict"].price, "$0.02");
  assert.equal(byId["token-verdict"].priceUnits, 20000n);
  assert.equal(byId["wallet-dossier"].price, "$0.05");
  assert.equal(byId["wallet-dossier"].priceUnits, 50000n);
});

test("findUsdcPayment sums payer->payTo USDC transfers and ignores others", () => {
  const receipt = {
    logs: [
      transferLog({ from: PAYER, to: PAY_TO, value: 20000n }),
      transferLog({ from: PAYER, to: PAY_TO, value: 5000n }),
      transferLog({ from: PAY_TO, to: PAYER, value: 999999n }),
      { address: "0x000000000000000000000000000000000000dead", topics: [TRANSFER_TOPIC, topic(PAYER), topic(PAY_TO)], data: "0x" + "1".padStart(64, "0") },
    ],
  };
  assert.equal(findUsdcPayment(receipt, PAYER, PAY_TO), 25000n);
  assert.equal(findUsdcPayment(receipt, PAYER, "0x9669448fcf5cc2b27154d08f8908e457e3aa8708"), 0n);
  assert.equal(findUsdcPayment(null, PAYER, PAY_TO), 0n);
});

test("payment terms carry the wallet, amount and on-chain instructions", () => {
  const terms = paymentTermsJSON("token-verdict");
  assert.equal(terms.error.code, "PAYMENT_REQUIRED");
  assert.equal(terms.terms.asset, "USDC");
  assert.equal(terms.terms.token, USDC.address);
  assert.equal(terms.terms.amount, "$0.02");
  assert.equal(terms.terms.network, "eip155:8453");
  assert.match(terms.terms.payTo, /^0x[0-9a-fA-F]{40}$/);
  assert.match(terms.terms.instructions, /payer/);
});
