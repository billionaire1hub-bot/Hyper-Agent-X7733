import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.GITHUB_TOKEN = "ghp_test_token";

const { verifyRepoMeta, executeIssue, runExecutionCycle, DELIVERABLES } = await import(
  "../src/services/bounty-executor.js"
);

const oldRepoMeta = {
  created_at: new Date(Date.now() - 200 * 86400000).toISOString(),
  stargazers_count: 15,
  subscribers_count: 3,
  size: 58852,
  default_branch: "main",
};
const scamRepoMeta = {
  created_at: new Date(Date.now() - 3600000).toISOString(),
  stargazers_count: 0,
  subscribers_count: 0,
  size: 12,
  default_branch: "master",
};

const appJsBase64 = (text) => Buffer.from(text, "utf8").toString("base64");

function fakeApi(routes, { failPaths = [] } = {}) {
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || "GET", body: opts.body });
    if (failPaths.includes(path)) {
      const err = new Error(`GITHUB_BOUNTY_HTTP_500 simulated upstream failure for ${path}`);
      throw err;
    }
    const handler = routes[path] || routes[path.split("?")[0]];
    if (!handler) throw new Error(`unexpected api path ${opts.method || "GET"} ${path}`);
    return typeof handler === "function" ? handler(opts) : handler;
  };
  return { api, calls };
}

test("repo verification rejects same-day zero-star scam repos and accepts established ones", () => {
  assert.equal(verifyRepoMeta(scamRepoMeta).verified, false, "IES-BoilerRoom-shaped repos rejected");
  assert.equal(verifyRepoMeta(oldRepoMeta).verified, true, "BeeAR-shaped repos pass");
  assert.ok(verifyRepoMeta(scamRepoMeta).failures.length >= 2);
});

test("an already-solved bounty is detected upstream and no mutating calls are made", async () => {
  const { api, calls } = fakeApi({
    "/repos/mergeos-bounties/BeeAR": oldRepoMeta,
    "/repos/mergeos-bounties/BeeAR/issues/8": { state: "open", assignee: null, number: 8 },
    "/user": { login: "hyperagent7733" },
    "/search/issues?q=repo%3Amergeos-bounties%2FBeeAR%20is%3Apr%208%20in%3Abody&per_page=10": { items: [] },
    "/repos/mergeos-bounties/BeeAR/contents/packages/web/assets/app.js?ref=master": {
      content: appJsBase64("const I18N = { en: {}, vi: {} }; function applyLang() {}"),
    },
  });
  const result = await executeIssue({ owner: "mergeos-bounties", repo: "BeeAR", key: "mergeos-bounties/BeeAR#8", number: 8 }, { api });
  assert.equal(result.status, "already-solved");
  assert.ok(calls.every((c) => c.method === "GET"), "no forks, branches, comments or PRs created");
});

test("a verified unsolved bounty is forked, committed, claimed and PR'd with the payout wallet", async () => {
  DELIVERABLES["o/r#5"] = {
    title: "test deliverable",
    claimComment: "I claim this bounty",
    stars: ["o/r", "o/mergeos"],
    async build() {
      return {
        files: [{ path: "solution.txt", content: "complete solution" }],
        prTitle: "Deliver bounty (Fixes #5)",
        prBody: "Fixes #5\n\nBounty payout wallet: 0x3D8e69cA6B52dA775433D164B19E4104053E5d05",
      };
    },
  };
  const { api, calls } = fakeApi({
    "/repos/o/r": oldRepoMeta,
    "/repos/o/r/issues/5": { state: "open", assignee: null, number: 5 },
    "/user": { login: "hyperagent7733" },
    "/search/issues?q=repo%3Ao%2Fr%20is%3Apr%205%20in%3Abody&per_page=10": { items: [] },
    "/repos/o/r/forks": {},
    "/repos/hyperagent7733/r": { default_branch: "main" },
    "/repos/hyperagent7733/r/git/ref/heads/main": { object: { sha: "base123" } },
    "/repos/hyperagent7733/r/git/refs": {},
    "/repos/hyperagent7733/r/git/ref/heads/bounty-5-autonomous": { object: { sha: "base123" } },
    "/repos/hyperagent7733/r/contents/solution.txt": { content: {} },
    "/repos/o/r/pulls": { html_url: "https://github.com/o/r/pull/9", number: 9 },
    "/user/starred/o/r": {},
    "/user/starred/o/mergeos": {},
    "/repos/o/r/issues/5/comments?per_page=100": [],
    "/repos/o/r/issues/5/comments": {},
  });
  try {
    const result = await executeIssue({ owner: "o", repo: "r", key: "o/r#5", number: 5 }, { api });
    assert.equal(result.status, "pr-opened");
    assert.equal(result.prUrl, "https://github.com/o/r/pull/9");
    assert.deepEqual(result.files, ["solution.txt"]);
    assert.equal(result.comment.already, false);
    const prCall = calls.find((c) => c.path === "/repos/o/r/pulls" && c.method === "POST");
    assert.match(prCall.body.body, /Fixes #5/);
    assert.match(prCall.body.body, /0x3D8e69cA6B52dA775433D164B19E4104053E5d05/);
    const commentCall = calls.find((c) => c.path === "/repos/o/r/issues/5/comments" && c.method === "POST");
    assert.equal(commentCall.body.body, "I claim this bounty");
    assert.ok(calls.some((c) => c.path === "/user/starred/o/r" && c.method === "PUT"), "policy stars applied");
  } finally {
    delete DELIVERABLES["o/r#5"];
  }
});

test("the cycle records retries with backoff on transient failure and skips solved targets", async () => {
  const { api } = fakeApi(
    {
      "/repos/o/r": oldRepoMeta,
      "/repos/o/r/issues/5": { state: "open", assignee: null, number: 5 },
      "/user": { login: "hyperagent7733" },
      "/search/issues?q=repo%3Ao%2Fr%20is%3Apr%205%20in%3Abody&per_page=10": { items: [] },
    },
    { failPaths: ["/repos/o/r/forks"] },
  );
  DELIVERABLES["o/r#5"] = { title: "t", async build() { return { files: [], prTitle: "t", prBody: "Fixes #5" }; } };
  try {
    const scan = { opportunities: [{ repo: "o/r", url: "https://github.com/o/r/issues/5", title: "[100 USDC] task" }] };
    const result = await runExecutionCycle({ force: true, api, scan });
    assert.equal(result.executed, true);
    const exec = result.executions["o/r#5"];
    assert.equal(exec.status, "retrying");
    assert.equal(exec.attempts, 1);
    assert.ok(new Date(exec.nextRetryAt).getTime() > Date.now(), "backoff scheduled");
    const again = await runExecutionCycle({ force: true, api, scan });
    assert.equal(again.executions["o/r#5"].status, "retrying", "not retried before nextRetryAt");
  } finally {
    delete DELIVERABLES["o/r#5"];
  }
});
