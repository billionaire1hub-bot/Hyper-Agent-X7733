import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.X_CONSUMER_KEY = "test-consumer-key";
process.env.X_CONSUMER_SECRET = "test-consumer-secret";
process.env.X_ACCESS_TOKEN = "test-access-token";
process.env.X_ACCESS_SECRET = "test-access-secret";
process.env.X_USER_ACCESS_TOKEN = "test-oauth2-user-token";

const { oauth1Configured, oauth2UserConfigured, postTweet } = await import("../src/services/x.js");
const { sendXPitch } = await import("../src/services/outreach.js");

const jsonResponse = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(payload),
});

const unauthorized = () => jsonResponse(401, { detail: "Unauthorized" });

test("both credential families are configured for the fallback tests", () => {
  assert.equal(oauth1Configured(), true);
  assert.equal(oauth2UserConfigured(), true);
});

test("a 401 from the OAuth 2.0 user token retries once with OAuth 1.0a", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.authorization });
    if (calls.length === 1) return unauthorized();
    return jsonResponse(200, { data: { id: "123", text: "hello" } });
  };
  try {
    const tweet = await postTweet("hello");
    assert.equal(tweet.id, "123");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, "Bearer test-oauth2-user-token");
    assert.match(calls[1].authorization, /^OAuth /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 403 also switches credential families", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(options.headers.authorization);
    if (calls.length === 1) return jsonResponse(403, { title: "Forbidden" });
    return jsonResponse(200, { data: { id: "456", text: "hello" } });
  };
  try {
    const tweet = await postTweet("hello");
    assert.equal(tweet.id, "456");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "Bearer test-oauth2-user-token");
    assert.match(calls[1], /^OAuth /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 401 from every credential family fails with X_HTTP_401 and the last message", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push(1);
    return jsonResponse(401, { detail: "Unauthorized" });
  };
  try {
    await assert.rejects(
      () => postTweet("hello"),
      (error) => error.code === "X_HTTP_401" && /x-api: Unauthorized/.test(error.message)
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 429 rate limit never switches credential families", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push(1);
    return jsonResponse(429, { detail: "Too Many Requests" }, {
      "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 60),
    });
  };
  try {
    await assert.rejects(
      () => postTweet("hello"),
      (error) => error.code === "X_RATE_LIMITED" && /x-api: Too Many Requests/.test(error.message)
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendXPitch flags credential rejections as auth errors for the outreach cycle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => unauthorized();
  try {
    const result = await sendXPitch({ handle: "AlphaRadar", text: "pitch" });
    assert.equal(result.ok, false);
    assert.equal(result.authError, true);
    assert.equal(result.code, "X_HTTP_401");
    assert.match(result.error, /x-api: Unauthorized/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
