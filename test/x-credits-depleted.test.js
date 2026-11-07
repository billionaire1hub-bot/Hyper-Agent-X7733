import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.X_CONSUMER_KEY = "test-consumer-key";
process.env.X_CONSUMER_SECRET = "test-consumer-secret";
process.env.X_ACCESS_TOKEN = "test-access-token";
process.env.X_ACCESS_SECRET = "test-access-secret";
process.env.X_USER_ACCESS_TOKEN = "test-oauth2-user-token";

const { postTweet } = await import("../src/services/x.js");
const { sendXPitch } = await import("../src/services/outreach.js");

const jsonResponse = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(payload),
});

test("'credits depleted' fails with X_CREDITS_DEPLETED and never retries another credential family", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(options.headers.authorization);
    return jsonResponse(403, { detail: "Your plan ran out of monthly credits; credits depleted" });
  };
  try {
    await assert.rejects(
      () => postTweet("hello"),
      (error) => error.code === "X_CREDITS_DEPLETED" && /credits depleted/.test(error.message)
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "Bearer test-oauth2-user-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an entitlement-style rejection is also treated as credit exhaustion", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push(1);
    return jsonResponse(400, { title: "You are not entitled to POST /2/tweets on your plan" });
  };
  try {
    await assert.rejects(
      () => postTweet("hello"),
      (error) => error.code === "X_CREDITS_DEPLETED" && /not entitled/.test(error.message)
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendXPitch flags credit exhaustion separately from dead credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse(403, { detail: "Your plan ran out of monthly credits; credits depleted" });
  try {
    const result = await sendXPitch({ handle: "AlphaRadar", text: "pitch" });
    assert.equal(result.ok, false);
    assert.equal(result.creditsDepleted, true);
    assert.equal(result.authError, false);
    assert.equal(result.code, "X_CREDITS_DEPLETED");
    assert.equal(result.detail, "Your plan ran out of monthly credits; credits depleted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
