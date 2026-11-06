import assert from "node:assert/strict";
import test from "node:test";

process.env.X_CONSUMER_KEY = "canonical-consumer-key";
process.env.X_CONSUMER_SECRET = "canonical-consumer-secret";
process.env.X_API_KEY = "fallback-api-key";
process.env.X_API_SECRET = "fallback-api-secret";
process.env.X_ACCESS_TOKEN = "vercel-access-token";
process.env.X_ACCESS_SECRET = "vercel-access-secret";
process.env.X_USER_ACCESS_TOKEN = "";
process.env.X_BEARER_TOKEN = "vercel-bearer-token";
process.env.X_CLIENT_ID = "";
process.env.X_CLIENT_SECRET = "";
process.env.X_REFRESH_TOKEN = "";

const { config } = await import("../src/config.js");
const { oauth1Configured, oauth2UserConfigured, xConfigured } = await import("../src/services/x.js");
const { xDiagnostics } = await import("../src/services/social.js");

test("the Vercel dashboard names configure X posting and take priority over fallbacks", () => {
  assert.equal(config.social.oauth1.consumerKey, "canonical-consumer-key");
  assert.equal(config.social.oauth1.consumerSecret, "canonical-consumer-secret");
  assert.equal(config.social.oauth1.accessToken, "vercel-access-token");
  assert.equal(config.social.oauth1.accessSecret, "vercel-access-secret");
  assert.equal(config.social.oauth2UserToken, "vercel-bearer-token");
  assert.equal(oauth1Configured(), true);
  assert.equal(oauth2UserConfigured(), true);
  assert.equal(xConfigured(), true);
});

test("diagnostics report every slot filled under the canonical names", () => {
  const diagnostics = xDiagnostics();
  assert.equal(diagnostics.mode, "oauth2-user");
  assert.equal(diagnostics.oauth1Complete, true);
  assert.equal(diagnostics.oauth2Complete, true);
  assert.deepEqual(diagnostics.missing, []);
  assert.equal(diagnostics.slots[0].name, "X_USER_ACCESS_TOKEN (or X_BEARER_TOKEN / TWITTER_USER_ACCESS_TOKEN)");
});
