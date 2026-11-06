import assert from "node:assert/strict";
import test from "node:test";

// Neutralize every OAuth 2.0 user-token slot so the refresh trio is the only
// OAuth 2.0 path (a real local .env must not shadow the test).
process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.X_CONSUMER_KEY = "test-consumer-key";
process.env.X_CONSUMER_SECRET = "test-consumer-secret";
process.env.X_ACCESS_TOKEN = "test-access-token";
process.env.X_ACCESS_SECRET = "test-access-secret";
process.env.X_USER_ACCESS_TOKEN = "";
process.env.X_BEARER_TOKEN = "";
process.env.TWITTER_USER_ACCESS_TOKEN = "";
process.env.TWITTER_OAUTH2_USER_TOKEN = "";
process.env.X_CLIENT_ID = "test-client-id";
process.env.X_CLIENT_SECRET = "test-client-secret";
process.env.X_REFRESH_TOKEN = "test-refresh-token";

const { oauth2RefreshConfigured, oauth2UserConfigured, postTweet, xConfigured } = await import("../src/services/x.js");
const { xDiagnostics } = await import("../src/services/social.js");

const jsonResponse = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

test("the refresh trio alone fully configures X posting", () => {
  assert.equal(oauth2UserConfigured(), false);
  assert.equal(oauth2RefreshConfigured(), true);
  assert.equal(xConfigured(), true);

  const diagnostics = xDiagnostics();
  assert.equal(diagnostics.mode, "oauth2-user");
  assert.equal(diagnostics.oauth2Complete, true);
  assert.deepEqual(diagnostics.missing, []);
});

test("with no static user token the first attempt mints a token through the refresh flow", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.authorization });
    if (String(url).endsWith("/oauth2/token")) {
      return jsonResponse(200, { access_token: "minted-access-token", token_type: "bearer", expires_in: 7200 });
    }
    return jsonResponse(201, { data: { id: "555", text: "hello" } });
  };
  try {
    const tweet = await postTweet("hello");
    assert.equal(tweet.id, "555");
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].authorization,
      `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`
    );
    assert.equal(calls[1].authorization, "Bearer minted-access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
