#!/usr/bin/env node
/**
 * Pre-deployment build check. Resolves every relative import, rejects cycles,
 * imports every module (except the HTTP listener) and validates the Vercel
 * manifest before a deployment is allowed to proceed.
 */
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceRoots = ["src", "api"];
const listener = "src/server.js";
const failures = [];

const check = (name, ok, detail = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
};

const files = (await Promise.all(sourceRoots.map((dir) => walk(path.join(root, dir))))).flat();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

check(
  "package identity",
  pkg.name === "hyper-agent-x7733" && pkg.version === "1.6.0",
  `${pkg.name}@${pkg.version}`
);
check("ESM + Node >= 20", pkg.type === "module" && /^>=20/.test(pkg.engines?.node || ""), pkg.engines?.node || "missing");
check("start and build scripts", Boolean(pkg.scripts?.start && pkg.scripts?.build), Object.keys(pkg.scripts || {}).join(", "));
check("serverless entry point", pkg.main === "api/index.js", pkg.main || "missing");

for (const dependency of Object.keys(pkg.dependencies || {})) {
  check(`dependency installed: ${dependency}`, await exists(path.join(root, "node_modules", dependency, "package.json")));
}

const staticImport = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImport = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const bareImports = new Set();
const graph = new Map();
const importErrors = [];
const commonJs = [];
const sourceTexts = new Map();

for (const file of files) {
  const source = await readFile(file, "utf8");
  sourceTexts.set(file, source);
  if (/\brequire\s*\(/.test(source)) commonJs.push(rel(file));
  const dependencies = [];
  for (const pattern of [staticImport, dynamicImport]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.endsWith(".js")) {
          importErrors.push(`${rel(file)}: "${specifier}" must include the .js extension`);
        } else if (await exists(resolved)) {
          dependencies.push(resolved);
        } else {
          importErrors.push(`${rel(file)}: unresolved "${specifier}"`);
        }
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      bareImports.add(name);
    }
  }
  graph.set(file, dependencies);
}

check(
  "relative imports resolve",
  importErrors.length === 0,
  importErrors.length ? importErrors.slice(0, 5).join("; ") : `${files.length} modules`
);

const undeclared = [...bareImports].filter((name) => !(name in (pkg.dependencies || {})));
check("bare imports are declared", undeclared.length === 0, undeclared.join(", ") || [...bareImports].join(", "));
check("no CommonJS require in ESM sources", commonJs.length === 0, commonJs.join(", "));

const stubPattern = /\b(mock|mocks|mocked|stub|stubs|dummy|fake|simulated|placeholder|heartbeat|not implemented)\b/i;
const stubHits = [...sourceTexts]
  .filter(([, source]) => stubPattern.test(source))
  .map(([file]) => rel(file));
check("no mock or stub implementations", stubHits.length === 0, stubHits.join(", ") || "live paths only");

const scriptFiles = await walk(path.join(root, "scripts"));
const scriptStubs = [];
for (const file of scriptFiles) {
  if (rel(file) === "scripts/build-check.js") continue;
  if (stubPattern.test(await readFile(file, "utf8"))) scriptStubs.push(rel(file));
}
check("scripts contain no mock data", scriptStubs.length === 0, scriptStubs.join(", ") || `${scriptFiles.length - 1} scripts`);

const visiting = new Map();
const stack = [];
const reported = new Set();
const cycles = [];

const visit = (file) => {
  visiting.set(file, true);
  stack.push(file);
  for (const dependency of graph.get(file) || []) {
    if (!graph.has(dependency)) continue;
    if (visiting.get(dependency)) {
      const cycle = stack.slice(stack.indexOf(dependency)).concat(dependency);
      const signature = [...new Set(cycle)].sort().join("|");
      if (!reported.has(signature)) {
        reported.add(signature);
        cycles.push(cycle.map(rel).join(" -> "));
      }
      continue;
    }
    if (!visiting.has(dependency)) visit(dependency);
  }
  stack.pop();
  visiting.set(file, false);
};

