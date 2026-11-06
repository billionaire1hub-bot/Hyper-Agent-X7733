#!/usr/bin/env node
/**
 * Live read-only check that the configured X credentials can authenticate.
 * Nothing is posted; only GET /users/me is called.
 *
 *   npm run verify:x
 */
import { oauth2RefreshConfigured, verifyXCredentials, xConfigured } from "../src/services/x.js";
import { xDiagnostics } from "../src/services/social.js";

const diagnostics = xDiagnostics();
console.log("X configuration:");
console.log(`  mode: ${diagnostics.mode}`);
console.log(`  oauth1 complete: ${diagnostics.oauth1Complete}`);
console.log(`  oauth2 complete: ${diagnostics.oauth2Complete}${oauth2RefreshConfigured() ? " (refresh flow)" : ""}`);
if (diagnostics.missing.length) {
  console.log(`  missing slots: ${diagnostics.missing.join(", ")}`);
}

if (!xConfigured()) {
  console.log("FAIL: no X credential family is fully configured.");
  process.exitCode = 1;
} else {
  try {
    const account = await verifyXCredentials();
    console.log(`PASS: authenticated as @${account.username} (${account.name})`);
    process.exitCode = 0;
  } catch (error) {
    console.log(`FAIL: ${error.code} — ${error.message}`);
    if (error.details?.status === 401) {
      console.log(
        "X answered 401: the OAuth 2.0 token is missing the tweet.write scope, expired, or the app has no user-context permissions. In the developer portal check App Type = Web App, Automated App or Bot (Confidential Client), grant Read and Write app permissions, and re-issue the OAuth 2.0 user token (or Client ID/Secret + Refresh Token). OAuth 1.0a fallbacks are rejected by X (code 89) and are not a fix."
      );
    }
    process.exitCode = 1;
  }
}
