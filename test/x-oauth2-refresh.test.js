import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.X_CONSUMER_KEY = "test-consumer-key";
process.env.X_CONSUMER_SECRET = "test-consumer-secret";
process.env.X_ACCESS_TOKEN = "test-access-token";
process.env.X_ACCESS_SECRET = "test-access-secret";
process.env.X_USER_ACCESS_TOKEN = "test-static-token";
process.env.X_CLIENT_ID = "test-client-id";
process.env.X_CLIENT_SECRET = "test-client-secret";
process.env.X_REFRESH_TOKEN = "test-refresh-token";

const { oauth2RefreshConfigured, postTweet } = await import("../src/services/x.js");

const jsonResponse = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

const refreshBasic = `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`;

test("a 401 on the OAuth 2.0 user token mints a fresh token via the refresh flow and retries", async () => {
  assert.equal(oauth2RefreshConfigured(), true);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      authorization: options.headers.authorization,
      body: options.body,
    });
    if (String(url).endsWith("/oauth2/token")) {
      return jsonResponse(200, { access_token: "refreshed-access-token", token_type: "bearer", expires_in: 7200 });
    }
    const tweetAttempts = calls.filter((call) => String(call.url).endsWith("/tweets")).length;
    if (tweetAttempts === 1) return jsonResponse(401, { detail: "Unauthorized" });
    return jsonResponse(201, { data: { id: "999", text: "hello" } });
  };
  try {
    const tweet = await postTweet("hello");
    assert.equal(tweet.id, "999");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].authorization, "Bearer test-static-token");
    assert.equal(calls[1].authorization, refreshBasic);
    assert.equal(String(calls[1].body), "grant_type=refresh_token&refresh_token=test-refresh-token");
    assert.equal(calls[2].authorization, "Bearer refreshed-access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed refresh falls through to OAuth 1.0a", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      authorization: options.headers.authorization,
    });
    if (String(url).endsWith("/oauth2/token")) {
      return jsonResponse(401, { error: "invalid_grant" });
    }
    const tweetAttempts = calls.filter((call) => String(call.url).endsWith("/tweets")).length;
    if (tweetAttempts === 1) return jsonResponse(401, { detail: "Unauthorized" });
    return jsonResponse(201, { data: { id: "777", text: "hello" } });
  };
  try {
    const tweet = await postTweet("hello");
    assert.equal(tweet.id, "777");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].authorization, "Bearer refreshed-access-token");
    assert.equal(calls[1].authorization, refreshBasic);
    assert.match(calls[2].authorization, /^OAuth /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