for (const file of files) {
  if (!visiting.has(file)) visit(file);
}

check("no circular dependencies", cycles.length === 0, cycles.join("; ") || "clean graph");

const runtimeErrors = [];
for (const file of files) {
  if (rel(file) === listener) continue;
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    runtimeErrors.push(`${rel(file)}: ${error.message}`);
  }
}
check(
  "modules import cleanly",
  runtimeErrors.length === 0,
  runtimeErrors.length ? runtimeErrors.slice(0, 3).join("; ") : `${files.length - 1} modules (listener excluded)`
);

const apiModule = await import(pathToFileURL(path.join(root, "api/index.js")).href);
check(
  "serverless handler export",
  typeof apiModule.default === "function" && apiModule.maxDuration === 60,
  `maxDuration=${apiModule.maxDuration}`
);

const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
const rewrite = (vercel.rewrites || []).find((rule) => rule.destination === "/api/index");
check("vercel rewrites to the function", Boolean(rewrite), rewrite?.source || "missing");
check(
  "vercel function limits",
  vercel.functions?.["api/index.js"]?.maxDuration === 60 && vercel.functions?.["api/index.js"]?.memory === 1024,
  JSON.stringify(vercel.functions?.["api/index.js"] || {})
);

const routesSource = await readFile(path.join(root, "src/routes/api.js"), "utf8");
const serverSource = await readFile(path.join(root, "src/server.js"), "utf8");
const appSource = await readFile(path.join(root, "src/app.js"), "utf8");
const cronPaths = (vercel.crons || []).map((cron) => cron.path);
const missingCrons = cronPaths.filter((cronPath) => !routesSource.includes(cronPath));
check("cron routes are implemented", cronPaths.length > 0 && missingCrons.length === 0, cronPaths.join(", ") || "no crons");
check(
  "cron schedules are valid",
  (vercel.crons || []).every((cron) => typeof cron.schedule === "string" && cron.schedule.split(" ").length === 5),
  (vercel.crons || []).map((cron) => `${cron.path} ${cron.schedule}`).join("; ")
);
check(
  "ACP intake wired",
  routesSource.includes("/api/cron/intake") && routesSource.includes("/api/intake"),
  "poller cron + status endpoint"
);
check(
  "A2A surface mounted",
  appSource.includes('"./routes/a2a.js"') && appSource.includes("a2aRouter"),
  "agent cards + JSON-RPC /a2a"
);
check(
  "outreach engine wired",
  routesSource.includes("/api/cron/outreach") && routesSource.includes("/api/outreach"),
  "cycle cron + status endpoint"
);
check(
  "inbound management wired",
  routesSource.includes("/api/a2a/inbox"),
  "inbox log endpoint"
);

const configSource = await readFile(path.join(root, "src/config.js"), "utf8");
check(
  "Base mainnet only",
  configSource.includes("id: 8453") &&
    configSource.includes("https://mainnet.base.org") &&
    configSource.includes("0x238E541BfefD82238730D00a2208E5497F1832E0") &&
    configSource.includes("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") &&
    !/sepolia|testnet|goerli/i.test(configSource),
  "chain 8453 / mainnet RPC / USDC / ACP"
);

const {
  COMPETITOR_BENCHMARKS,
  COMPETITOR_UNDERCUT_BPS,
  OFFERINGS,
  competitorCeilingUsdc,
} = await import(pathToFileURL(path.join(root, "src/services/offerings.js")).href);
const { ONCHAIN_EXECUTION_OFFERINGS } = await import(
  pathToFileURL(path.join(root, "src/config.js")).href
);
const pipelineSource = await readFile(path.join(root, "src/services/pipeline.js"), "utf8");
const insightsSource = await readFile(path.join(root, "src/services/insights.js"), "utf8");
const executorSources = pipelineSource + insightsSource;
const unmapped = OFFERINGS.filter((offering) => !executorSources.includes(`"${offering.id}"`)).map(
  (offering) => offering.id
);
check(
  "every offering has an executor",
  OFFERINGS.length === 50 && unmapped.length === 0,
  unmapped.length ? `missing: ${unmapped.join(", ")}` : `${OFFERINGS.length} offerings`
);

