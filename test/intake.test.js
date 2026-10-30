import test from "node:test";
import assert from "node:assert/strict";

const { parseJobOrder, scanRange, intakeFailureDisposition } = await import("../src/services/intake.js");

test("job orders are read from a JSON description envelope", () => {
  assert.deepEqual(parseJobOrder('{"offeringId":"token_swap","params":{"sellToken":"USDC","buyToken":"WETH","amount":"1"}}'), {
    offeringId: "token_swap",
    params: { sellToken: "USDC", buyToken: "WETH", amount: "1" },
    quoteId: null,
    referrer: null,
    format: "json",
  });
  assert.deepEqual(parseJobOrder('{"offering":"mega_report"}'), {
    offeringId: "mega_report",
    params: {},
    quoteId: null,
    referrer: null,
    format: "json",
  });
  assert.deepEqual(
    parseJobOrder(
      '{"offeringId":"deep_analytics","params":{"target":"VIRTUAL"},"quoteId":"q-1","referrer":"0x0000000000000000000000000000000000000002"}'
    ),
    {
      offeringId: "deep_analytics",
      params: { target: "VIRTUAL" },
      quoteId: "q-1",
      referrer: "0x0000000000000000000000000000000000000002",
      format: "json",
    }
  );
});

test("job orders accept the compact offering prefix form", () => {
  assert.deepEqual(parseJobOrder('trending_tokens {"limit":5}'), {
    offeringId: "trending_tokens",
    params: { limit: 5 },
    format: "text",
  });
  assert.deepEqual(parseJobOrder("offering:topic_research"), {
    offeringId: "topic_research",
    params: {},
    format: "id",
  });
});

test("free-form prose and unknown offerings are not executed", () => {
  assert.equal(parseJobOrder("swap 10 USDC to WETH"), null);
  assert.equal(parseJobOrder('{"offeringId":"unknown_offering"}'), null);
  assert.equal(parseJobOrder('{"offeringId":"token_swap","params":[1,2]}'), null);
  assert.equal(parseJobOrder(""), null);
});

test("the scan window advances by at most scanLimit ids", () => {
  assert.deepEqual(scanRange({ cursor: "10", counter: "25", scanLimit: 5 }), {
    from: 11n,
    to: 15n,
    last: 15n,
  });
  assert.deepEqual(scanRange({ cursor: "25", counter: "25", scanLimit: 5 }), {
    from: null,
    to: null,
    last: 25n,
  });
  assert.deepEqual(scanRange({ cursor: "24", counter: "25", scanLimit: 5 }), {
    from: 25n,
    to: 25n,
    last: 25n,
  });
});

test("a fresh cursor anchors at the head unless a start id is configured", () => {
  assert.equal(scanRange({ cursor: null, counter: "900", scanLimit: 10 }), null);
  assert.deepEqual(scanRange({ cursor: null, counter: "900", scanLimit: 4, startId: 7 }), {
    from: 7n,
    to: 10n,
    last: 10n,
  });
});

test("transient pre-record failures defer the cursor instead of skipping funded jobs", () => {
  assert.equal(intakeFailureDisposition({ code: "ACP_READ_FAILED" }, false), "deferred");
  assert.equal(intakeFailureDisposition({ code: "RPC_READ_FAILED" }, false), "deferred");
  assert.equal(intakeFailureDisposition({ code: "ACP_CONTRACT_MISSING" }, false), "deferred");
  assert.equal(intakeFailureDisposition(new Error("store down"), false), "deferred");
  assert.equal(intakeFailureDisposition(undefined, false), "deferred");
});

test("terminal escrow-state failures and recorded jobs advance the cursor", () => {
  for (const code of [
    "ESCROW_NOT_FOUND",
    "ESCROW_NOT_FUNDED",
    "INVALID_JOB_STATE",
    "ESCROW_WRONG_PROVIDER",
    "ESCROW_BUDGET_TOO_LOW",
    "ESCROW_EXPIRING",
    "ESCROW_INSOLVENT",
    "BUYER_MISMATCH",
    "ESCROW_WRONG_TOKEN",
  ]) {
    assert.equal(intakeFailureDisposition({ code }, false), "advance", code);
  }
  assert.equal(intakeFailureDisposition({ code: "ACP_READ_FAILED" }, true), "advance");
  assert.equal(intakeFailureDisposition({ code: "EXECUTION_FAILED" }, true), "advance");
});

test("gas-gated failures keep their own disposition", () => {
  assert.equal(intakeFailureDisposition({ code: "WALLET_GAS_UNAVAILABLE" }, false), "gas_gated");
  assert.equal(intakeFailureDisposition({ code: "WALLET_GAS_UNAVAILABLE" }, true), "gas_gated");
});
