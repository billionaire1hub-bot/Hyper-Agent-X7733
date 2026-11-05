import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.API_KEY = "operator-api-key";
process.env.CRON_SECRET = "scheduled-runner-secret";

const { config } = await import("../src/config.js");
const auth = await import("../src/middleware/auth.js");

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

/** Runs a middleware against a fake request; only the shape routes rely on. */
const call = (middleware, { headers = {}, query = {}, body = {} } = {}) => {
  const { state, res } = outcome();
  const req = {
    id: "req-auth",
    query,
    body,
    get: (name) => headers[String(name).toLowerCase()] || "",
  };
  middleware(req, res, () => {
    state.passed = true;
  });
  return state;
};

const withPasscode = (passcode, run) => {
  const previous = config.boss.passcode;
  config.boss.passcode = passcode;
  try {
    return run();
  } finally {
    config.boss.passcode = previous;
  }
};

test("the API key route ignores a query-string credential", () => {
  const state = call(auth.requireApiKey, { query: { secret: "operator-api-key" } });
  assert.equal(state.passed, false);
  assert.equal(state.status, 401);
});

test("the API key route still admits the x-api-key header", () => {
  assert.equal(call(auth.requireApiKey, { headers: { "x-api-key": "operator-api-key" } }).passed, true);
});

test("a cron route fires from a browser bar with ?secret=", () => {
  const state = call(auth.requireCronSecret, { query: { secret: "scheduled-runner-secret" } });
  assert.equal(state.passed, true);
});

test("a cron route rejects the operator API key in ?secret=", () => {
  const state = call(auth.requireCronSecret, { query: { secret: "operator-api-key" } });
  assert.equal(state.passed, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.error.code, "UNAUTHORIZED");
});

test("a repeated ?secret= parameter is not treated as a credential", () => {
  const { state, res } = outcome();
  auth.requireCronSecret(
    {
      id: "req-array",
      query: { secret: ["scheduled-runner-secret", "scheduled-runner-secret"] },
      get: () => "",
    },
    res,
    () => {
      state.passed = true;
    }
  );
  assert.equal(state.passed, false);
  assert.equal(state.status, 401);
});

test("outreach accepts either shared secret or the boss passcode", () => {
  assert.equal(
    call(auth.requireApiKeyOrCronSecret, { headers: { "x-api-key": "operator-api-key" } }).passed,
    true
  );
  assert.equal(
    call(auth.requireApiKeyOrCronSecret, { query: { secret: "scheduled-runner-secret" } }).passed,
    true
  );
  assert.equal(
    withPasscode("03210388", () =>
      call(auth.requireApiKeyOrCronSecret, { query: { passcode: "03210388" } })
    ).passed,
    true
  );
  assert.equal(
    withPasscode("03210388", () =>
      call(auth.requireApiKeyOrCronSecret, { query: { passcode: "00000000" } })
    ).passed,
    false
  );
  const state = call(auth.requireApiKeyOrCronSecret, { headers: { "x-api-key": "nope" } });
  assert.equal(state.status, 401);
  assert.equal(state.body.error.message.includes("?passcode="), true);
});

test("the configured boss passcode in the message authorises the chat route", () => {
  const state = withPasscode("03210388", () =>
    call(auth.requireApiKeyOrBossPasscode, { body: { message: "03210388 start outbound agent discovery" } })
  );
  assert.equal(state.passed, true);
});

test("a too-short passcode in the message is refused as too weak", () => {
  const state = withPasscode("1234567", () =>
    call(auth.requireApiKeyOrBossPasscode, { body: { message: "1234567 start outbound agent discovery" } })
  );
  assert.equal(state.passed, false);
  assert.equal(state.status, 403);
  assert.equal(state.body.error.code, "BOSS_PASSCODE_TOO_WEAK");
  assert.equal(state.body.error.message.includes("BOSS_PASSCODE"), true);
});

test("a rotated passcode in the message authorises the chat route", () => {
  const state = withPasscode("7k-pantser-quartz", () =>
    call(auth.requireApiKeyOrBossPasscode, { body: { message: "7k-pantser-quartz start outbound agent discovery" } })
  );
  assert.equal(state.passed, true);
});

test("a wrong passcode in the message is still an unauthorised chat request", () => {
  const state = withPasscode("7k-pantser-quartz", () =>
    call(auth.requireApiKeyOrBossPasscode, { body: { message: "03210388 start outbound agent discovery" } })
  );
  assert.equal(state.passed, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.error.message.includes("BOSS_PASSCODE"), true);
});

test("the chat route admits the API key header without a passcode", () => {
  const state = call(auth.requireApiKeyOrBossPasscode, {
    headers: { authorization: "Bearer operator-api-key" },
    body: { message: "market movers" },
  });
  assert.equal(state.passed, true);
});

test("the chat passcode bypass is inert when no API key is configured", () => {
  const previous = config.apiKey;
  config.apiKey = "";
  try {
    assert.equal(call(auth.requireApiKeyOrBossPasscode, { body: { message: "hello" } }).passed, true);
  } finally {
    config.apiKey = previous;
  }
});