const INSIGHT_IDS = [
  "macro_brief",
  "market_movers",
  "sector_rotation",
  "defi_tvl_report",
  "sentiment_pulse",
  "news_wire",
  "regulatory_radar",
  "funding_radar",
  "volatility_screen",
  "correlation_matrix",
  "stablecoin_monitor",
  "liquidity_map",
  "token_compare",
  "portfolio_heatmap",
  "signal_digest",
  "trend_velocity",
  "ai_agents_radar",
  "gas_forecast",
];
const insightRegistry = OFFERINGS.filter((offering) => INSIGHT_IDS.includes(offering.id));
check(
  "18 new zero-gas insight offerings registered",
  insightRegistry.length === 18 &&
    insightRegistry.every((offering) => offering.category === "intelligence") &&
    insightsSource.includes("export const INSIGHT_OFFERINGS") &&
    insightsSource.includes("executeInsight") &&
    pipelineSource.includes("INSIGHT_OFFERINGS.has(offering.id)") &&
    pipelineSource.includes("insightsPreview"),
  `${insightRegistry.length}/18 registered, all intelligence category`
);
check(
  "insight suite needs zero wallet balance",
  insightRegistry.every((offering) => !ONCHAIN_EXECUTION_OFFERINGS.has(offering.id)) &&
    insightRegistry.every((offering) => !["token_swap", "transfer_token"].includes(offering.id)),
  "no insight offering appears in the on-chain gate set"
);

const revenueSource = await readFile(path.join(root, "src/services/revenue.js"), "utf8");
const pricingSource = await readFile(path.join(root, "src/services/pricing.js"), "utf8");
const referralsSource = await readFile(path.join(root, "src/services/referrals.js"), "utf8");
check(
  "revenue suite wired",
  routesSource.includes("/api/quote") &&
    routesSource.includes("/api/revenue") &&
    routesSource.includes("/api/cron/revenue") &&
    revenueSource.includes("runRevenueCycle") &&
    pricingSource.includes("issueQuote") &&
    referralsSource.includes("processReferralPayouts") &&
    serverSource.includes("startRevenueLoop"),
  "quote + revenue cycle + referral payouts + local loop"
);
const outreachSource = await readFile(path.join(root, "src/services/outreach.js"), "utf8");
const competitorIds = Object.keys(COMPETITOR_BENCHMARKS);
const overCeiling = OFFERINGS.filter((offering) => {
  const ceiling = competitorCeilingUsdc(offering.id);
  return ceiling !== null && Number(offering.priceUsdc) > ceiling;
}).map((offering) => offering.id);
check(
  "competitor undercut rule wired",
  COMPETITOR_UNDERCUT_BPS === 5000 &&
    competitorIds.length === 15 &&
    overCeiling.length === 0 &&
    pricingSource.includes("competitorCeilingUsdc") &&
    pricingSource.includes("competitorPosition") &&
    outreachSource.includes("ceilingUsdc") &&
    outreachSource.includes("offering.competitor"),
  overCeiling.length ? `over ceiling: ${overCeiling.join(", ")}` : `${competitorIds.length} benchmarks at <=50%`
);

const donationsSource = await readFile(path.join(root, "src/services/donations.js"), "utf8");
const offeringsSource = await readFile(path.join(root, "src/services/offerings.js"), "utf8");
check(
  "donation service margin wired",
  configSource.includes("DONATION_SERVICE_MARGIN_BPS") &&
    configSource.includes("donationMarginBps") &&
    offeringsSource.includes("donationFeeUnits") &&
    offeringsSource.includes("10000 - marginBps") &&
    donationsSource.includes("serviceFeeUnits") &&
    donationsSource.includes("forwardTotal") &&
    pipelineSource.includes("serviceFeeUsdc"),
  "minimum 20% margin retained before forwarding"
);

