import { getAddress } from "viem";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";

const baseUrl = config.kyber.apiUrl;
const origin = (() => {
  const candidate =
    config.publicBaseUrl || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  try {
    return new URL(candidate).origin;
  } catch {
    return "https://hyper-agent-x7733.local";
  }
})();

const headers = () => ({
  "x-client-id": config.kyber.clientId,
  ...(config.kyber.apiKey ? { "x-api-key": config.kyber.apiKey } : {}),
});

const isNoRoute = (message = "") =>
  /no route|route not found|no eligible route|insufficient liquidity|not supported/i.test(message);

export async function getQuote({ tokenIn, tokenOut, amountIn }) {
  const query = new URLSearchParams({
    tokenIn: tokenIn.toLowerCase(),
    tokenOut: tokenOut.toLowerCase(),
    amountIn: String(amountIn),
    origin,
  });

  let payload;
  try {
    payload = await fetchJSON(`${baseUrl}/routes?${query}`, { headers: headers() }, {
      timeoutMs: 8000,
      retries: 1,
      service: "kyberswap",
    });
  } catch (error) {
    if (isNoRoute(error.message)) {
      throw new AppError("KyberSwap has no route for this pair.", { tokenIn, tokenOut }, "NO_ROUTE");
    }
    throw error;
  }

  if (payload?.code !== 0) {
    if (isNoRoute(payload?.message)) {
      throw new AppError("KyberSwap has no route for this pair.", { tokenIn, tokenOut }, "NO_ROUTE");
    }
    throw AppError.upstream(`KyberSwap quote failed: ${payload?.message || "unknown error"}`, {
      code: payload?.code,
    });
  }

  const summary = payload?.data?.routeSummary;
  const router = payload?.data?.routerAddress;
  if (!summary?.amountOut || !router) {
    throw new AppError("KyberSwap returned an incomplete quote.", { summary }, "NO_ROUTE");
  }

  return {
    venue: "kyberswap",
    router: getAddress(router),
    amountIn: BigInt(summary.amountIn),
    amountOut: BigInt(summary.amountOut),
    amountInUsd: summary.amountInUsd ?? null,
    amountOutUsd: summary.amountOutUsd ?? null,
    gasUsd: summary.gasUsd ?? null,
    routeSummary: summary,
    routeId: summary.routeID ?? null,
  };
}

export async function buildSwap({ routeSummary, sender, recipient, slippageTolerance }) {
  const body = {
    routeSummary,
    sender,
    recipient,
    slippageTolerance: Math.min(Math.max(slippageTolerance, 0), 2000),
    deadline: Math.floor(Date.now() / 1000) + 600,
    source: config.kyber.clientId,
    enableGasEstimation: false,
  };

  let payload;
  try {
    payload = await fetchJSON(`${baseUrl}/route/build`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    }, { timeoutMs: 10000, retries: 1, service: "kyberswap" });
  } catch (error) {
    if (isNoRoute(error.message)) {
      throw new AppError("KyberSwap route expired before build; retrying.", undefined, "NO_ROUTE");
    }
    throw error;
  }

  if (payload?.code !== 0) {
    if (isNoRoute(payload?.message)) {
      throw new AppError("KyberSwap route expired before build; retrying.", undefined, "NO_ROUTE");
    }
    throw AppError.upstream(`KyberSwap build failed: ${payload?.message || "unknown error"}`, {
      code: payload?.code,
    });
  }

  const data = payload?.data;
  if (!data?.data || !data?.routerAddress) {
    throw AppError.upstream("KyberSwap returned incomplete calldata.", undefined, "KYBERSWAP_BUILD_INVALID");
  }

  logger.debug("kyberswap route built", { router: data.routerAddress, gas: data.gas });

  return {
    to: getAddress(data.routerAddress),
    data: data.data,
    value: BigInt(data.transactionValue || 0),
    amountOut: BigInt(data.amountOut || 0),
    amountIn: BigInt(data.amountIn || 0),
    gasUsd: data.gasUsd ?? null,
  };
}

export function minAmountOut(amountOut, slippageBps) {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
