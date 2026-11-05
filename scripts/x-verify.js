#!/usr/bin/env node
/**
 * Live read-only check that the configured X credentials can authenticate.
 * Nothing is posted; only GET /users/me is called.
 *
 *   npm run verify:x
 */
import { oauth1Configured, oauth2UserConfigured, verifyXCredentials } from "../src/services/x.js";
import { xDiagnostics } from "../src/services/social.js";

const diagnostics = xDiagnostics();
console.log("X configuration:");
console.log(`  mode: ${diagnostics.mode}`);
console.log(`  oauth1 complete: ${diagnostics.oauth1Complete}`);
if (diagnostics.missing.length) {
  console.log(`  missing slots: ${diagnostics.missing.join(", ")}`);
}

if (!oauth1Configured() && !oauth2UserConfigured()) {
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
        "X answered 401 'Invalid or expired token': regenerate the Access Token and Secret in the developer portal (Keys and tokens) after enabling OAuth 1.0a under User authentication settings, then update the env vars and redeploy."
      );
    }
    process.exitCode = 1;
  }
}
