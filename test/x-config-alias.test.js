import assert from "node:assert/strict";
import test from "node:test";

process.env.X_API_KEY = "vercel-api-key";
process.env.X_API_SECRET = "vercel-api-secret";
process.env.X_BEARER_TOKEN = "vercel-bearer-token";
process.env.X_ACCESS_TOKEN = "vercel-access-token";
process.env.X_ACCESS_SECRET = "vercel-access-secret";

const { config } = await import("../src/config.js");
const { oauth1Configured, oauth2UserConfigured, xConfigured } = await import("../src/services/x.js");
const { xDiagnostics } = await import("../src/services/social.js");

test("the X_API_KEY/X_BEARER_TOKEN fallback names alone fully configure X posting", () => {
  assert.equal(config.social.oauth1.consumerKey, "vercel-api-key");
  assert.equal(config.social.oauth1.consumerSecret, "vercel-api-secret");
  assert.equal(config.social.oauth1.accessToken, "vercel-access-token");
  assert.equal(config.social.oauth1.accessSecret, "vercel-access-secret");
  assert.equal(config.social.oauth2UserToken, "vercel-bearer-token");
  assert.equal(config.intelligence.twitterBearerToken, "vercel-bearer-token");
  assert.equal(oauth1Configured(), true);
  assert.equal(oauth2UserConfigured(), true);
  assert.equal(xConfigured(), true);
});

test("diagnostics report every slot filled and expose no credential values", () => {
  const diagnostics = xDiagnostics();
  assert.equal(diagnostics.mode, "oauth1");
  assert.equal(diagnostics.oauth1Complete, true);
  assert.deepEqual(diagnostics.missing, []);
  assert.equal(JSON.stringify(diagnostics).includes("vercel-api-key"), false);
  assert.equal(JSON.stringify(diagnostics).includes("vercel-bearer-token"), false);
});