const intakeSource = await readFile(path.join(root, "src/services/intake.js"), "utf8");
const clientSource = await readFile(path.join(root, "src/chain/client.js"), "utf8");
check(
  "on-chain execution gas gate wired",
  configSource.includes("ONCHAIN_EXECUTION_OFFERINGS") &&
    clientSource.includes("agentEthBalance") &&
    clientSource.includes("onchainGasGated") &&
    pipelineSource.includes("WALLET_GAS_UNAVAILABLE") &&
    intakeSource.includes("intakeGasGated") &&
    intakeSource.includes("WALLET_GAS_UNAVAILABLE"),
  "6 on-chain offerings gated at 0 ETH; intake retries gated jobs"
);
const gasSource = await readFile(path.join(root, "src/services/gas.js"), "utf8");
const marketSource = await readFile(path.join(root, "src/services/market.js"), "utf8");
const healthSource = await readFile(path.join(root, "src/services/health.js"), "utf8");
check(
  "self-funding gas unlock threshold wired",
  configSource.includes("ONCHAIN_UNLOCK_MIN_USD") &&
    configSource.includes("onchainUnlockMinUsd") &&
    configSource.includes("ethUsdFallback") &&
    gasSource.includes("gasUnlockThresholdWei") &&
    gasSource.includes("gasUnlockStatus") &&
    marketSource.includes("getEthUsdPrice") &&
    marketSource.includes('source: "fallback"') &&
    clientSource.includes("unlockThresholdWei") &&
    pipelineSource.includes("thresholdWei") &&
    intakeSource.includes("thresholdWei") &&
    healthSource.includes("gasUnlock") &&
    healthSource.includes("ethUsdSource"),
  "USD threshold -> live ETH price -> wei gate; labeled fallback when price fetch fails"
);
check(
  "outreach enabled by default",
  configSource.includes("bool(process.env.OUTREACH_ENABLED, true)") &&
    outreachSource.includes("config.outreach.enabled") &&
    outreachSource.includes("config.publicBaseUrl"),
  "discovery/pitch loop starts by default, self-guarded without PUBLIC_BASE_URL"
);
check(
  "zero-gas intelligence suite untouched by the gate",
  ONCHAIN_EXECUTION_OFFERINGS.size === 6 &&
    [
      "token_swap",
      "transfer_token",
      "batch_executor",
      "fund_startup",
      "semi_batch_fund_startup",
      "batch_fund_startup",
    ].every((id) => ONCHAIN_EXECUTION_OFFERINGS.has(id)) &&
    OFFERINGS.filter((offering) => !ONCHAIN_EXECUTION_OFFERINGS.has(offering.id)).length === 44,
  `${ONCHAIN_EXECUTION_OFFERINGS.size} gated / 44 ungated`
);
check(
  "revenue offerings live-sourced",
  [
    "scanArbitrage",
    "scanWhales",
    "gasAdvisor",
    "yieldRadar",
    "scanAgentCredit",
    "detectAnomalies",
    "tokenSecurityScan",
    "walletRiskAudit",
    "liquidationSnapshot",
    "scanNewPools",
    "scanSmartMoney",
    "scanAgentRevenue",
    "providerBenchmark",
    "virtualsAlpha",
    "scanJobLeads",
  ].every((fn) => revenueSource.includes(fn)) &&
    !/\bmock\b|\bdummy\b|\bstub\b|\bsimulat/i.test(revenueSource + pricingSource + referralsSource),
  "live Base scans, no mock paths"
);
const transferSource = await readFile(path.join(root, "src/services/transfer.js"), "utf8");
check(
  "batch payout executor wired",
  transferSource.includes("executeBatchUsdcTransfer") && pipelineSource.includes("executeBatchUsdcTransfer"),
  "USDC batch leg verification"
);

console.log("");
if (failures.length) {
  console.error(`Production build check failed: ${failures.length} issue(s).`);
  process.exit(1);
}
console.log(
  `Build check passed: ${files.length} modules, ${bareImports.size} runtime packages, no cycles or mock stubs.`
);
