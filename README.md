# Hyper Agent X7733 — Virtuals ACP on Base

Production Express backend for a high-frequency Base utility agent that is paid through the Virtuals Agent Commerce Protocol (ACP). Every paid request is verified against the on-chain ACP escrow before work starts, executed with real Base transactions or live market data, and settled back to the protocol.

- **Chain:** Base mainnet (8453)
- **ACP escrow:** `0x238E541BfefD82238730D00a2208E5497F1832E0` (`getJob()` + USDC balance checks)
- **Settlement token:** USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Execution venues:** KyberSwap Aggregator API + Virtuals bonding router (`0x8292B43aB73EfAC11FAF357419C38ACF448202C5`)
- **Live data:** CoinGecko, GeckoTerminal, DexScreener, Binance USD-M futures, Coinbase Exchange, DefiLlama Yields, honeypot.is, public RSS feeds, Gemini Google Search grounding, optional X/Twitter API v2
- **Autonomous execution:** on-chain ACP job intake poller (funded jobs are discovered and executed without an inbound HTTP call; see below)
- **Agent-to-agent:** A2A agent cards + JSON-RPC 2.0 endpoint at `/a2a`, session-aware inbound reply routing, and a 50-entry inbox log
- **Proactive outreach:** discovery, task review, priced pitching and negotiation, on by default; saving the Virtuals chat URL wakes it on the first inbound request and inbound traffic keeps it awake between cron slots
- **Beyond the catalogue:** a synthetic `custom_task` order id — when none of the 50 registered offerings fits, the agent asks the peer for its exact brief, prices it from that text, and routes it to Groq (fast generation) or Gemini (deep reasoning / live grounding)
- **Autonomous publishing:** idle-time X thread generator, on by default when AI and user-context X credentials are present (`SOCIAL_AUTOPOST=false` pauses it)
- **Runtime:** Node.js 24.x, ESM, deployed as a Vercel serverless function (`api/index.js`)

## Offerings

| ID | Price (USDC) | What it does |
| --- | --- | --- |
| `token_swap` | 0.025 | Universal Base swap. Direct KyberSwap routes, Virtuals bonding buy/sell, and composite USDC → VIRTUAL → token paths. Default slippage 3%. |
| `transfer_token` | 0.05 | ERC20 transfer (or `transferFrom` with client allowance) to a target address. |
| `fund_startup` | 5.00 | 5.00 USDC total: a minimum 20% service margin is retained by the agent, the remainder is forwarded on-chain to one project treasury. |
| `semi_batch_fund_startup` | 25.00 | 25.00 USDC total: minimum 20% service margin retained, the remainder split equally across 2–3 project treasuries (remainder to the first). |
| `batch_fund_startup` | 50.00 | 50.00 USDC total: minimum 20% service margin retained, the remainder split equally across 4–10 project treasuries (remainder to the first). |
| `resolve_tokens` | 0.001 | Resolves 1–10 symbols/addresses to verified Base contracts. |
| `suggest_a_trade` | 0.05 | Trade idea built from live candles, derivatives (funding/OI/long-short), ATR-based stop/targets, position sizing, and one-click `token_swap` params. |
| `mega_report` | 0.025 | Market briefing: global metrics, majors, trending tokens, headlines, yields, derivatives, with cited sources. |
| `twitter_alpha` | 0.005 | Social pulse on a topic: live X posts when a bearer token is configured, otherwise Gemini grounding citations. No invented posts. |
| `crypto_news` | 0.005 | Live headlines from public RSS feeds, deduped, ranked and sentiment-scored. |
| `topic_research` | 0.005 | Grounded research on any crypto topic with web citations and live market context. |
| `yield_alpha` | 0.005 | DefiLlama yield pools filtered by asset class/TVL, with risk and quality scoring. |
| `kol_alpha` | 0.005 | What tracked KOLs are posting (X API) or a grounded synthesis of public commentary. |
| `trending_tokens` | 0.005 | CoinGecko trending + DexScreener boosts enriched with live pair metrics and news mentions. |
| `token_info` | 0.005 | Live token snapshot: price, market cap, liquidity, supply, security screen, and links. |
| `token_alpha` | 0.005 | Token-specific alpha: technical snapshot, derivatives, news sentiment, and a sourced brief. |
| `deep_analytics` | 5.00 / 10.00 / 15.00 | Tiered deep report by `depth`: pool/candle/indicator/derivatives snapshot, honeypot and tax checks, AI risk synthesis. |
| `intel_retainer` | 50.00 weekly / 100.00 monthly | Daily live market/news/gas/yield feed pushed to a public A2A endpoint. Renewal requires a new funded job. |
| `flash_alert` | 3.00 | Live arbitrage spreads and USDC/WETH whale-transfer alerts. Only observed alerts are returned. |
| `gas_advisor` | 1.00 | Live Base gas price, 8-block trend, estimated cost by transaction type, and routing advice. |
| `yield_radar` | 2.50 | Base yield pools ranked by APY vs. median/p90 with TVL, IL risk and reward split. |
| `agent_credit` | 2.00 | ACP job-history reputation score plus live ETH/USDC balances for any agent address. |
| `token_security_scan` | 1.00 / token, 8.00 bundle | Live honeypot, tax, source, proxy, holder, liquidity and DEX-coverage scan for 1–10 Base tokens. |
| `wallet_risk_audit` | 2.00 | Contract-vs-EOA, balances, nonce, ACP history, completion rate and counterparty risk for any wallet. |
| `liquidation_guard` | 25.00 weekly / 80.00 monthly | Retainer that monitors up to 10 position tokens and pushes 24h drawdown alerts to a public A2A endpoint. |
| `new_pool_radar` | 1.50 scan / 25.00 monthly | GeckoTerminal new-Base-pool feed filtered by liquidity and age; optional daily retainer push. |
| `smart_money_flow` | 2.00 scan / 30.00 monthly | Live Base transfer logs above a USD floor, classified as pool buys/sells or wallet moves; optional retainer. |
| `batch_executor` | 1.00 + 0.05% | Executes 2–20 USDC payouts in one job, verifying each recipient balance change; fee is 1 USDC + 5 bps of volume. |
| `agent_revenue_audit` | 5.00 | Provider-side revenue audit: completed/rejected jobs, settled volume, unique clients, 30-day run rate and balances. |
| `provider_benchmark` | 3.00 | On-chain ACP provider leaderboard ranked by settled volume, completion rate and unique clients. |
| `virtuals_alpha` | 2.00 | Virtuals ecosystem report: VIRTUAL market metrics, Base liquidity, trending coins, news and live ACP activity. |
| `job_radar` | 2.00 scan / 30.00 monthly | Open or funded ACP jobs this agent does not own, filtered by budget and keywords; optional retainer. |
| `macro_brief` | 0.02 | Macro snapshot: global market cap/volume, majors, BTC dominance, ETH gas, with a sourced brief. Zero gas. |
| `market_movers` | 0.015 | Top Base movers ranked by 24h change with price, market cap and 7d context. Zero gas. |
| `sector_rotation` | 0.03 | CoinGecko category leaderboard with 24h/7d changes, leaders and laggards. Zero gas. |
| `defi_tvl_report` | 0.02 | DefiLlama chain + Base protocol TVL report with 1d/7d flows. Zero gas. |
| `sentiment_pulse` | 0.015 | Composite market pulse from Binance funding, open interest and long/short ratios. Zero gas. |
| `news_wire` | 0.02 | Ranked, sentiment-scored live headlines, optionally filtered by a query. Zero gas. |
| `regulatory_radar` | 0.015 | Live headlines matched to regulatory/legal topics, sorted by relevance. Zero gas. |
| `funding_radar` | 0.015 | Live headlines matched to funding/raises/M&A topics, sorted by relevance. Zero gas. |
| `volatility_screen` | 0.015 | Annualized realized volatility ranking across majors with regime label. Zero gas. |
| `correlation_matrix` | 0.03 | Pearson correlation matrix across major assets over a 30-day window. Zero gas. |
| `stablecoin_monitor` | 0.015 | Live stablecoin prices, market caps, peg deviations and 24h volume. Zero gas. |
| `liquidity_map` | 0.02 | Base pool liquidity map with 24h flow ranking. Zero gas. |
| `token_compare` | 0.02 | Side-by-side live comparison of two tokens: price, market cap, liquidity, security. Zero gas. |
| `portfolio_heatmap` | 0.03 | Live heatmap of 1–10 user-supplied tokens: 24h move, volume, volatility, liquidity. Zero gas. |
| `signal_digest` | 0.04 | Combined daily signal: derivatives pulse, volatility, correlations and trend ranks. Zero gas. |
| `trend_velocity` | 0.015 | Momentum ranking across majors by 1d/7d/30d rate of change. Zero gas. |
| `ai_agents_radar` | 0.02 | Live AI-agent ecosystem scan: Virtuals metrics, trending agents and ACP activity. Zero gas. |
| `gas_forecast` | 0.015 | Live Base fee history (24 blocks): current, average, median and trend. Zero gas. |

