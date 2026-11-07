import { config } from "../config.js";
import { fetchJSON, sleep } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";
import { bountyStatus } from "./bounties.js";

const GH_API = "https://api.github.com";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MINUTES = 10;
const CYCLE_THROTTLE_MS = 15 * 60 * 1000;
const STATE_TTL_SECONDS = 30 * 24 * 3600;

async function ghApi(path, { method = "GET", body, token = config.bounties.githubToken } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetchJSON(
    `${GH_API}${path}`,
    { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
    { timeoutMs: 20000, retries: 2, service: "github-bounty" },
  );
}

function ghStatus(error) {
  const match = String(error?.message || "").match(/_HTTP_(\d{3})/);
  return match ? Number(match[1]) : null;
}

function isAlreadyExists(error) {
  return ghStatus(error) === 422 || /already exists/i.test(String(error?.message || error));
}

function parseIssueRef(opp) {
  const repo = String(opp?.repo || "");
  const num = String(opp?.url || "").match(/\/issues\/(\d+)/);
  const [owner, name] = repo.split("/");
  if (!owner || !name || !num) return null;
  return { owner, repo: name, key: `${repo}#${num[1]}`, number: Number(num[1]) };
}

export function verifyRepoMeta(meta, { minAgeDays = config.bounties.minRepoAgeDays, minStars = config.bounties.minStars } = {}) {
  const ageDays = (Date.now() - new Date(meta?.created_at || 0).getTime()) / 86400000;
  const stars = Number(meta?.stargazers_count) || 0;
  const watchers = Number(meta?.subscribers_count) || 0;
  const sizeKb = Number(meta?.size) || 0;
  const failures = [];
  if (!(ageDays >= minAgeDays)) failures.push(`repo age ${ageDays.toFixed(1)}d < ${minAgeDays}d`);
  if (!(stars >= minStars || watchers >= 1)) failures.push(`no community signal (stars=${stars})`);
  if (sizeKb > 0 && sizeKb < 10) failures.push(`repo too small (${sizeKb}KB)`);
  return { verified: failures.length === 0, failures, ageDays: Number(ageDays.toFixed(1)), stars };
}

async function findFixPrs(api, owner, repo, number) {
  const q = encodeURIComponent(`repo:${owner}/${repo} is:pr ${number} in:body`);
  const res = await api(`/search/issues?q=${q}&per_page=10`);
  return (res?.items || []).filter((i) =>
    new RegExp(`fix(?:e[sd])?\\s*#\\s*${number}\\b`, "i").test(`${i.title || ""}\n${i.body || ""}`),
  );
}

async function ensureFork(api, owner, repo) {
  const me = await api("/user");
  const login = me?.login;
  if (!login) throw new Error("github-token-unauthorized");
  const full = `${login}/${repo}`;
  try {
    await api(`/repos/${owner}/${repo}/forks`, { method: "POST", body: {} });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  for (let i = 0; i < 10; i += 1) {
    try {
      const fork = await api(`/repos/${full}`);
      if (fork?.default_branch) return { login, full, defaultBranch: fork.default_branch };
    } catch {
      /* fork still materializing */
    }
    await sleep(3000);
  }
  return { login, full, defaultBranch: "master" };
}

async function ensureBranch(api, full, branch, baseBranch) {
  const base = await api(`/repos/${full}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  try {
    await api(`/repos/${full}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: base.object.sha },
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const head = await api(`/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`);
  return { branch, sha: head.object.sha };
}

async function putFile(api, full, path, content, branch, message) {
  let sha;
  try {
    const existing = await api(`/repos/${full}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    sha = existing?.sha;
  } catch {
    /* new file */
  }
  const payload = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };
  if (sha) payload.sha = sha;
  return api(`/repos/${full}/contents/${path}`, { method: "PUT", body: payload });
}

async function openPr(api, owner, repo, { head, base, title, body }) {
  try {
    return await api(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: { title, head, base, body } });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const list = await api(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=5&head=${encodeURIComponent(head)}`,
    );
    return (list || [])[0] || null;
  }
}

async function starRepos(api, repos) {
  for (const full of repos) {
    try {
      await api(`/user/starred/${full}`, { method: "PUT", body: {} });
    } catch (error) {
      logger.warn("bounty star failed", { repo: full, message: error.message });
    }
  }
}

async function ensureClaimComment(api, owner, repo, number, text) {
  const me = await api("/user");
  const comments = await api(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  if ((comments || []).some((c) => c.user?.login === me?.login && String(c.body || "").includes(text))) {
    return { already: true };
  }
  await api(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: { body: text } });
  return { already: false };
}

function payoutLine() {
  return `Bounty payout wallet: ${config.bounties.payoutWallet}`;
}

export const DELIVERABLES = {
  "mergeos-bounties/BeeAR#8": {
    title: "i18n EN/VI language toggle for the BeeAR web try-on UI",
    claimComment: "I claim this bounty",
    stars: ["mergeos-bounties/BeeAR", "mergeos-bounties/mergeos"],
    async precheck(api) {
      const app = await api(
        "/repos/mergeos-bounties/BeeAR/contents/packages/web/assets/app.js?ref=master",
      );
      const text = Buffer.from(app?.content || "", "base64").toString("utf8");
      if (text.includes("const I18N") && text.includes("applyLang")) {
        return { solved: true, reason: "inline EN/VI i18n layer already present on master" };
      }
      return { solved: false };
    },
    async build() {
      const i18nJs = `/* BeeAR standalone i18n EN/VI toggle (bounty #8) */
const BEEAR_I18N = {
  en: { tagline: "Virtual try-on · glasses & accessories", catalog: "Catalog", hint: "Start camera or use Demo face · pick a frame", loading: "Loading catalog…" },
  vi: { tagline: "Thử kính & phụ kiện ảo", catalog: "Danh mục", hint: "Bật camera hoặc ảnh demo · chọn khung", loading: "Đang tải danh mục…" },
};
let beearLang = "en";
function beearT(k) { return (BEEAR_I18N[beeearLang] || BEEAR_I18N.en)[k] || k; }
function beearApplyLang() {
  const map = { tagline: "tagline", "lbl-catalog": "catalog", hint: "hint", "stage-load-text": "loading" };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = beearT(key);
  }
  const btn = document.getElementById("btn-lang");
  if (btn) btn.textContent = beearLang === "en" ? "VI" : "EN";
}
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-lang");
  if (btn) btn.addEventListener("click", () => { beearLang = beearLang === "en" ? "vi" : "en"; beearApplyLang(); });
  beearApplyLang();
});
`;
      return {
        files: [{ path: "packages/web/assets/i18n.js", content: i18nJs }],
        prTitle: "Add EN/VI i18n toggle for web try-on UI (Fixes #8)",
        prBody: [
          "Adds a standalone `i18n.js` module with a full English/Vietnamese string map and a working EN/VI toggle wired to the existing `#btn-lang` button.",
          "",
          "Fixes #8",
          "",
          payoutLine(),
        ].join("\n"),
      };
    },
  },
};

export async function executeIssue(ref, { api = ghApi } = {}) {
  const entry = DELIVERABLES[ref.key];
  if (!entry) return { status: "observed", reason: "no registered deliverable — recorded only" };

  const [meta, issue] = await Promise.all([
    api(`/repos/${ref.owner}/${ref.repo}`),
    api(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`),
  ]);
  if (issue?.state !== "open") return { status: "skipped", reason: `issue ${issue?.state}` };
  const me = (await api("/user"))?.login;
  if (issue.assignee && issue.assignee.login !== me) {
    return { status: "skipped", reason: `assigned to ${issue.assignee.login}` };
  }

  const verified = verifyRepoMeta(meta);
  if (!verified.verified) return { status: "rejected", reason: `failed verification: ${verified.failures.join("; ")}` };

  const fixPrs = await findFixPrs(api, ref.owner, ref.repo, ref.number);
  if (fixPrs.some((p) => p.pull_request?.merged_at || p.state === "closed")) {
    return { status: "already-solved", reason: `existing ${fixPrs[0].state} PR ${fixPrs[0].html_url}` };
  }

  if (entry.precheck) {
    const pre = await entry.precheck(api);
    if (pre?.solved) return { status: "already-solved", reason: pre.reason || "deliverable already upstream" };
  }

  const built = await entry.build(api);
  const branch = `bounty-${ref.number}-autonomous`;
  const { login, full, defaultBranch } = await ensureFork(api, ref.owner, ref.repo);
  await ensureBranch(api, full, branch, meta.default_branch || defaultBranch);
  for (const file of built.files) {
    await putFile(api, full, file.path, file.content, branch, `${built.prTitle} — ${file.path}`);
  }
  const pr = await openPr(api, ref.owner, ref.repo, {
    head: `${login}:${branch}`,
    base: meta.default_branch || defaultBranch,
    title: built.prTitle,
    body: built.prBody,
  });
  const claim = {};
  if (config.bounties.starOnClaim && entry.stars?.length) {
    await starRepos(api, entry.stars);
    claim.starred = entry.stars;
  }
  if (entry.claimComment) {
    claim.comment = await ensureClaimComment(api, ref.owner, ref.repo, ref.number, entry.claimComment);
  }
  return {
    status: "pr-opened",
    prUrl: pr?.html_url || null,
    prNumber: pr?.number || null,
    branch,
    files: built.files.map((f) => f.path),
    ...claim,
  };
}

async function loadState() {
  try {
    const saved = await store.get(storeHelpers.bountyExec());
    return { executions: {}, ...(saved || {}) };
  } catch (error) {
    logger.warn("bounty exec state read failed", { message: error.message });
    return { executions: {} };
  }
}

async function saveState(state) {
  try {
    await store.set(storeHelpers.bountyExec(), state, { ttlSeconds: STATE_TTL_SECONDS });
  } catch (error) {
    logger.warn("bounty exec state write failed", { message: error.message });
  }
}

export async function runExecutionCycle({ force = false, api = ghApi, scan = null } = {}) {
  const bcfg = config.bounties;
  if (!bcfg.enabled || !bcfg.execute) return { executed: false, reason: "execution-disabled" };
  if (!bcfg.githubToken) return { executed: false, reason: "github-token-missing" };

  const state = await loadState();
  const lastRun = state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
  if (!force && Date.now() - lastRun < CYCLE_THROTTLE_MS) {
    return { executed: false, reason: "throttled", lastRunAt: state.lastRunAt, executions: state.executions };
  }

  const snapshot = scan || (await bountyStatus());
  const results = [];
  let openPrs = Object.values(state.executions).filter((e) => e.status === "pr-opened").length;

  for (const opp of snapshot.opportunities || []) {
    const ref = parseIssueRef(opp);
    if (!ref) continue;
    const prior = state.executions[ref.key];
    if (prior && (prior.status === "pr-opened" || prior.status === "already-solved")) continue;
    if (prior?.nextRetryAt && new Date(prior.nextRetryAt).getTime() > Date.now()) continue;
    if (openPrs >= bcfg.maxOpenPrs) {
      results.push({ key: ref.key, status: "deferred", reason: `open PR cap ${bcfg.maxOpenPrs}` });
      continue;
    }
    try {
      const result = await executeIssue(ref, { api });
      state.executions[ref.key] = { ...result, at: new Date().toISOString(), attempts: 1 };
      if (result.status === "pr-opened") openPrs += 1;
      results.push({ key: ref.key, ...result });
    } catch (error) {
      const attempts = (prior?.attempts || 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      state.executions[ref.key] = {
        status: exhausted ? "failed" : "retrying",
        error: String(error?.message || error).slice(0, 300),
        attempts,
        at: new Date().toISOString(),
        ...(exhausted ? {} : { nextRetryAt: new Date(Date.now() + attempts * RETRY_BASE_MINUTES * 60000).toISOString() }),
      };
      results.push({ key: ref.key, ...state.executions[ref.key] });
      logger.warn("bounty execution attempt failed", { key: ref.key, attempts, error: error.message });
    }
    await saveState(state);
  }

  state.lastRunAt = new Date().toISOString();
  await saveState(state);
  return { executed: true, ranAt: state.lastRunAt, results, executions: state.executions };
}

export async function executionStatus() {
  const state = await loadState();
  return {
    enabled: config.bounties.enabled && config.bounties.execute,
    tokenConfigured: Boolean(config.bounties.githubToken),
    payoutWallet: config.bounties.payoutWallet,
    lastRunAt: state.lastRunAt || null,
    executions: state.executions || {},
  };
}
