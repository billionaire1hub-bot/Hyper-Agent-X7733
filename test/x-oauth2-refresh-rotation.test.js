import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.X_USER_ACCESS_TOKEN = "";
process.env.X_BEARER_TOKEN = "";
process.env.X_CLIENT_ID = "test-client-id";
process.env.X_CLIENT_SECRET = "test-client-secret";
process.env.X_REFRESH_TOKEN = "test-refresh-token";

const { postTweet } = await import("../src/services/x.js");
const { store, storeHelpers } = await import("../src/lib/store.js");

const jsonResponse = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

test("the rotated refresh token replaces the previous one for later mints", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      authorization: options.headers.authorization,
      body: options.body,
    });
    if (String(url).endsWith("/oauth2/token")) {
      const refreshBody = String(options.body);
      if (refreshBody.includes("refresh_token=test-refresh-token")) {
        return jsonResponse(200, {
          access_token: "first-access",
          refresh_token: "rotated-refresh-1",
          expires_in: 0,
        });
      }
      if (refreshBody.includes("refresh_token=rotated-refresh-1")) {
        return jsonResponse(200, {
          access_token: "second-access",
          refresh_token: "rotated-refresh-2",
          expires_in: 7200,
        });
      }
      return jsonResponse(401, { error: "invalid_grant" });
    }
    if (options.headers.authorization === "Bearer second-access") {
      return jsonResponse(201, { data: { id: "555", text: "hello" } });
    }
    return jsonResponse(401, { detail: "Unauthorized" });
  };
  try {
    // First post: 401 -> refresh with the env token. expires_in 0 makes the
    // minted access token instantly stale, so the retry fails.
    await assert.rejects(
      () => postTweet("hello"),
      (error) => error.code === "X_HTTP_401"
    );
    // Second post: the env token is dead, but the persisted rotated token
    // must be used, and the fresh mint succeeds.
    const tweet = await postTweet("hello");
    assert.equal(tweet.id, "555");
    const refreshBodies = calls
      .filter((call) => call.url.endsWith("/oauth2/token"))
      .map((call) => String(call.body));
    assert.deepEqual(refreshBodies, [
      "grant_type=refresh_token&refresh_token=test-refresh-token",
      "grant_type=refresh_token&refresh_token=rotated-refresh-1",
    ]);
    const entry = await store.get(storeHelpers.xOauth2Token());
    assert.equal(entry.token, "second-access");
    assert.equal(entry.refreshToken, "rotated-refresh-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
