import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.CRON_SECRET = "scheduled-runner-secret";

const { config } = await import("../src/config.js");
const { requireCronSecret } = await import("../src/middleware/auth.js");

const outcome = () => {
  const state = { status: null, body: null, passed: false };
  return {
    state,
    res: {
      status(code) {
        state.status = code;
        return this;
      },
      json(payload) {
        state.body = payload;
        return this;
      },
    },
  };
};

const call = (headers = {}, query = {}) => {
  const { state, res } = outcome();
  const req = {
    id: "req-1",
    query,
    get: (name) => headers[String(name).toLowerCase()] || "",
  };
  requireCronSecret(req, res, () => {
    state.passed = true;
  });
  return state;
};

test("cron middleware admits the bearer secret Vercel sends", () => {
  config.cronSecret = "scheduled-runner-secret";
  assert.equal(call({ authorization: "Bearer scheduled-runner-secret" }).passed, true);
});

test("cron middleware admits the x-cron-secret header", () => {
  config.cronSecret = "scheduled-runner-secret";
  assert.equal(call({ "x-cron-secret": "scheduled-runner-secret" }).passed, true);
});

test("the retired literal cron secret is rejected", () => {
  config.cronSecret = "scheduled-runner-secret";
  const state = call({ authorization: "Bearer 03210322" });
  assert.equal(state.passed, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.error.code, "UNAUTHORIZED");
});

test("a query-string secret is no longer accepted", () => {
  config.cronSecret = "scheduled-runner-secret";
  const state = call({}, { secret: "scheduled-runner-secret" });
  assert.equal(state.passed, false);
  assert.equal(state.status, 401);
});

test("cron routes fail closed when CRON_SECRET is unset", () => {
  config.cronSecret = "";
  const state = call({ authorization: "Bearer 03210322" });
  assert.equal(state.passed, false);
  assert.equal(state.status, 503);
  assert.equal(state.body.error.code, "CRON_NOT_CONFIGURED");
  config.cronSecret = "scheduled-runner-secret";
});

const activation = await import("../src/services/activation.js");

const withFetch = async (handler, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

test("activation wake-up refuses to self-call without a configured secret", async () => {
  config.cronSecret = "";
  let calls = 0;
  const result = await withFetch(
    async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    () => activation.wakeOutreachCycle("https://agent.example.com", { reason: "activation" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.skipped, "cron_secret_missing");
  assert.equal(calls, 0);

  const traffic = await withFetch(
    async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    () => activation.maybeWakeOutreach({ reason: "traffic" })
  );
  assert.equal(traffic.ok, false);
  assert.equal(traffic.skipped, "cron_secret_missing");
  assert.equal(calls, 0);
  config.cronSecret = "scheduled-runner-secret";
});

test("activation wake-up sends the configured secret in a header", async () => {
  let captured;
  const result = await withFetch(
    async (url, options) => {
      captured = { url: String(url), headers: options.headers };
      return new Response('{"status":"ok"}', { status: 200 });
    },
    () => activation.wakeOutreachCycle("https://agent.example.com/", { reason: "manual" })
  );
  assert.equal(result.ok, true);
  assert.equal(captured.headers["x-cron-secret"], "scheduled-runner-secret");
  assert.ok(captured.url.includes("/api/cron/outreach?reason=manual&force=1"));
  assert.ok(!captured.url.includes("secret="));
});
