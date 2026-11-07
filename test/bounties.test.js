import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";

const { bountyScore, fetchGithubBounties, rewardHint } = await import("../src/services/bounties.js");

const jsonResponse = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

test("reward hints are extracted from bracket, dollar and token forms", () => {
  assert.equal(rewardHint("[25 MRG] Vietnamese UI strings toggle"), "25 MRG");
  assert.equal(rewardHint("pays $150 for the fix"), "$150");
  assert.equal(rewardHint("reward of 300 USDC on base"), "300 USDC");
  assert.equal(rewardHint("no reward mentioned here"), null);
});

test("bounty scoring maps work onto the agent catalogue", () => {
  assert.ok(
    bountyScore({ title: "Build a python API scraper for defi data" }) >= 3,
    "catalogue-relevant work scores"
  );
  assert.equal(bountyScore({ title: "translate UI strings" }), 0, "unrelated work stays out");
});

test("the GitHub bounty feed is queried, normalized and filtered", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /api\.github\.com\/search\/issues/);
    assert.match(new URL(String(url)).searchParams.get("q"), /label:bounty/);
    assert.equal(options.headers.accept, "application/vnd.github+json");
    return jsonResponse(200, {
      total_count: 4962,
      items: [
        {
          repository_url: "https://api.github.com/repos/mergeos-bounties/BeeAR",
          title: "[25 MRG] Vietnamese UI strings toggle",
          html_url: "https://github.com/mergeos-bounties/BeeAR/issues/8",
          updated_at: "2026-11-07T00:00:00Z",
          labels: [{ name: "bounty" }],
          body: "translate strings",
        },
        {
          repository_url: "https://api.github.com/repos/acme/agent-dash",
          title: "Build a python scraper for defi data",
          html_url: "https://github.com/acme/agent-dash/issues/3",
          updated_at: "2026-11-06T00:00:00Z",
          labels: [],
          body: "pays 300 USDC on base",
        },
      ],
    });
  };
  try {
    const result = await fetchGithubBounties({ query: "label:bounty is:issue is:open", limit: 6 });
    assert.equal(result.total, 4962);
    assert.ok(result.opportunities.some((entry) => entry.reward === "25 MRG"));
    assert.ok(result.opportunities.some((entry) => entry.reward === "300 USDC"));
    assert.ok(result.opportunities.every((entry) => entry.repo && entry.url));
    assert.ok(result.opportunities[0].reward, "rewarded work sorts first");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
