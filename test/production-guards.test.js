import assert from "node:assert/strict";
import test from "node:test";

// The local .env already carries NODE_ENV=production, so each case sets the
// variables it cares about before config.js is evaluated and imports the
// module under a distinct specifier to bypass the ESM cache.
const loadConfig = async (env, query) => {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return (await import(`../src/config.js?${query}`)).config;
  } finally {
    for (const key of Object.keys(env)) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
};

test("ALLOW_UNPAID_EXECUTION cannot unlock unfunded execution in production", async () => {
  const production = await loadConfig(
    { ALLOW_UNPAID_EXECUTION: "true", NODE_ENV: "production", VERCEL: null },
    "case=production"
  );
  assert.equal(production.execution.allowUnpaidExecution, false);

  const vercel = await loadConfig(
    { ALLOW_UNPAID_EXECUTION: "true", NODE_ENV: "development", VERCEL: "1" },
    "case=vercel"
  );
  assert.equal(vercel.execution.allowUnpaidExecution, false);
});

test("the unpaid-execution escape hatch still exists for local development", async () => {
  const development = await loadConfig(
    { ALLOW_UNPAID_EXECUTION: "true", NODE_ENV: "development", VERCEL: null },
    "case=development"
  );
  assert.equal(development.execution.allowUnpaidExecution, true);

  const unset = await loadConfig(
    { ALLOW_UNPAID_EXECUTION: null, NODE_ENV: "development", VERCEL: null },
    "case=unset"
  );
  assert.equal(unset.execution.allowUnpaidExecution, false);
});

test("directory defaults sweep the network instead of one page of it", async () => {
  const config = await loadConfig(
    {
      NODE_ENV: "development",
      VERCEL: null,
      OUTREACH_DIRECTORY_LIMIT: null,
      OUTREACH_DIRECTORY_PAGES: null,
      OUTREACH_DIRECTORY_MAX_PAGES: null,
      OUTREACH_MAX_CANDIDATES: null,
      OUTREACH_CARD_PROBES: null,
    },
    "case=directory-defaults"
  );

  assert.equal(config.outreach.directoryLimit, 100);
  assert.equal(config.outreach.directoryPages, 4);
  assert.equal(config.outreach.directoryMaxPages, 900);
  assert.equal(config.outreach.cardProbes, 32);
  // one cycle reads 400 directory agents and the fallback bound alone covers
  // the whole live directory (44k agents over 442 pages of 100)
  assert.equal(config.outreach.directoryLimit * config.outreach.directoryPages, 400);
  assert.ok(config.outreach.directoryLimit * config.outreach.directoryMaxPages >= 44110);
  // one cycle stays bounded so the sweep cannot overrun the function budget
  assert.ok(config.outreach.maxCandidates <= config.outreach.directoryLimit * config.outreach.directoryMaxPages);
  assert.ok(config.outreach.cardProbes <= config.outreach.maxCandidates);
});

test("every sweep knob is clamped to a deployable range", async () => {
  const config = await loadConfig(
    {
      NODE_ENV: "development",
      VERCEL: null,
      OUTREACH_DIRECTORY_LIMIT: "100000",
      OUTREACH_DIRECTORY_PAGES: "1000",
      OUTREACH_DIRECTORY_MAX_PAGES: "100000",
      OUTREACH_MAX_CANDIDATES: "100000",
      OUTREACH_CARD_PROBES: "100000",
    },
    "case=directory-clamps"
  );

  assert.equal(config.outreach.directoryLimit, 100);
  assert.equal(config.outreach.directoryPages, 4);
  assert.equal(config.outreach.directoryMaxPages, 2000);
  assert.equal(config.outreach.maxCandidates, 200);
  assert.equal(config.outreach.cardProbes, 40);
});