Each offering is published by `GET /api/offerings` with its parameter schema, price in base units, SLA, and payment token. The ten original intelligence offerings are priced 50% below comparable market rates and never return cached sample text: every report is synthesized at execution time from live provider data, with `sources` and `fetchedAt` timestamps. The sixteen revenue and risk offerings are described in [Revenue suite](#revenue-suite); their effective price can be lowered only through a server-issued quote (happy hour or performance model) and is re-checked against escrow at execution. The eighteen zero-gas insight offerings are described in [Zero-gas insight suite](#zero-gas-insight-suite-18-offerings): deterministic live data first, an optional AI garnish second, and no wallet balance required.

All 50 offerings share one execution path: `validateParams` normalizes the request, `basePriceFor`/`priceUnitsFor` set the minimum escrow budget, `verifyEscrow` re-reads the funded job, `runOffering` dispatches to the live handler, and `settle` submits the deliverable hash to ACP. One-off scans execute immediately, while `liquidation_guard`, monthly `new_pool_radar` / `smart_money_flow` / `job_radar` and `intel_retainer` activate a stored subscription whose daily push is built by the same scanners. The negotiated `custom_task` brief runs through that same path as a synthetic offering (see below), so no registry entry, price or route changes for the 50 published offerings.

### Competitive 50% undercut

Fifteen offerings map to an operator-supplied benchmark of Nox/Capminal and Otto AI list prices (`COMPETITOR_BENCHMARKS` in `src/services/offerings.js`). `COMPETITOR_UNDERCUT_BPS = 5000` is a hard ceiling: the listed price, `basePriceFor`, issued quotes, the escrow minimum and outbound pitches are each clamped to at most 50% of the declared benchmark, so no tier, plan, volume formula or campaign multiplier can drift above it. `competitorPosition()` publishes `benchmarkUsdc`, `maxPriceUsdc`, `undercutBps`, `savingsUsdc`/`savingsPct` and `benchmarkVerified: false` on every competitive offering, quote, A2A skill and pitch.

The benchmarks are operator-supplied on 2026-10-28 and are not checked against a live competitor feed; the agent never scrapes or guesses a competitor price. Update the table and every surface re-derives from it.

### 20% minimum donation margin

The three donation offerings keep a service margin so no job runs at a loss. `DONATION_SERVICE_MARGIN_BPS` (default 2000 = 20%, floor 2000, cap 5000) is retained from the escrowed price before `donationShares()` splits the remainder across project treasuries. The client still escrows the full 5.00 / 25.00 / 50.00 USDC; `executeDonation` forwards the post-margin amount, verifies each recipient balance, and reports `marginBps`, `serviceFeeUsdc` and `totalUsdc` in the deliverable. Quotes and previews (`previewOffering`) publish the same split up front.

### On-chain execution gas gate & self-funding unlock

`token_swap`, `transfer_token`, `batch_executor` and the three donation offerings are gated by `onchainGasGated()` when the agent wallet ETH balance is below the unlock threshold: `executeAcpJob` throws `503 WALLET_GAS_UNAVAILABLE` before escrow verification, so no transaction is attempted without gas. Intake does not stall on a gated job — the job id is persisted to the `intake:gas-gated` set and the cursor advances past it, so later zero-gas intelligence jobs in the same window still execute. On every pass intake first retries the gated set when ETH has returned, removing each job on any terminal outcome. `/api/health` exposes `onchainGasGated` and `onchainOfferings`, and readiness flags for the six gated offerings flip with the balance. All other 44 offerings (intelligence, risk, data) never touch this gate and execute with 0 ETH.

The gate is not a static zero-balance check — it unlocks itself as revenue lands:

1. **USD threshold.** `ONCHAIN_UNLOCK_MIN_USD` (default 0.75, clamped 0.10–10.00) states how much ETH, in USD, the wallet must hold before on-chain offerings are exposed.
2. **Live price.** `getEthUsdPrice()` reads CoinGecko (cached 30 s) and converts the threshold to wei. If the price fetch fails, a labelled `ETH_USD_FALLBACK` rate (default 3000) keeps the math working — the health payload reports which source (`coingecko` or `fallback`) produced the threshold.
3. **Dynamic unlock.** `gasUnlockThresholdWei()` recomputes on every gated execution attempt, intake retry and health probe. The moment the wallet holds at least the threshold (from off-chain revenue, an operator top-up, or any source), the six on-chain offerings ungate automatically and are re-published as available — no restart, no manual flag.
4. **Live progress.** `GET /api/outreach` exposes `zeroCapital` — the wallet's ETH and USD balance, the USD threshold, and a 0–1 `progress` toward the unlock — so the march to $0.75 is visible on every status poll.
5. **Never out-of-pocket.** The agent never spends its own money to test or fund gas. Escrow stays client-funded; off-chain offerings earn USDC with zero gas, and the wallet's ETH balance is only ever *read*.

Honest note: ACP settles in USDC, not ETH. Converting earned USDC to gas ETH is itself an on-chain transaction, so in practice the operator either swaps USDC→ETH occasionally or tops up a few dollars of ETH once; the unlock logic triggers automatically regardless of where the ETH came from.

### Zero-gas insight suite (18 offerings)

The eighteen additions (`macro_brief` … `gas_forecast`) are the pure-profit tier: every one is an off-chain intelligence report that runs with **0 gas and 0 wallet balance** and is never touched by the execution gate. Each handler follows the same integrity contract:

- **Deterministic data first.** All numbers come from live providers computed locally (CoinGecko, DefiLlama, Binance futures, Base RPC fee history, RSS feeds) — rankings, volatility, correlations, peg deviations, fee trends. This layer never needs an AI key.
- **AI garnish second.** Groq (`qwen/qwen3.8-27b`) writes a short interpretation of the supplied data; on failure `askJSON` falls back to Gemini (`gemini-3.8-flash`). The garnish is *optional*: if both engines are down, the job still completes with the deterministic data and `engine: null` — an engine outage never fails a paid job.
- **Honest failures.** If the underlying live data itself is unavailable (provider down, no matching headlines), the job throws an explicit `*_UNAVAILABLE` error and takes the escrow refund path; it never returns filler.

Sixteen of the eighteen need no parameters and join the outbound pitch menu automatically; `token_compare` (two tokens) and `portfolio_heatmap` (1–10 tokens) are inbound-only because a pitch must always carry `{}`.

## How a paid job runs

1. `POST /api/acp` validates the offering and parameters (addresses, amounts, slippage, project counts).
2. The ACP job is read from Base. It must exist, be `FUNDED` (status 1), assigned to the agent wallet, have a budget of at least the offering price, remain valid past `MIN_ESCROW_WINDOW_SECONDS`, and match the optional `buyer`.
3. The ACP contract is confirmed to be deployed and denominated in Base USDC, and the escrow contract's USDC balance must cover the job budget.
4. A per-job distributed lock and a stored job record prevent duplicate execution and nonce collisions.
5. Execution runs:
   - **Swaps:** KyberSwap quote → build → approve → swap. On `NO_ROUTE`, the agent tries the Virtuals bonding curve directly (VIRTUAL ↔ token) or a composite USDC/stable → VIRTUAL → token path. Output delivery is verified on-chain against the slippage floor.
   - **Transfers:** recipient balance is measured before/after and must increase by the requested amount.
   - **Donations:** the agent forwards the post-margin share to each project and verifies every recipient balance; the service fee stays in the agent wallet.
   - **Intelligence:** live provider queries run in parallel (with per-provider timeouts and short TTL caches), deterministic math computes indicators, rankings, risk and sentiment, and one Groq/Gemini synthesis call writes the brief from that data only. No static fallback lists, no pre-written news, no simulated values.
6. The deliverable hash is submitted to ACP (`submit`) when `AUTO_SUBMIT_DELIVERABLE=true`. A submission failure is recorded but does not discard completed work.
7. On failure the job is refunded at the escrow layer: the agent attempts an on-chain `reject` (which returns the client's USDC), falling back to expiry + client `claimRefund` if the contract disallows the reject. The response always states the exact refund mode.

The job record is replayed idempotently: the same `jobId` and parameters return the original result with `replayed: true`; different parameters are rejected with `409 PARAMS_MISMATCH`.

The autonomous intake poller (below) enters this pipeline at step 2 for jobs discovered on-chain. Steps 2–7, including settlement and refunds, are identical.

### Live intelligence execution

All ten intelligence offerings share the same integrity contract:

- **Live inputs only.** News comes from RSS feeds fetched per request (cached 60 s), pairs/pools from GeckoTerminal and DexScreener, prices from CoinGecko, candles from Binance → Coinbase → GeckoTerminal, funding/OI/long-short from Binance USD-M futures, yields from DefiLlama, security from honeypot.is, and social/research text from the X API or Gemini Google Search grounding.
- **Deterministic math.** EMA/RSI/ATR/Bollinger, swing levels, momentum scoring, ATR-based stop/targets and position sizing (`src/services/ta.js`), news importance ranking, dedupe and lexicon sentiment (`src/services/news.js`), and DeFi risk/quality scores (`src/services/market.js`) are computed locally from the fetched data.
- **Constrained synthesis.** Groq (JSON mode) handles fast intent routing and execution-time intelligence briefs. Gemini is the primary engine for autonomous article generation and the only engine used for Google Search grounding; each engine falls back to the other when configured. The model receives the collected facts as untrusted data and is instructed never to invent prices, addresses or events; numbers in the deliverable come from the deterministic layer. Citations are kept in `sources`.
- **No fabricated fallbacks.** If a provider is unreachable it is retried once (HTTP layer) and then either degraded around (another verified provider supplies the same fact) or the job fails explicitly. A failed job triggers the same escrow-layer refund path as on-chain work (`reject`, then expiry + `claimRefund`). Missing AI keys return `503 AI_NOT_CONFIGURED` before any charge.
- **Provenance.** Every deliverable includes `engine`, provider status, `fetchedAt`, and a `disclaimer`. Social posts are only reported when they come from the X API; grounding findings are labelled as grounded web research with citation URLs.

`suggest_a_trade` additionally returns one-click execution params: for a long signal on a non-native Base token it quotes KyberSwap live and returns a ready `token_swap` offering call, so a client can fund the swap as a second ACP job.

## Autonomous ACP job intake

ACP clients create a job on Base and fund escrow themselves; they do not need to call this HTTP API. The intake poller (`src/services/intake.js`) discovers those jobs on-chain and executes them, which is what makes the agent autonomous.

**Discovery.** Each pass reads `jobCounter()` for the head and calls `getJob(id)` for the ids after the stored cursor — batched through `multicall` in chunks of 25, with a sequential per-id fallback if the RPC rejects the batch. The first pass without `ACP_INTAKE_START_ID` anchors the cursor at the current head, so a fresh deployment never replays historical jobs.

**Selection.** A job is only considered when its on-chain `provider` is this agent's wallet and its status is `FUNDED` (1). Every other job advances the cursor without action. Jobs that already have a local record are skipped, so a restart cannot double-execute.

**Failure discipline.** The cursor only advances past work with a terminal outcome. Transient pre-record failures (RPC read errors, unclassified provider errors) defer the job instead: the cursor stops before it and the next pass retries, so a funded job can never be silently skipped by a provider hiccup. An entire scan window that reads back empty is treated as a read failure and the cursor is not moved. Gas-gated jobs are parked in the persistent `intake:gas-gated` set and retried once the wallet crosses the unlock threshold.

**Order format.** The order travels in the ACP job description. Three shapes are accepted:

```
{"offeringId":"token_swap","params":{"sellToken":"USDC","buyToken":"WETH","amount":"10","maxSlippage":3}}
token_swap {"sellToken":"USDC","buyToken":"WETH","amount":"10"}
offering:trending_tokens
```

Free-form prose, unknown offering IDs, and malformed parameter objects are recorded as `unrecognized_description` / `invalid_order` and are **not executed and not rejected** — the job stays funded for manual handling or client withdrawal. Guessing an on-chain order from prose would spend real escrow.

**Execution.** Accepted jobs run through the same `executeAcpJob` pipeline as `POST /api/acp`: escrow verification, wallet lock, idempotent job record, on-chain execution, settlement, and the ACP-layer refund path on failure. Work is bounded by `ACP_INTAKE_BATCH` executions and `ACP_INTAKE_BUDGET_MS` per pass to stay inside the 60 s function limit; jobs that do not fit are deferred and retried next pass. The cursor only advances past jobs that were handled, so a deferred or failed pass is safe.

**Drivers.**

- `npm start` — unref'd interval loop every `ACP_INTAKE_INTERVAL_SECONDS` (default 60 s), first pass 15 s after boot.
- Vercel — `GET /api/cron/intake` from `vercel.json` (daily on Hobby; see the plan limits below).
- On demand — `GET /api/cron/intake?reason=manual` with `Authorization: Bearer $CRON_SECRET`.
- Status — `GET /api/intake` returns the cursor, the last pass, and up to 20 recent outcomes.

A distributed lock makes concurrent passes a no-op, so the local loop, a cron invocation, and a manual call cannot execute the same job twice.

## Agent-to-agent (A2A)

The agent publishes standard A2A discovery documents and answers JSON-RPC 2.0 requests at `/a2a`. Both card generations are served so either client version can discover the agent:

| Surface | Purpose |
| --- | --- |
| `GET /.well-known/agent.json` | A2A v0.3 agent card (`preferredTransport: JSONRPC`, one skill per offering) |
| `GET /.well-known/agent-card.json` | A2A v1.0 agent card (`supportedInterfaces`) |
| `GET /a2a` | Short description of the endpoint and supported methods |
| `POST /a2a` | JSON-RPC 2.0 (`message/send`, `SendMessage`, `tasks/get`, `GetTask`) |

Each card lists all 50 offerings as skills with price, SLA, and parameter schema, plus a `https://virtuals.io/acp` extension advertising the Base chain id, escrow contract, payment token, the on-chain discovery method, and the `customTask` contract for work outside the catalogue (custom work is extension metadata, never a 51st skill).

**Methods.**

- `message/send` (v0.3) or `SendMessage` (v1.0) parses free text with the same intent engine as `/api/chat`. A routed offering returns a completed task whose `preview` artifact contains the live quote, resolved tokens, or provider availability. **A2A is preview-only:** nothing is executed without escrow. The task metadata carries `execution.requiresEscrow` and the exact description envelope to fund.
- A message that does not route to an offering returns an agent `message` with the help text instead of a task.
- `tasks/get` / `GetTask` accepts `jobId`, `acp-<jobId>`, or any task id returned by this agent. Local records resolve to the stored deliverable; otherwise the live ACP job state is returned.
- `tasks/cancel` returns `-32004`: escrow jobs are refunded on-chain through `reject` or `claimRefund`, not through A2A.
- Streaming (`message/stream`, `tasks/resubscribe`) and `ListTasks` return `-32601`; the cards advertise `streaming: false`.

Set `A2A_ENABLED=false` to turn the endpoint off (cards return a JSON-RPC error). A2A is read-only, so no API key is required; it is rate limited with the rest of the API.

**Inbound shop management.** Session replies from outbound pitches are routed before intent parsing: a message whose `contextId` (or `metadata.sessionId`) matches a live outreach session goes to the negotiation state machine instead of the generic help/preview path. Every inbound message that resolves to an offering, a session action, or an error is appended to a bounded inbox log (50 entries, 7-day TTL) with text hash, excerpt, source, action, latency and whether the reply was silent. `GET /api/a2a/inbox` (API-key protected) returns totals, 24-hour counts, action breakdown and the ten most recent entries. Session replies that end a conversation (accept, opt-out, expiry, loop) return a task with `TASK_STATE_CANCELED` and a `metadata.reason`.

## Proactive discovery & outreach

The agent can find other Base agents, review their published tasks, score them for fit, pitch a priced intelligence job with a live micro-alpha teaser, and negotiate until the counterparty funds an ACP job. **Outreach is on by default (`OUTREACH_ENABLED=true`)**. It starts when `PUBLIC_BASE_URL` is configured or when the first inbound request arrives on the trusted Vercel deployment host. Saving/updating the chat URL on Virtuals therefore activates discovery as soon as the platform calls the agent; there is no platform webhook to observe a dashboard save before that first call. Set `OUTREACH_ENABLED=false` to opt out entirely.

**The cycle keeps itself awake.** The activation wake is a one-shot, and a Hobby deployment only gets four outreach cron slots a day, so an idle deployment would otherwise stall between slots. Every non-cron inbound request (protocol probe, agent-card fetch, peer reply, buyer chat) now re-arms exactly one follow-up wake per `OUTREACH_INTERVAL_SECONDS` through `maybeWakeOutreach` in `src/services/activation.js`: a store marker (`outreach:kick`, `onlyIfAbsent`, TTL = the interval) guarantees one wake per interval, the wake never passes `force=1`, and it is skipped entirely when the cycle is not due or the day's pitch budget is spent. The cron route never re-arms itself, so a wake cannot cascade. Both paths require `CRON_SECRET` (the routes fail closed without it) and continuation wakes need at least some inbound traffic — the platform cron slots still cover a fully idle deployment.

**Discovery** (`src/services/discovery.js`). Six real sources, queried every cycle:

1. **On-chain ACP activity** — recent job ids, their client/provider addresses, budgets and timestamps. Agents already paying for work are the best prospects.
2. **Public Virtuals directory, swept continuously** — `OUTREACH_DIRECTORY_URL` (default `https://acpx.virtuals.io/api/agents`), keyless. Each record includes the agent's offerings/jobs, category, enabled chains, success rate and X handle. The directory currently reports **44,110 agents over 442 pages of 100**. One cycle reads `OUTREACH_DIRECTORY_PAGES` (default 4) consecutive pages of `OUTREACH_DIRECTORY_LIMIT` (default 100, the provider maximum) — **400 directory agents per cycle** — fetched in parallel, and the next start page is persisted in the shared store (`outreach:directory:sweep`) together with the page count the directory reported. The cursor wraps at that reported count, so a full sweep of the network takes ~111 cycles (≈19 hours at the 10-minute cadence on Pro, or ~28 days across four daily Hobby slots) and then begins again — never pinned to one page or a static subset. `OUTREACH_DIRECTORY_MAX_PAGES` (default 900) is only the fallback bound before the first successful page, and if nothing is stored yet the first cycle starts from a time-derived page so concurrent deployments do not all read page 1. The request retries twice because this endpoint intermittently returns 5xx or stalls, and a page that still fails is reported while the remaining pages continue.
3. **Public ACP registry** — `OUTREACH_REGISTRY_URL/wallet/<address>` enriches anonymous on-chain participants with their live profile and published tasks.
4. **Optional authenticated index** — `OUTREACH_INDEX_URL` when an `OUTREACH_INDEX_TOKEN` or `ACP_API_KEY` is configured. Auth failures are reported and do not stop the public sources.
5. **Alternative directory feeds** — `OUTREACH_INDEX_URLS` (comma-separated) sweeps extra agent directories/platform feeds in parallel with the sources above, each isolated so one failing feed never stops the others. Any JSON array or `{data:[...]}`/`{agents:[...]}` shape with `name`/`url`/`walletAddress` fields is accepted.
6. **`OUTREACH_TARGETS` allowlist** — comma-separated agent cards or base URLs for known counterparties.

Candidates with a public A2A card are contacted by JSON-RPC. Directory agents without an A2A endpoint but with a published X handle can receive a concise X mention (`OUTREACH_X_PITCH=true`, default); set it to `false` for A2A-only outreach. The engine never guesses an endpoint from a wallet address. The X mention ends with `Negotiate: //<public-host>/a2a` so a mentioned peer has a reachable place to haggle, ask for a custom brief or read the agent card instead of only being able to fund blind.

A2A cards are fetched only from public HTTPS origins: loopback, private, link-local and IPv6 literals are rejected, as are URLs with embedded credentials (SSRF guard). Each candidate is scored deterministically 0–100: domain keywords, overlap with the pitchable intelligence offerings, published-task overlap, on-chain activity, the agent's **own ACP track record published by the directory** (settled jobs, success rate, unique buyers, gross volume and recency — capped at 25 points, with a discount for agents dormant over 180 days) and available contact channels. Candidates below `OUTREACH_MIN_SCORE` or without an A2A/X channel are skipped.

**Direct-earning bounty radar** (`src/services/bounties.js`). Alongside the protocol pipeline, the agent scans verified public bounty feeds for legal micro-bounties it can deliver: GitHub bounty-labeled issue search is the primary source (4,900+ open issues at scan time). Results are filtered to catalogue-relevant work (automation, data, content, Base/Web3), reward hints are extracted (`[25 MRG]`, `$150`, `300 USDC`), rewarded work sorts first, and the top matches are cached in the store and surfaced on `GET /api/bounties` (`?refresh=1` forces a live scan) and in the outreach status pane. A cron refreshes the scan 4×/day; payouts follow each platform's own claim flow and route to the agent wallet.

**Autonomous bounty execution** (`src/services/bounty-executor.js`). With `GITHUB_TOKEN` set (a fine-grained PAT with contents, issues, pull-requests and stars write), the same 4×/day cron runs the executor after the scan, so claiming needs no manual steps. Every candidate is **verified before any write**: the repo must be at least `BOUNTIES_MIN_REPO_AGE_DAYS` old (default 30), show community signal (`BOUNTIES_MIN_STARS`, default 1, or ≥1 subscriber) and be a real codebase — same-day zero-star networks with duplicated issues (the IES-BoilerRoom pattern) are rejected outright. The executor skips closed/assigned issues and any target already solved upstream (existing `Fixes #N` PR or a precheck finding the deliverable on the default branch), then for a registered deliverable it: forks the repo, creates a `bounty-<n>-autonomous` branch, commits the deliverable files via the Contents API, opens a PR titled with `Fixes #N` and naming the `BOUNTY_PAYOUT_WALLET`, stars the policy repos (`BOUNTIES_STAR_ON_CLAIM`) and posts the exact claim comment the repo's bounty policy documents (e.g. `I claim this bounty`) — idempotently, so reruns never duplicate comments or PRs. Every transient failure (fork materializing, branch/file already exists, upstream 5xx) self-corrects on the spot; anything still failing retries with 10/20-minute backoff up to 3 attempts, and per-issue state (status, PR URL, attempts) persists in the store and is visible on `GET /api/bounties` under `execution`. `BOUNTIES_MAX_OPEN_PRS` (default 3) caps concurrent submissions. Deliverables are registered per issue in `DELIVERABLES`; unregistered targets are only recorded, never claimed blindly. The first registered target is mergeos-bounties/BeeAR #8 (EN/VI web i18n). Off-platform payout steps (e.g. a bounty site's own claim form) remain the platform's flow; the PR and claim comment carry the payout wallet so funds route to it.

A directory `resources` URL becomes a pitch channel only after its agent card answers; until then the only unverified endpoint trusted is one you list in `OUTREACH_TARGETS`. In practice the first live pitch therefore needs at least one reachable channel: `OUTREACH_TARGETS` (operator-supplied A2A endpoints), `ACP_API_KEY` / `OUTREACH_INDEX_TOKEN` for the authenticated ACP index, or the X keys that enable mention pitching.

The outbound menu is limited to offerings that validate with an empty parameter envelope. A pitch always carries `{"offeringId":"…","params":{}}`, so offerings that need a token, topic, address or retainer endpoint stay inbound-only; pitching them would produce a funded job the intake poller has to reject. The menu currently holds 28 offerings — `mega_report`, `twitter_alpha`, `crypto_news`, `yield_alpha`, `kol_alpha`, `trending_tokens`, `flash_alert`, `yield_radar`, `new_pool_radar`, `smart_money_flow`, `virtuals_alpha`, `job_radar` plus sixteen of the eighteen zero-gas insight offerings (`token_compare` and `portfolio_heatmap` require tokens and stay inbound-only).

**Analysis and pitch.** Groq (`qwen/qwen3.8-27b`, JSON mode) performs rapid target analysis; Gemini (`gemini-3.8-flash`) adds grounded context for the deeper read. Every call falls back to the other engine automatically, and a pitch that cannot be built (no AI, no live data) is skipped rather than sent half-formed. The pitch must contain a **micro-alpha teaser built from the live market snapshot** — CoinGecko trending, Binance futures, CoinGecko global metrics or current RSS headlines, captured immediately before sending. A hook is rejected unless every number in it appears in that snapshot, so no generic or invented alpha goes out. The outbound message carries the exact ACP order envelope, the quoted price, the session id and an expiry.

**Pricing and negotiation.** Quotes start from the list price of the selected offering, scaled by a 1.0–1.4 complexity factor and `OUTREACH_PRICE_MULTIPLIER`, capped at `OUTREACH_MAX_PRICE_USDC` (0.075) and never below list. The state machine accepts, counters at the floor, concedes one step, extends once, or closes:

- **5-minute rule** — every session expires after `OUTREACH_SESSION_TTL_SECONDS` (default 300). One extension of up to 120 s is granted only when the counterparty's stated budget is at least **2× the quote**, i.e. only for a genuinely high-value negotiation.
- **Turn cap** — `OUTREACH_MAX_TURNS` (default 6); reaching it closes the session.
- **Loop detection** — a repeated message hash in the same session is ignored silently, and bot-to-bot ping-pong is cut by the turn cap.
- **Opt-out** — any opt-out phrase adds the target to a permanent opt-out set; no further messages are sent.
- **Sending back-off** — failed sends back off for 6 hours; every contact has a 72-hour cooldown.
- **Daily cap** — `OUTREACH_DAILY_CAP` (default 12) pitches per UTC day, at most `OUTREACH_MAX_TARGETS` (default 5) per cycle.

**Funding is verified, never assumed.** When a target claims to have funded job *N*, the agent calls `getJob(N)` and requires on-chain status `FUNDED`, provider equal to this agent's wallet, and a budget at least the quoted floor before marking the deal accepted. A claim that fails verification gets a `funded_unverified` reply and no execution. The agent **never funds a job itself**; the client locks escrow and the intake poller executes it.

**Operating it:**

- `GET /api/outreach` — activation, public URL source, channels, discovery sources, caps, pitches today, sessions and last error. Accepts `x-api-key`, `Authorization: Bearer`, `?secret=<CRON_SECRET>` or `?passcode=<BOSS_PASSCODE>` so a browser bar can read state; adding `&run=1` fires an immediate sweep instead.
- `POST /api/outreach/start` — immediately run one cycle without waiting for cron. Accepts `x-api-key`/`Authorization: Bearer`, or `?secret=<CRON_SECRET>` / `?passcode=<BOSS_PASSCODE>` so a browser or a scheduler with no header support can fire it.
- `GET /api/cron/outreach` — one cycle (requires `CRON_SECRET`; `?force=1` bypasses the interval throttle, not the daily cap, cooldown or opt-outs). Pasting `<public-url>/api/cron/outreach?secret=<CRON_SECRET>&force=1` into a browser runs the sweep with no headers, which is how to fire the first outbound cycle right after a deploy.
- Long-running hosts (`npm start`) run an unref'd interval loop; Vercel uses four daily cron slots plus the chat-URL activation wake-up.
- A2A pitches use JSON-RPC `message/send` with `metadata.sessionId`; X pitches are public mentions through the configured user-context X account.

Outreach failures are contained: a cycle catches everything, records `lastError`, and never throws into Express or the ACP pipeline. Discovery source errors are reported in the cycle result, not fatal.

**Funding of a negotiated custom brief is verified the same way**, with one extra rule: the job description must carry the exact brief that was quoted, because the tier price — and therefore the escrow minimum — is recomputed from that text. `src/services/outreach.js:orderMatchesSession` compares the normalized requirement, so a job funded against a different brief is refused with `funded_unverified` instead of executed.

## Custom work beyond the 50 offerings (`custom_task`)

A peer that fits none of the registered offerings is not skipped. `runOutreachCycle` opens a **custom session** for it (`customAskSession`), sends the ask over A2A, and counts it against the same daily cap, cooldown and opt-out rules as a pitch. The peer's reply becomes the brief: `evaluateNegotiation` returns `need_brief` until the message is long enough to price, then `requirement`, which fixes the session's price, floor and a fresh five-minute window. Inbound traffic gets the same treatment without a session — `customInboundReply` quotes an unmapped statement and answers an unmapped question with the ask, in `POST /a2a` and `POST /api/chat`.

`custom_task` is a **synthetic offering**: `getOffering("custom_task")` resolves it and the pipeline executes it, but it is never added to `OFFERINGS`, `GET /api/offerings`, the agent-card skills or the pitch menu, so the registry stays exactly 50 and every existing offering keeps its current preview and execution path.

**Pricing and routing are deterministic, never model-chosen.** `assessCustomTask` (`src/services/offerings.js`) reads the requirement text and produces complexity 1–5 (`CUSTOM_TASK_MIN_CHARS`/`MAX_CHARS`, signal weights, length) and a tier price — `CUSTOM_TASK_BASE_PRICE_USDC` × 1/1.5/2/2.5/3, capped at `CUSTOM_TASK_MAX_PRICE_USDC`. Signals pick the engine: `live_facts` and `onchain_context`/`deep_reasoning` wording (or complexity ≥ `CUSTOM_TASK_DEEP_THRESHOLD`) put **Gemini** first — it is also the only engine asked for Google Search grounding — while `structured_output`, `bulk_items` and plain generation put **Groq** first for speed. Because both numbers come from the requirement alone, `verifyEscrow` recomputes the identical `priceUnitsFor` amount from the job description.

**Execution** (`src/services/custom.js:executeCustomTask`) is zero-gas. Gemini-grounded briefs fetch live facts first, live-context briefs pull CoinGecko global/trending and RSS headlines in parallel (failing providers are listed, never faked), and the brief plus that evidence goes to the preferred engine through `askJSON`/`askText`, which still fail over to the other engine. If neither answers, the job throws `CUSTOM_AI_UNAVAILABLE`: the pipeline refunds the escrow rather than delivering invented work. Deliverables carry the routing report (`preferred`, `answeredBy`, `fellBack`, signals, reasons), grounding citations, live data and latency.

**Toggling it off:** `CUSTOM_TASK_ENABLED=false` removes the ask from the outreach cycle, makes `getOffering("custom_task")` 404, and drops the inbound quote path — the 50 registered offerings are unaffected.

## Revenue suite

Ten revenue mechanics sit on top of the existing ACP escrow, extended by ten v1.6.0 high-velocity offerings. Nothing here introduces a second payment rail: every paid action is still a funded Base ACP job denominated in USDC, and the only extra on-chain transfer the agent initiates is a referral commission **after** the referred job reaches `COMPLETED`.

| # | Mechanism | How it is enforced |
| --- | --- | --- |
| 1 | **Tiered pricing** | `deep_analytics` charges 5.00 / 10.00 / 15.00 USDC by `depth` (`standard`/`pro`/`enterprise`). `basePriceFor()` and `priceUnitsFor()` are the single source of truth; escrow rejects a budget below the tier price. |
| 2 | **Retainers** | `intel_retainer` is 50.00 USDC weekly or 100.00 monthly. A funded job activates the subscription and the agent pushes a live feed to the client's public HTTPS A2A endpoint once per day. A renewal requires a new funded job; nothing auto-debits. |
| 3 | **Referrals** | A `referrer` address on the order earns 700 bps (5–10% configurable) of the effective price, capped at `REFERRAL_MAX_USDC`, queued at completion and paid only after `getJob()` shows `COMPLETED` and the wallet holds the commission plus reserve. Idempotent per job, with retries and a lock. |
| 4 | **Happy hour** | During the configured UTC window (default 00–06) and/or when Base gas is at or below `HAPPY_HOUR_MAX_GWEI`, `/api/quote` discounts the quote by up to 30% total. Discounts exist only inside stored quotes; list prices and escrow minimums never move. |
| 5 | **Flash alerts** | `flash_alert` scans live Base pools for arbitrage spreads and recent USDC/WETH `Transfer` logs for whale movements. Only observed alerts are returned; an empty scan says so explicitly. |
| 6 | **Gas advisor** | `gas_advisor` reads `getGasPrice()` and eight recent base fees, reports the trend, estimated gas units and ETH/USD cost, and recommends now vs. waiting. |
| 7 | **Performance pricing** | A `model: "performance"` quote charges 25% upfront through escrow and states the remaining 75% as a bonus. Only one-off intelligence offerings are eligible; retainer-capable offerings (`intel_retainer`, `liquidation_guard`, `new_pool_radar`, `smart_money_flow`, `job_radar`) are rejected. The bonus is a separate client-funded ACP job, escrow cannot enforce a success fee, and the payload says so. |
| 8 | **Micro-bounties** | Every cycle compares successive pool snapshots for liquidity/price drops. A detected anomaly is matched to a **contactable** outreach target and pitched as a paid `deep_analytics` report. Without a matching public endpoint the bounty is recorded as `no_target` instead of being sent blind. |
| 9 | **Yield radar** | `yield_radar` ranks live DefiLlama Base pools by APY against the Base median and p90, with TVL, IL risk and reward split. |
| 10 | **Agent credit** | `agent_credit` scans up to 120 recent ACP jobs for the target address, scores activity, completion, settled volume, recency and penalties, and reports live ETH/USDC balances and nonce. |
| 11 | **Token security scan** | `token_security_scan` reads honeypot simulation, taxes, source/proxy flags, holders, pools and DEX coverage for 1–10 tokens. Scoring is deterministic and each token is priced at 1.00 USDC, or 8.00 for a ten-token bundle. |
| 12 | **Wallet risk audit** | `wallet_risk_audit` combines contract bytecode, nonce, ETH/USDC and watch-token balances with the ACP job history to produce risk flags and a 0–100 risk score. |
| 13 | **Liquidation guard** | `liquidation_guard` stores a 7- or 30-day monitor for up to 10 position tokens. The daily push recomputes 24h drawdown against live pools and flags liquidity below `SECURITY_MIN_LIQUIDITY_USD`. |
| 14 | **New pool radar** | `new_pool_radar` filters GeckoTerminal's new-Base-pools feed by `minLiquidityUsd` and `maxAgeHours`. One-off scans execute immediately; monthly plans push only pools not previously delivered. |
| 15 | **Smart money flow** | `smart_money_flow` resolves the watchlist to Base tokens and their DEX pools, scans Transfer logs (with a block-receipt fallback), filters by `minUsd` and classifies buys, sells and wallet flows. Aggregate net pool flow is reported. |
| 16 | **Batch payouts** | `batch_executor` sends 2–20 USDC legs from the agent wallet or via the client's allowance. Each leg is verified by recipient balance delta; the fee is exactly 1.00 USDC + 5 bps of total volume. |
| 17 | **Revenue audit** | `agent_revenue_audit` computes provider-side completed/rejected/expired counts, settled volume, average and maximum job size, unique clients, top clients and a 30-day run rate from live ACP jobs. |
| 18 | **Provider benchmark** | `provider_benchmark` groups recent ACP jobs by provider and ranks them by settled USDC volume, completion rate and unique clients, including this agent's own rank when a wallet is configured. |
| 19 | **Virtuals alpha** | `virtuals_alpha` joins CoinGecko market data, Base pool liquidity, trending coins, Virtuals news and a live ACP ecosystem sample, with an optional Groq/Gemini synthesis limited to the supplied facts. |
| 20 | **Job radar** | `job_radar` scans recent ACP jobs and returns open or funded jobs not owned by this agent, filtered by budget, keyword and status. Monthly plans push new leads and dedupe by job id. |

**Retainer kinds.** `intel_retainer`, `liquidation_guard` and monthly `new_pool_radar`, `smart_money_flow` and `job_radar` all use the same subscription store with a `kind` and per-kind monitor config. `buildSubscriptionFeed()` rebuilds each feed from live scanners, filters already-delivered keys (pool addresses, transfer hashes or job ids) and pushes at most once per UTC day. Renewal always requires a new funded ACP job; no retainer auto-debits a client.

**Quotes.** `POST /api/quote` validates the offering params, stores a record bound to `{offeringId, params, model, client, referrer}` with a TTL (`QUOTE_TTL_SECONDS`, default 900), and returns the exact description envelope to fund. The escrow check resolves the quote again against the job's normalized params and on-chain client: expired, wrong offering, wrong params or wrong client quotes fail before execution. Happy-hour and performance pricing are only available through quotes, so a caller cannot self-declare a discount or quote a cheap variant and execute a richer one.

**Revenue cycle.** `runRevenueCycle()` (local loop every `REVENUE_INTERVAL_SECONDS`, or `GET /api/cron/revenue`) scans arbitrage and whale activity, snapshots pools for anomaly detection, delivers due retainer feeds, processes referral payouts, and pitches at most one bounty. It holds a distributed lock, respects a wall-clock budget (`REVENUE_BUDGET_MS`) and a daily delivery cap, and stores a summary plus the last error.

**Operating it:**

- `GET /api/pricing` — live tier table, happy-hour window, gas, referral terms (public, read-only).
- `POST /api/quote` — issue a bound quote (API key when configured).
- `GET /api/revenue` — cycle state, pricing, subscriptions and referral queue (API key).
- `GET /api/revenue/subscriptions` and `GET /api/revenue/referrals` — focused views (API key).
- `GET /api/cron/revenue` — one cycle (requires `CRON_SECRET`; `?force=1` bypasses the interval throttle only).

**Honest limits.** The bonus half of a performance quote is not escrowed and can only be collected if the client chooses to fund a second job. Referral commissions come out of the agent wallet after settlement, never from escrow principal, so a low wallet balance leaves them queued. Retainer pushes require a public HTTPS A2A endpoint and fail visibly (recorded per subscription) if the endpoint rejects or times out. On-chain agents without a public endpoint cannot receive bounty pitches. On Vercel Hobby the revenue cron is daily; the local loop provides the real cadence.

## Autonomous X publishing

The agent writes and publishes its own crypto intelligence threads during idle time. **Autoposting is on by default**; set `SOCIAL_AUTOPOST=false` to pause it. A cycle still does nothing unless AI and user-context X credentials are configured, the agent is idle, the interval is due and the daily cap has room.

**How a cycle runs** (`src/services/social.js` → `src/services/articles.js`):

1. **Idle gate.** A cycle is skipped while any ACP job is `processing` (stale records from killed invocations do not block it). A distributed lock ensures only one instance publishes.
2. **Cadence and caps.** Cycles are attempted at most every `SOCIAL_INTERVAL_MINUTES` (default 300 = 5 h, bounded 4 h–24 h) and capped at `SOCIAL_MAX_POSTS_PER_DAY` (default 4). Theme rotation (`market_brief`, `technical_setup`, `news_desk`, `yield_watch`, `trending_narrative`) keeps consecutive posts distinct.
3. **Live research.** Pulls current global metrics, majors, headlines, trending coins, derivatives and indicators (plus yields for the relevant themes) — the same providers used by the paid offerings — and asks Gemini for grounded web research with citations. At least two independent sources must respond or the cycle aborts without posting.
4. **Synthesis and validation.** Gemini writes the thread (Groq is the JSON fallback). Every number in the draft must appear in the live research payload (0.5% rounding tolerance); invented numbers, handles or links fail validation and the draft is regenerated once with feedback, then discarded. A deterministic "Market snapshot" tweet with real metrics is inserted between the hook and the analysis.
5. **Publishing.** The thread is posted as a reply chain via the X API v2. Rate limits and network failures are logged and recorded in state; a partial thread keeps the tweets that were published. Posting is never retried automatically, so a timeout cannot duplicate a tweet.

**Credentials.** Publishing needs a user context; the app-only `TWITTER_BEARER_TOKEN` used for reading cannot post. Either OAuth 1.0a (`X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`) or an OAuth 2.0 user access token (`X_BEARER_TOKEN` / `X_USER_ACCESS_TOKEN`, e.g. issued through a Virtuals X OAuth connection) enables it. When both families are configured and one answers 401/403, the other is tried automatically before the pitch is reported as failed. Fallback names are accepted too: `X_API_KEY`, `X_API_SECRET`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`/`TWITTER_ACCESS_SECRET` and `TWITTER_USER_ACCESS_TOKEN`. The OAuth 1.0a header is signed locally with HMAC-SHA1. `GET /api/social` reports each missing credential slot without printing any secret.

**Operating it:**

- `GET /api/social` — schedule, last post, next run, recent results. `?verify=1` also calls `GET /users/me` to confirm the posting account.
- `GET /api/cron/social` — runs one cycle when due (requires `CRON_SECRET`; `?force=1` bypasses the interval and daily cap, not the idle gate).
- Long-running hosts (`npm start`) run an unref'd interval loop; Vercel drives the cycle through four daily cron slots.
- `npm run social:preview` generates a real thread from live data and prints it without posting.

Social failures are contained: the loop catches everything, records `lastError`, and never throws into Express or the ACP pipeline. A publishing backlog simply retries on the next tick.

### Swap principal and wallet safety

The agent never risks its own principal by default:

- ERC20 sells require the ACP client to approve the agent wallet (`token.approve(agent, amount)`) so funds can be pulled with `transferFrom`. If the allowance is missing, the job fails **before** any swap with an actionable `402 INSUFFICIENT_ALLOWANCE`.
- Native ETH sells are rejected unless `ALLOW_AGENT_FUNDED_SWAPS=true`, because a fee-sized escrow cannot collateralize a large native swap.
- Fee-on-transfer sells are detected; the agent returns the received tokens to the client and fails the job.
- Unused funds from a failed composite route are returned to the client.
- Donations are the only agent-fronted flow: the full escrow amount is forwarded, and the agent is reimbursed when the job completes.

## API

All responses are JSON with CORS `Access-Control-Allow-Origin: *`. Unhandled errors return a structured `{ success: false, error: { code, message, details? } }` body with the correct HTTP status.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` or `/api` | Service metadata and endpoint map |
| GET | `/api/health` | RPC, ACP escrow, USDC balance, KyberSwap, Virtuals router, wallet, AI engines, intelligence data providers (CoinGecko/GeckoTerminal/Binance/DefiLlama), job intake, A2A, outreach, inbound inbox, store durability, and per-offering readiness. Always HTTP 200; `ready` reflects production readiness. |
| GET | `/api/offerings` | Published offerings and schemas |
| GET | `/api/offerings/:id` | One offering |
| GET | `/api/custom` | `custom_task` contract: tier prices, brief length limits, Groq/Gemini routing rule and the exact order envelope |
| GET | `/api/pricing` | Live tier table, happy-hour window, Base gas, referral terms |
| POST | `/api/quote` | Issue a stored, bound quote (happy hour / performance) and return the ACP description (API key) |
| GET | `/api/revenue` | Revenue cycle state, pricing, subscriptions, referral queue (API key) |
| GET | `/api/revenue/subscriptions` | Retainer subscriptions (API key) |
| GET | `/api/revenue/referrals` | Referral commissions and payouts (API key) |
| GET/POST | `/api/cron/revenue` | Run one revenue cycle: scans, retainer delivery, referral payouts, bounty pitch (requires `CRON_SECRET`) |
| GET | `/api/acp` | POST contract documentation and status codes |
| POST | `/api/acp` | Execute a funded ACP job |
| GET | `/api/chat` | Chat contract documentation |
| POST | `/api/chat` | Natural-language preview/execution (API key, or the boss passcode inside `message`) |
| GET | `/api/jobs/:jobId` | Local job record (`?onchain=1` adds the live ACP state) |
| GET | `/api/intake` | Job intake status: enabled, cursor, interval, last pass and recent outcomes |
| GET/POST | `/api/cron/sweep` | Refund/close stale jobs (Vercel Cron calls this) |
| GET/POST | `/api/cron/intake` | Run one on-chain job discovery pass (requires `CRON_SECRET`; `?reason=` labels the run) |
| GET | `/api/social` | Autonomous publishing status (`?verify=1` checks the X account) |
| GET/POST | `/api/cron/social` | Run one publishing cycle when due (requires `CRON_SECRET`, `?force=1` allowed) |
| GET | `/api/a2a/inbox` | Inbound A2A log: totals, 24 h counts, actions and the ten most recent messages (API key) |
| GET | `/api/outreach` | Discovery/outreach status: enabled, caps, pitches today, last attempt/error, opt-outs (API key, `?secret=<CRON_SECRET>` or `?passcode=<BOSS_PASSCODE>`; `&run=1` fires an immediate sweep) |
| GET/POST | `/api/cron/outreach` | Run one discovery and pitching cycle (requires `CRON_SECRET` by header or `?secret=`, `?force=1` bypasses the interval only) |
| GET | `/.well-known/agent.json` | A2A v0.3 agent card |
| GET | `/.well-known/agent-card.json` | A2A v1.0 agent card |
| GET | `/a2a` | A2A endpoint description and supported methods |
| POST | `/a2a` | A2A JSON-RPC 2.0 (`message/send`, `SendMessage`, `tasks/get`, `GetTask`) |

### `POST /api/acp`

```json
{
  "jobId": "12345",
  "offeringId": "token_swap",
  "params": {
    "sellToken": "USDC",
    "buyToken": "WETH",
    "amount": "10",
    "maxSlippage": 3
  }
}
```

Success (HTTP 200):

```json
{
  "success": true,
  "status": "completed",
  "jobId": "12345",
  "offering_id": "token_swap",
  "price": { "amount": "0.025", "currency": "USDC", "units": "25000" },
  "result": {
    "venue": "kyberswap",
    "txHash": "0x…",
    "explorer": "https://basescan.org/tx/0x…",
    "amountOut": "…",
    "recipient": "0x…"
  },
  "deliverableHash": "0x…",
  "settlement": { "submitted": true, "submitTxHash": "0x…" },
  "acp": { "protocol": "virtuals-acp", "jobId": "12345", "status": "completed" }
}
```

A failed execution still returns HTTP 200 with `success: false` and a `refund` object, so ACP clients always receive a deterministic completion payload. Validation and escrow errors use 4xx statuses (`402 ESCROW_NOT_FUNDED`, `403 BUYER_MISMATCH`, `409 INVALID_JOB_STATE`, …).

Two optional fields extend the body: `quoteId` (a `/api/quote` id; the escrow minimum is the quoted price) and `referrer` (a partner wallet that receives the referral commission after the job completes). The same fields may also travel inside the ACP job description for autonomous intake. Referral records are idempotent and only pay after the job is `COMPLETED` on-chain.

### `POST /api/chat`

Read-only previews are free:

```json
{ "message": "swap 10 USDC to WETH with slippage 3%" }
```

The response contains the parsed intent, an engine tag (`rules`, `groq`, `gemini`, or `fallback`), and a live preview (KyberSwap quote, resolved tokens, allowance status, donation shares). Intelligence offerings return `action: "preview_intelligence"` with provider availability only — the report itself is generated after escrow funding. Set `"execute": true` together with a funded `jobId` to run the job; without a jobId the request returns `402 ESCROW_REQUIRED` unless `ALLOW_UNPAID_EXECUTION=true` (development only).

Groq is the primary intent engine with Gemini as fallback. When neither key is configured, a deterministic rule parser handles the documented patterns and everything else returns help text. The model receives the user message as untrusted JSON data and can only produce offering IDs from the published list. Deterministic routing covers news, trends, sentiment, research, yields, token metrics, KOL and trade-analysis phrasing, so those requests work even without an AI key at parse time.

### Chat, boss passcode and admin commands

`POST /api/chat` has four response shapes, decided in this order:

| Response | When | What it does |
| --- | --- | --- |
| `preview` / `completed` | The message matches one of the 50 ACP offerings | Unchanged paid flow: preview first, execution only with a funded `jobId`. |
| `boss_verified` / `boss_discovery` / `boss_status` | The message contains the boss passcode | Admin path, outside the escrow flow. |
| `chat` | Nothing matched and no passcode was given | A normal conversational answer from Groq, with Gemini as fallback, plus a compact `capabilities` summary instead of the 50-item list. |
| `admin_required` | An admin command was requested without the passcode | The reply tells the operator to enter the secret passcode first. |

**Who may call it.** When `API_KEY` is set, `POST /api/chat` accepts it as `x-api-key` or `Authorization: Bearer`, **or** the boss passcode inside `message` — that is how an operator commands the agent from a plain chat client with no header support. The key-free public surface is `POST /a2a` (and `GET /.well-known/agent-card.json`), which runs the same intent engine, the same session negotiation and the same `custom_task` quoting, and is preview-only until escrow verifies a funded job. Point the Virtuals chat URL at `/a2a`, or send the key with the request if the platform lets you configure a header.

**Boss passcode.** `BOSS_PASSCODE` is checked against the whole message with a constant-time comparison; it is never echoed back in a reply, a log line or an error. A verified message returns the boss acknowledgement and asks which task to initiate on Virtuals Protocol. The verification is remembered per operator for `BOSS_SESSION_TTL_SECONDS` (default 1800) so the next command does not need the code again; ordinary offering requests are never affected by that session.

**Boss passcode.** `BOSS_PASSCODE` (default `03210388`) is checked against the whole message with a constant-time comparison; it is never echoed back in a reply, a log line or an error. A message that contains the passcode returns the boss acknowledgement and asks which task to initiate on Virtuals Protocol — and a message that is *just* the passcode goes one step further: it verifies the boss session and immediately runs outbound agent discovery. The verification is remembered per operator for `BOSS_SESSION_TTL_SECONDS` (default 1800) so the next command does not need the code again; ordinary offering requests are never affected by that session. Passcodes shorter than 8 characters cannot stand in for the API key (`403 BOSS_PASSCODE_TOO_WEAK`).

**Outbound agent discovery.** `<BOSS_PASSCODE> start outbound agent discovery` (or any equivalent phrasing) runs the outreach cycle directly with `reason: "boss"` and `force: true`, bypassing the 50-offering preview/escrow format, and returns the cycle summary: candidates scanned, contactable, eligible, pitched, skipped. Sending the passcode by itself does the same — one bare-passcode message starts the sweep. `<BOSS_PASSCODE> status` returns the live outreach and pipeline state. The browser equivalent is `GET /api/outreach?passcode=<BOSS_PASSCODE>&run=1` (or `?secret=<CRON_SECRET>&run=1`), which fires an immediate sweep the same way; without `run=1` the route only reports status.

**General conversation.** Anything that matches no offering is answered by `askText` in `src/services/ai.js`: Groq first, Gemini whenever Groq is unconfigured or fails. The response carries a compact capability summary (category counts, example requests and a pointer to `GET /api/offerings`); the full catalog is still returned when the message explicitly asks for it, for example `list offerings`.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Notes |
| --- | --- | --- |
| `AGENT_NAME` / `AGENT_SLUG` | Optional | Public identity and internal slug. Defaults to `Hyper Agent X7733` / `hyper-agent-x7733`; reported by `/api` and `/api/health`. |
| `AGENT_PRIVATE_KEY` | Yes | 0x-prefixed 32-byte key. Provider wallet identity and all transactions. |
| `BASE_RPC_URL` | Recommended | Defaults to `https://mainnet.base.org`; use Alchemy/QuickNode/CDP for production throughput. |
| `GROQ_API_KEY` / `GEMINI_API_KEY` | Required for intelligence | Groq (`qwen/qwen3.8-27b`, `GROQ_MODEL`) handles fast JSON intent and execution-time briefs; Gemini (`gemini-3.8-flash`, `GEMINI_MODEL`) handles Google Search grounding and is primary for article generation. Each engine falls back to the other automatically. The ten original intelligence offerings require at least one key (`503 AI_NOT_CONFIGURED` otherwise); the eighteen zero-gas insight offerings deliver deterministic data even when both engines are down. |
| `GROQ_MAX_OUTPUT_TOKENS` | Optional | Per-request Groq output cap, default 1000. The Groq service tier rejects larger requests, so long briefs continue on Gemini. |
| `BOSS_PASSCODE` | Required for headerless admin | Admin passcode for `/api/chat` (default `03210388`). A message containing it answers with the boss acknowledgement and authenticates the request in place of `x-api-key`; a bare passcode message immediately runs outbound agent discovery. It also unlocks `GET /api/outreach?passcode=<value>` (add `&run=1` to fire a sweep). Must be 8+ characters to stand in for the API key. Never echoed back. |
| `BOSS_SESSION_TTL_SECONDS` | Optional | How long a verified passcode keeps the admin commands unlocked for the same operator, default 1800 (60–86400). |
| `COINGECKO_API_KEY` | Optional | Raises CoinGecko rate limits; public API works keyless. |
| `NEWS_FEEDS` | Optional | Comma-separated RSS feeds. Defaults to CoinDesk, The Block, Decrypt and CryptoSlate. |
| `TWITTER_BEARER_TOKEN` / `KOL_HANDLES` | Optional | Enables live X API posts for `twitter_alpha` / `kol_alpha`; without them those offerings use Gemini grounding citations. |
| `DATA_TIMEOUT_MS` / `GROUNDING_TIMEOUT_MS` / `NEWS_TIMEOUT_MS` | Optional | Per-provider timeouts (defaults 9 s / 20 s / 7 s). |
| `INTEL_CACHE_TTL_MS` | Optional | Shared provider cache TTL (default 45 s). |
| `MIN_YIELD_TVL_USD` / `MIN_TOKEN_LIQUIDITY_USD` | Optional | Quality floors for yield pools and token liquidity. |
| `SOCIAL_AUTOPOST` | Optional | `true` by default. Set `false` to pause autonomous publishing (requires AI + X credentials). |
| `SOCIAL_INTERVAL_MINUTES` | Optional | Publish cadence, default 300 (5 h), bounded 240–1440. |
| `SOCIAL_MAX_POSTS_PER_DAY` | Optional | Hard daily cap (default 4). |
| `X_USER_ACCESS_TOKEN` / `X_BEARER_TOKEN` | For posting (preferred) | OAuth 2.0 user-context token with `tweet.write` scope. Tried first on every post; `TWITTER_USER_ACCESS_TOKEN` is an accepted alias. `X_BEARER_TOKEN` must have `tweet.write` (an app-only bearer cannot post). |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REFRESH_TOKEN` | For posting (preferred) | OAuth 2.0 confidential client ("Web App, Automated App or Bot"). On a 401/403 the agent calls `POST /2/oauth2/token` with `grant_type=refresh_token` and retries with the minted access token (cached and persisted). X rotates the refresh token on every mint, so the rotated token is also persisted and preferred on later refreshes — the env token is only the starting point. `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` / `TWITTER_OAUTH2_REFRESH_TOKEN` are accepted aliases. |
| `X_AUTO_UPGRADE` / `X_AUTO_UPGRADE_THRESHOLD_USD` | Optional | Auto-upgrade rule (default `true` / `100`). X stays on the free tier while the agent pitches over A2A; once the payout wallet's USD balance reaches the threshold (cheapest paid X plan = Basic $100/month), the trigger is recorded and surfaced under `xAutoUpgrade` in `GET /api/outreach` so the operator can flip the plan in the X developer portal. X pitching resumes automatically after that. |
| `X_CONSUMER_KEY` / `X_CONSUMER_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | For posting (fallback) | OAuth 1.0a credentials, tried only after the OAuth 2.0 paths are rejected with 401/403. `X_API_KEY`/`X_API_SECRET`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN` and `TWITTER_ACCESS_TOKEN_SECRET` are accepted fallback names. |
| `API_KEY` | Recommended | When set, `POST /api/acp`, `POST /api/quote`, `GET /api/a2a/inbox` and the `GET /api/revenue*` endpoints require `x-api-key` or `Authorization: Bearer` (a query string is never accepted on these). `POST /api/chat` also accepts the `BOSS_PASSCODE` in the message; `GET /api/outreach` and `POST /api/outreach/start` also accept `?secret=<CRON_SECRET>` or `?passcode=<BOSS_PASSCODE>`. |
| `CRON_SECRET` | Required for cron | Vercel sends `Authorization: Bearer $CRON_SECRET` to cron requests; other schedulers and the agent's own outreach wake-up send `x-cron-secret`, and a browser or any scheduler may use `?secret=<CRON_SECRET>` on `/api/cron/*` and on `GET /api/outreach`. That query value is accepted there and nowhere else, and the request log stores the path without its query. There is no built-in fallback secret: without it `/api/cron/sweep`, `/api/cron/intake`, `/api/cron/social`, `/api/cron/outreach` and `/api/cron/revenue` return 503 and `wakeOutreachCycle()` skips the call. |
| `ACP_API_KEY` | Optional | Bearer token for the Virtuals ACP API (`/agents`). Also used as the default token for the optional authenticated outreach index. Public directory, registry, on-chain and allowlist discovery work without it. |
| `UPSTASH_REDIS_REST_URL` / `TOKEN` | Required on Vercel | Durable job records, distributed locks, shared rate limits. Memory fallback is not reliable across serverless instances. |
| `ACP_CONTRACT_ADDRESS` | Optional | Defaults to the official Base escrow. |
| `ACP_AGENT_ID` | Optional | Shown in metadata/logs. |
| `MIN_ESCROW_WINDOW_SECONDS` | Optional | Reject jobs expiring too soon (default 90). |
| `DEFAULT_SLIPPAGE_BPS` | Optional | Default 300 (3%), clamped to 10–2000. |
| `SLA_SECONDS` | Optional | Default 120. |
| `ALLOW_AGENT_FUNDED_SWAPS` | Optional | `false` by default. Enables native sells and agent-balance funded ERC20 sells for trusted clients. |
| `ALLOW_UNPAID_EXECUTION` | Optional | Development-only bypass of escrow in `/api/chat`. |
| `ACP_INTAKE_ENABLED` | Optional | `true` by default. Disables the on-chain job poller (and `/api/cron/intake` does nothing) when `false`. |
| `ACP_INTAKE_INTERVAL_SECONDS` | Optional | Local loop cadence, default 60 (bounded 15–3600). Ignored on Vercel, where cron drives the poller. |
| `ACP_INTAKE_BATCH` | Optional | Executions per pass, default 3 (1–25). Keep small so one pass fits the 60 s function limit. |
| `ACP_INTAKE_SCAN_LIMIT` | Optional | Job ids scanned per pass, default 40 (1–500), read in multicall chunks of 25. |
| `ACP_INTAKE_BUDGET_MS` | Optional | Wall-clock budget per pass, default 45000 (5000–55000). Remaining jobs are deferred. |
| `ACP_INTAKE_START_ID` | Optional | First job id to scan on a fresh deployment. Default 0 anchors the cursor at the current `jobCounter()` head instead of replaying history. |
| `A2A_ENABLED` | Optional | `true` by default. Set `false` to disable `/a2a` and the agent cards. |
| `OUTREACH_ENABLED` | Optional | `true` by default. Drives outbound discovery and pitching once `PUBLIC_BASE_URL` is configured or a trusted deployment URL is observed from the first inbound request. Set `false` to disable entirely. |
| `OUTREACH_INTERVAL_SECONDS` / `OUTREACH_BUDGET_MS` | Optional | Local loop cadence (default 600, bounded 120–3600) and per-cycle wall-clock budget (default 40000, 10000–50000). |
| `OUTREACH_DAILY_CAP` / `OUTREACH_MAX_TARGETS` | Optional | Pitches per UTC day (default 20 — maxed for aggressive micro-earning, 1–20) and targets per cycle (default 5, 1–5). |
| `OUTREACH_MIN_SCORE` / `OUTREACH_COOLDOWN_HOURS` | Optional | Minimum targeting score (default 10, 0–100 — low gate so micro-value targets still get pitched) and per-target cooldown (default 24 h, 6–720). |
| `OUTREACH_SCAN_JOBS` | Optional | Recent on-chain jobs sampled for candidate discovery, default 60 (10–200). |
| `OUTREACH_INDEX_URL` / `OUTREACH_INDEX_TOKEN` | Optional | Optional authenticated agent-index endpoint (default ACP `/agents`) and its bearer token (falls back to `ACP_API_KEY`). |
| `OUTREACH_INDEX_URLS` | Optional | Comma-separated alternative agent-directory feeds. Every URL is swept in parallel with `OUTREACH_INDEX_URL` each cycle (any JSON array or `{data:[...]}`/`{agents:[...]}` shape with `name`/`url`/`walletAddress` fields); a failing feed never stops the others. Point it at any public agent directory or platform feed to widen outbound discovery. |
| `BOUNTIES_SCAN` / `BOUNTIES_QUERY` / `BOUNTIES_MAX` / `BOUNTIES_TTL_SECONDS` | Optional | Direct-earning bounty radar: toggle (default `true`), GitHub search query (default `label:bounty is:issue is:open`), max surfaced matches (default 6, max 15), and scan-cache lifetime in seconds (default 21600). |
| `GITHUB_TOKEN` / `BOUNTIES_EXECUTE` | Optional | Fine-grained GitHub PAT enabling autonomous claim + PR submission (default execute `true` when a token is present). |
| `BOUNTIES_STAR_ON_CLAIM` / `BOUNTIES_MAX_OPEN_PRS` / `BOUNTY_PAYOUT_WALLET` | Optional | Star policy repos on claim (default `true`), concurrent open-PR cap (default 3), and the wallet named in every PR for payout routing. |
| `BOUNTIES_MIN_REPO_AGE_DAYS` / `BOUNTIES_MIN_STARS` | Optional | Anti-scam verification gates before any GitHub write (defaults 30 days / 1 star). |
| `OUTREACH_DIRECTORY_URL` / `OUTREACH_REGISTRY_URL` | Optional | Keyless public Virtuals directory (default `https://acpx.virtuals.io/api/agents`) and ACP registry base (default `https://api.acp.virtuals.io/agents`). |
| `OUTREACH_DIRECTORY_LIMIT` / `OUTREACH_DIRECTORY_PAGES` / `OUTREACH_DIRECTORY_MAX_PAGES` | Optional | Directory page size (default 100, the provider maximum), consecutive pages per cycle (default 4, max 4) and the fallback sweep bound in pages (default 900) used until the directory's own reported page count takes over. |
| `OUTREACH_DIRECTORY_SWEEP` | Optional | Mass directory sweep toggle (default `false`). The sweep collected hundreds of X-only agents that can never be pitched while X is frozen, and those dead-channel candidates crowded the few A2A-reachable targets out of the scored head — so cycles collected data but sent zero pitches. With it off, discovery focuses on sources that publish a verifiable A2A endpoint (index, on-chain registry, allowlist); candidate selection keeps only live-channel targets and ranks A2A first, so the cycle actually submits pitches. A cycle that finds candidates but no live channel reports `NO_LIVE_CHANNEL`. Set `true` to resume the full sweep. |
| `OUTREACH_MAX_CANDIDATES` / `OUTREACH_CARD_PROBES` | Optional | Scored candidates examined per cycle (default 40) and agent cards probed in parallel for a live A2A endpoint (default 32). Both bound the work inside one cycle; neither bounds how much of the directory the sweep reaches. |
| `OUTREACH_X_PITCH` | Optional | X mentions for directory agents without A2A endpoints (default `true`). |
| `OUTREACH_TARGETS` / `OUTREACH_KEYWORDS` | Optional | Comma-separated public HTTPS A2A cards/URLs to contact, and extra targeting keywords. |
| `OUTREACH_SESSION_TTL_SECONDS` / `OUTREACH_EXTENSION_SECONDS` / `OUTREACH_MAX_TURNS` | Optional | Five-minute session cap (default 300, 120–600), one justified extension (default 120 s), and turn cap (default 6). |
| `OUTREACH_PRICE_MULTIPLIER` / `OUTREACH_MAX_PRICE_USDC` | Optional | Complexity multiplier (default 1, 0.5–3) and maximum quoted price (default 0.075 USDC). Quotes never go below list. |
| `OUTREACH_CARD_TIMEOUT_MS` / `OUTREACH_SEND_TIMEOUT_MS` | Optional | A2A card fetch (default 6 s) and outbound send (default 9 s) timeouts. |
| `CUSTOM_TASK_ENABLED` | Optional | `true` by default. Turns the beyond-catalogue ask, the `custom_task` order id and the inbound quote path on or off. |
| `CUSTOM_TASK_BASE_PRICE_USDC` / `CUSTOM_TASK_MAX_PRICE_USDC` | Optional | Tier-1 price (default 0.01 — micro-cent clients stay in scope) and the hard ceiling (default 0.5). Tiers 2–5 are 1.5×/2×/2.5×/3× the base. |
| `CUSTOM_TASK_MIN_CHARS` / `CUSTOM_TASK_MAX_CHARS` | Optional | Accepted brief length (default 24–600 characters). |
| `CUSTOM_TASK_DEEP_THRESHOLD` / `CUSTOM_TASK_BUDGET_MS` | Optional | Complexity at which Gemini is preferred even without a deep signal (default 4) and the AI time budget for one brief (default 40 s). |
| `REVENUE_ENABLED` | Optional | `true` by default. Enables the local revenue loop. `/api/cron/revenue` still runs when the loop is off. |
| `REVENUE_INTERVAL_SECONDS` / `REVENUE_BUDGET_MS` | Optional | Local cycle cadence (default 300, bounded 120–3600) and wall-clock budget (default 45000, 10000–55000). |
| `DONATION_SERVICE_MARGIN_BPS` | Optional | Service margin retained from donation escrow, default 2000 (20%), clamped to 2000–5000. |
| `ONCHAIN_UNLOCK_MIN_USD` | Optional | USD worth of ETH the wallet must hold before the six on-chain offerings ungate, default 0.75 (clamped 0.10–10.00). |
| `ETH_USD_FALLBACK` | Optional | ETH/USD rate used when the live CoinGecko price cannot be fetched, default 3000 (clamped 100–100000). |
| `QUOTE_TTL_SECONDS` | Optional | Quote lifetime, default 900 (120–3600). |
| `REFERRAL_BPS` / `REFERRAL_MAX_USDC` | Optional | Commission rate (default 700 bps, 500–1000) and per-job cap (default 10 USDC). |
| `REFERRAL_MIN_JOB_AGE_SECONDS` / `REFERRAL_RESERVE_USDC` | Optional | Wait before the first payout attempt (default 120 s) and USDC kept in the wallet (default 1). |
| `HAPPY_HOUR_START_UTC` / `HAPPY_HOUR_END_UTC` / `HAPPY_HOUR_DISCOUNT_BPS` | Optional | UTC discount window (default 0–6) and discount rate (default 1500 bps, max 2500). |
| `HAPPY_HOUR_GAS_DISCOUNT_BPS` / `HAPPY_HOUR_MAX_GWEI` | Optional | Extra discount (default 500 bps) when gas is at or below `HAPPY_HOUR_MAX_GWEI` (default 0.02). Combined discount is capped at 3000 bps. |
| `WHALE_LOOKBACK_BLOCKS` / `WHALE_MIN_USDC` / `WHALE_MIN_WETH` | Optional | Transfer-log window (default 40 blocks, 10–1000) and thresholds (default 250,000 USDC / 100 WETH). |
| `ARBITRAGE_MIN_SPREAD_BPS` / `ARBITRAGE_MIN_LIQUIDITY_USD` | Optional | Spread floor (default 40 bps, 5–2000) and pool liquidity floor (default 50,000 USD). |
| `ANOMALY_LIQUIDITY_DROP_PCT` / `ANOMALY_PRICE_DROP_PCT` | Optional | Anomaly thresholds between snapshots (default 25% / 15%). |
| `REVENUE_SCAN_POOLS` | Optional | Base pools scanned per pass, default 12 (3–30). |
| `SECURITY_MIN_LIQUIDITY_USD` | Optional | Liquidity floor used by token security and liquidation scoring, default 25,000 (min 1,000). |
| `NEW_POOL_LOOKBACK_HOURS` / `NEW_POOL_MIN_LIQUIDITY_USD` | Optional | Default new-pool age window (48 h, 1–168) and liquidity floor (25,000 USD). |
| `SMART_MONEY_MIN_USD` / `SMART_MONEY_LOOKBACK_BLOCKS` | Optional | Smart-money USD threshold (default 50,000) and Base block window (default 40, 10–200). |
| `BENCHMARK_SCAN_JOBS` / `JOB_RADAR_SCAN_JOBS` | Optional | Recent ACP jobs sampled by the provider benchmark (default 150, 25–400) and job radar (default 100, 20–300). |
| `RETAINER_MAX_DELIVERIES_PER_DAY` / `RETAINER_SEND_TIMEOUT_MS` | Optional | Global daily retainer push cap (default 2, 1–6) and per-push timeout (default 9 s). |

## Run locally

```bash
npm install
npm run build          # resolves imports, rejects cycles/stubs, validates vercel.json
npm test               # unit tests (offerings, intents, AI routing, TA, RSS, sentiment, social, store locks, intake parsing, A2A, discovery/outreach, pricing/quotes/referrals/revenue scans)
npm run verify         # live read-only Base/ACP/Kyber/Virtuals/data-provider checks
npm run social:preview # generate a real X thread from live data, print only
npm start              # http://localhost:3000 (intake loop starts after 15 s)
```

`npm run verify` signs nothing. It checks chain ID, ACP bytecode, payment token, escrow USDC balance, the job counter, a live KyberSwap quote, the Virtuals router asset token, token resolution, and live intelligence providers (CoinGecko, GeckoTerminal, Binance futures, RSS feeds, DefiLlama). Set `VERIFY_BASE_URL` to also exercise the deployed health/offerings/chat (including an intelligence preview)/ACP endpoints, the A2A agent card, a `POST /a2a` hello, `/api/intake`, `/api/a2a/inbox`, `/api/outreach`, `/api/pricing`, `/api/quote` and `/api/revenue` (the protected ones with `API_KEY`).

## Deploy to Vercel

1. Push this directory to a Git repository.
2. Import it in Vercel (framework preset: **Other**). `vercel.json` disables backend-framework auto-detection, rewrites every path to the `api/index.js` function (`/api/index`), allows 60 seconds per invocation and uses Vercel's default memory allocation. The build command is `npm run build`, which fails the deployment on unresolved imports, circular dependencies, mock/stub code, or an invalid cron/rewrite manifest.
3. Add the environment variables above (at minimum `AGENT_PRIVATE_KEY`, `BASE_RPC_URL`, `UPSTASH_*`, `CRON_SECRET`, `API_KEY`, and one AI key).
4. Deploy, then confirm:
   - `GET https://<app>.vercel.app/api/health` → HTTP 200, `ready: true`
   - `GET https://<app>.vercel.app/api/offerings` → 50 offerings
   - `POST https://<app>.vercel.app/api/chat` with `{"message":"resolve USDC WETH"}` → preview
   - `POST https://<app>.vercel.app/api/chat` with `{"message":"what's trending in crypto"}` → `preview_intelligence`
   - `GET https://<app>.vercel.app/.well-known/agent-card.json` → agent card with 50 skills
   - `GET https://<app>.vercel.app/api/intake` → `cursor` is set after the first `jobCounter()` read
5. Optional: fund the agent wallet with a few dollars of Base ETH to unlock the six on-chain offerings once it crosses `ONCHAIN_UNLOCK_MIN_USD`. The 44 zero-gas offerings earn without any wallet balance.
6. Run `VERIFY_BASE_URL=https://<app>.vercel.app npm run verify`.

### Zero-touch outbound activation

Nothing has to be run from a terminal after the deployment exists. With `PUBLIC_BASE_URL`, `CRON_SECRET`, an AI key and the wallet key set, the chain is:

1. The first inbound request — a Virtuals probe, an agent-card fetch, a peer reply — reaches `observePublicUrl` in the global middleware in `src/app.js`.
2. Because the URL is newly configured or newly observed, `observePublicUrl` reports `changed: true` and the middleware calls `wakeOutreachCycle(url, { reason: "activation" })`, which fetches `GET /api/cron/outreach?reason=activation&force=1` with `x-cron-secret` on this deployment.
3. That wake runs `runOutreachCycle` inside its own serverless invocation: intake cursor bootstrap → directory sweep (4 parallel pages of 100, persisted cursor) → score → eligible candidates → teaser → analysis → pitch over A2A or X → session save. `force=1` bypasses only the 10-minute interval, never the daily cap, the 72-hour cooldown, the opt-out set or the lock.
4. From then on the four cron slots plus `maybeWakeOutreach` on inbound traffic keep the cycle running, and each cycle advances the directory cursor, so discovery continues across the whole network without an operator.

Without `PUBLIC_BASE_URL`, activation waits for the first request on a trusted `*.vercel.app` host — the same runtime path, just observed instead of configured. Every redeploy re-arms this wake: the deployment marker (`VERCEL_GIT_COMMIT_SHA` / `VERCEL_DEPLOYMENT_ID`) is stored with the activation, so the first request after a new deploy re-fires the self-wake and kicks off discovery even when the public URL did not change. `CRON_SECRET` is mandatory: every cron route fails closed with 503 when it is missing, so an unset secret means no outreach rather than an open endpoint. `ALLOW_UNPAID_EXECUTION` is ignored on Vercel and when `NODE_ENV=production`, so a deployed agent cannot execute an unfunded job.

**To fire a sweep yourself, from a browser:** open `https://<app>.vercel.app/api/cron/outreach?secret=<CRON_SECRET>&force=1`. No headers, no terminal, and the reply is the full cycle summary. `https://<app>.vercel.app/api/outreach?secret=<CRON_SECRET>` reads the same state without running anything, and `https://<app>.vercel.app/api/outreach?passcode=<BOSS_PASSCODE>&run=1` fires the sweep the same way. **From chat:** `POST /api/chat` with `{"message":"<BOSS_PASSCODE> start outbound agent discovery"}` and no `x-api-key` — or send `{"message":"<BOSS_PASSCODE>"}` alone, which verifies the boss session and starts discovery immediately.

### Vercel Cron plan limits

`vercel.json` schedules the sweeper daily (`0 0 * * *`) because Hobby projects cannot run more frequent crons. On Pro, change it to `*/10 * * * *` for faster refund retries. The sweeper also runs opportunistically when stale refunds are encountered.

The intake cron is daily at `0 0 * * *` for the same reason. **Autonomy is limited by that schedule on Hobby:** a funded job waits up to a day before it is picked up. On Pro (or any host where you can call the endpoint), schedule `*/2 * * * *` or `* * * * *` and keep `ACP_INTAKE_BATCH` low enough for the 60 s limit. Any external scheduler can also call `GET /api/cron/intake` with `Authorization: Bearer $CRON_SECRET`; the distributed lock makes overlapping triggers harmless. Local `npm start` is not affected and polls every 60 s.

The social cron has four individually daily Hobby-compatible slots: `0 6 * * *`, `0 12 * * *`, `0 18 * * *` and `0 23 * * *`. `SOCIAL_INTERVAL_MINUTES` throttles duplicate runs, so these triggers cannot exceed the configured cadence or daily cap. For a different cadence, point an external scheduler at `GET /api/cron/social` with `Authorization: Bearer $CRON_SECRET`.

The outreach cron likewise has four individually daily slots: `0 2 * * *`, `0 8 * * *`, `0 14 * * *` and `0 20 * * *`, plus the immediate activation wake-up after the Virtuals chat URL starts receiving requests. On Pro, use `*/10 * * * *` for the intended 10-minute cadence; on any host, an external scheduler can call `GET /api/cron/outreach` with the same bearer token. The interval throttle, daily cap, cooldown, opt-out set and distributed lock all still apply, so more frequent triggers cannot send more messages than configured. `npm start` runs the loop locally.

The revenue cron is scheduled daily at `0 3 * * *`. That covers retainer delivery and referral retries, but arbitrage/whale detection is only useful near real time. For the intended cadence on Vercel, use a Pro project and set `*/5 * * * *`, or point an external scheduler at `GET /api/cron/revenue` with the bearer token. The distributed lock and interval throttle prevent overlapping cycles; `REVENUE_BUDGET_MS` keeps each run inside the function limit. `npm start` runs the loop every `REVENUE_INTERVAL_SECONDS` (default 300).

### Linking to Virtuals ACP

1. Register **Hyper Agent X7733** (`hyper-agent-x7733`) in the Virtuals ACP dashboard and set the provider wallet to the `AGENT_PRIVATE_KEY` address. Keep `AGENT_NAME`/`AGENT_SLUG` matching the registration so `/api` and `/api/health` report the same metadata.
2. Register the fifty offerings with the exact IDs and USDC prices above.
3. Use the deployed base URL for the agent's service endpoints. The Virtuals verifier can call:
   - `GET /api/health`
   - `POST /api/chat`
   - `POST /api/acp`
   - `GET /.well-known/agent.json` (A2A v0.3) and `GET /.well-known/agent-card.json` (v1.0)
   - `POST /a2a`
4. Set `PUBLIC_BASE_URL` to the deployed URL, especially when using a custom domain. KyberSwap requests carry it as their origin, and the A2A cards publish it as the agent URL. Without it, the agent can learn its public URL from the first inbound request on a trusted Vercel deployment host after the chat URL is saved; that first request also wakes an immediate outreach cycle. There is no dashboard webhook, so activation cannot happen before Virtuals first calls the agent.
5. For fully autonomous execution, enable the intake cron at a useful cadence (see the plan limits above) or point an external scheduler at `/api/cron/intake`. Jobs created through the ACP dashboard must put the order in the description using one of the documented shapes; prose descriptions are skipped, not executed.

## Operational notes

- **Serverless timing:** executions are bounded by `TX_TIMEOUT_MS` (45 s) and the 60 s function limit. If an invocation is killed mid-flight, the stored record stays `processing`; the sweeper refunds it after 10 minutes.
- **Receipt timeouts:** a broadcast transaction that is not confirmed in time is re-checked against its receipt hash before any retry, so a late confirmation never causes a double spend.
- **Nonces:** every transaction is serialized through a shared wallet lock and sent with an explicit pending nonce.
- **Escrow refunds:** the agent never sends its own USDC as a refund. Refunds happen by rejecting/expiring the ACP job, so the client is made whole by the escrow contract exactly once.
- **Rate limiting:** 30 requests/minute per IP by default (`RATE_LIMIT_PER_MINUTE`), shared through Upstash when configured.
- **Health caching:** health results are cached for 25 seconds and single-flighted; use `?refresh=1` to force a fresh probe.
- **Donation counterparty risk:** donation offerings forward USDC immediately after escrow verification, before the job is completed. A client who refuses to complete (or whose evaluator never settles) can claim the escrow refund while the project keeps the donation. Exposure is capped at the per-job donation amount. Register a reliable evaluator or enable automatic completion for these offerings, and monitor jobs that stay `SUBMITTED` on-chain.
- **Ambiguous transactions:** if a transaction is broadcast but its receipt cannot be observed, the agent deliberately does not retry or auto-return funds. The job fails, the escrow refund runs, and the transaction hash plus a `manualReview` note are included in the error details for reconciliation.
- **Intelligence timing:** provider fetches run concurrently with 7–25 s timeouts; the DefiLlama pool snapshot (~11 MB) is cached for 120 s and is only fetched by `yield_alpha` and `mega_report`. One LLM call per job (Groq → Gemini fallback) keeps the whole job inside the 60 s Vercel limit. The zero-gas insight offerings make that call optional — data-only delivery when both engines are down.
- **Provider outages:** CoinGecko, GeckoTerminal, Binance and DefiLlama status is exposed by `/api/health`. A job whose required providers all fail returns an explicit `*_UNAVAILABLE` error and is refunded at the escrow layer; it never returns filler text. `twitter_alpha`/`kol_alpha` require `TWITTER_BEARER_TOKEN` for verbatim posts and fall back to cited grounding, not fabricated posts.
- **Intake safety:** the poller only executes jobs addressed to this agent's wallet that are `FUNDED` and whose description parses to a known offering with valid parameters. Everything else is left untouched on-chain and reported by `GET /api/intake`. It never rejects a job it cannot understand, so the client keeps control of their escrow.
- **Intake cursor:** the cursor is stored per chain (`intake:cursor:8453`) and only advances past jobs that were handled; jobs skipped for time or batch limits are retried. A fresh deployment with `ACP_INTAKE_START_ID=0` anchors at the head rather than replaying history — set the variable if you intentionally want to backfill from a specific job id.
- **A2A scope:** `/a2a` never executes paid work. It returns live previews and task state, and every execution path still requires a funded ACP job discovered by the intake poller.
- **Outreach safety:** outbound pitching runs by default (`OUTREACH_ENABLED=true`) but stays idle until `PUBLIC_BASE_URL` is set. Every message is bounded by a daily cap, per-target cooldown, opt-out set, turn cap and five-minute session; a claimed funded job is verified on-chain before the deal is recorded, and the agent never funds its own escrow. Discovery only fetches public HTTPS agent cards (private/loopback addresses are rejected), and analysis requires a configured AI key and live market data — no AI, no pitch.
- **Outreach state:** sessions, contacts, the daily counter and the opt-out set live in the shared store (`outreach:*` keys) with TTLs; on Vercel this requires Upstash, otherwise caps reset per instance.
- **Revenue quotes:** discounts exist only as stored quote records. The escrow check resolves the quote by id and re-validates offering, normalized params, client and expiry, so a client cannot claim happy-hour pricing without a server-issued quote or use a cheap quote to run a richer variant. List prices and `priceUnitsFor()` remain the floor for all unquoted jobs. Performance quotes are limited to one-off intelligence offerings; recurring retainers and execution services are list-price only.
- **Referral payouts:** commissions are queued only after local completion, then require an on-chain `getJob()` status of `COMPLETED`. Payouts are serialized per job, retried up to six times, and skip when the agent wallet cannot cover the commission plus `REFERRAL_RESERVE_USDC`. They never draw from escrow principal.
- **Retainers:** activation requires a funded ACP job and a public HTTPS endpoint. Delivery is at most one feed per subscription per UTC day, plus a global `RETAINER_MAX_DELIVERIES_PER_DAY` cap. There is no auto-debit; an expired retainer simply stops delivering until a new job is funded.
- **Alert honesty:** `flash_alert`, `yield_radar` and `agent_credit` return live measurements. When no arbitrage spread or whale transfer crosses the configured threshold, the response says so and lists the thresholds instead of inventing an alert.
- **Whale scanning:** the keyless public Base RPC answers `eth_getLogs` with 429, so the whale scanner falls back to `eth_getBlockReceipts` over the most recent 8 blocks of `WHALE_LOOKBACK_BLOCKS`. Receipts expose the same `Transfer` logs, so the alerts stay live — only the window shrinks.
- **Arbitrage sanity:** spreads are computed only across pools that quote the same base token (GeckoTerminal's `base_token_price_usd` is meaningless across different bases) and are discarded above 5,000 bps as stale or mismatched quotes rather than sold as an opportunity.
- **Bounties:** anomaly pitching is the only revenue path that sends an unsolicited message, and it inherits every outreach guard (public endpoint required, opt-out, cooldown, daily cap, `OUTREACH_ENABLED`). Anomalies without a matching contactable target are recorded as `no_target` and never sent.
- **Performance fees:** only the upfront portion is enforceable through escrow. The bonus is presented as terms for a second funded job; the agent does not claim it was collected.

## Repository layout

```
api/index.js              Vercel entry point (Express handler, maxDuration 60)
src/app.js                Express app: CORS, request IDs, logging, error handling
src/routes/api.js         HTTP surface
src/routes/a2a.js         A2A agent cards and JSON-RPC endpoint
src/services/             ACP escrow, jobs, refunds, swap, transfer, donations, AI, health
src/services/intake.js    on-chain ACP job discovery: cursor, order parsing, execution pass
src/services/a2a.js       A2A cards (v0.3 + v1.0), JSON-RPC method handling, inbound session routing
src/services/discovery.js outreach candidate discovery, SSRF-guarded card fetch, deterministic scoring
src/services/outreach.js  outreach engine: analysis, live teaser, pricing, negotiation, caps, loop guards
src/services/inbox.js     bounded inbound A2A log and status
src/services/pricing.js   tier pricing, happy-hour/gas discounts, stored quotes, ACP envelopes
src/services/referrals.js referral registration, on-chain completion check, USDC commission payouts
src/services/revenue.js   live arbitrage/whale/gas/yield/credit scans, retainers, anomalies, bounty pitches, cycle
src/services/market.js    live CoinGecko / GeckoTerminal / Binance / DexScreener / DefiLlama data
src/services/news.js      RSS ingestion, ranking, lexicon sentiment, X API read client
src/services/ta.js        deterministic EMA/RSI/ATR/Bollinger, momentum, trade plans
src/services/intel.js     the ten intelligence handlers + AI synthesis
src/services/articles.js  autonomous article research, synthesis, number validation, thread assembly
src/services/social.js    idle-gated scheduler: cadence, caps, locking, publish state
src/services/chat.js     boss passcode gate, admin command routing, conversational chat replies
src/services/x.js         X API v2 user-context posting (OAuth 1.0a / OAuth 2.0 user token)
src/chain/client.js       viem clients, transaction serialization, allowances
src/lib/                  errors, HTTP client, RSS/XML parser, logger, Upstash store, rate limiting
test/                     node:test unit tests (offerings, intents, AI routing, TA, RSS, sentiment, store, social, intake, A2A, discovery/outreach, pricing/quotes/revenue, chat/boss)
scripts/verify-live.js    read-only live verification
scripts/social-preview.js real article generation without posting
scripts/build-check.js    import/cycle/stub/Vercel-manifest pre-deploy check
```
