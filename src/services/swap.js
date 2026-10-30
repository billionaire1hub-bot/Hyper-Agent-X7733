import { getAddress, zeroAddress } from "viem";
import { BASE_TOKENS, config, USDC } from "../config.js";
import { AppError } from "../lib/errors.js";
import { sleep } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import {
  encodeErc20Transfer,
  encodeErc20TransferFrom,
  ensureAllowance,
  fromUnits,
  getAgentAddress,
  getAllowance,
  getNativeBalance,
  getTokenBalance,
  publicClient,
  sendTransaction,
  toUnits,
} from "../chain/client.js";
import { resolveToken } from "./tokens.js";
import { buildSwap, getQuote, minAmountOut } from "./kyberswap.js";
import {
  VIRTUALS_ROUTER,
  executeBondingBuy,
  executeBondingSell,
  getVirtualsAssetToken,
  quoteBondingBuy,
  quoteBondingSell,
} from "./virtuals.js";

const NATIVE_GAS_RESERVE = 300_000_000_000_000n; // 0.0003 ETH
const STABLE_SYMBOLS = new Set(["USDC", "USDbC", "DAI", "EURC"]);
const RETRYABLE_CODES = new Set([
  "TX_CONFIRMATION_TIMEOUT",
  "TX_REVERTED",
  "GAS_ESTIMATION_FAILED",
  "NETWORK_ERROR",
  "RPC_READ_FAILED",
  "UPSTREAM_ERROR",
]);

const readBalance = (token, owner) =>
  token.native ? publicClient.getBalance({ address: owner }) : getTokenBalance(token.address, owner);

const readBalanceStable = async (token, owner, attempts = 4) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readBalance(token, owner);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(600 * attempt);
    }
  }
  throw lastError;
};

const tokenRef = (token) => ({
  address: token.address,
  symbol: token.symbol,
  decimals: token.decimals,
  native: Boolean(token.native),
});

const sleepForAttempt = (attempt) => sleep(1200 * attempt);

function isRetryable(error) {
  if (!error) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return Boolean(error.retryable);
}

async function returnErc20({ token, amount, to, log }) {
  if (amount <= 0n) return null;
  try {
    const balance = await getTokenBalance(token.address, getAgentAddress());
    const refundAmount = balance < amount ? balance : amount;
    if (refundAmount <= 0n) return null;
    const { hash, explorer } = await sendTransaction(
      { to: token.address, data: encodeErc20Transfer(to, refundAmount) },
      { label: "return-unused-funds" }
    );
    log.warn("returned unused funds to client", { token: token.address, amount: String(refundAmount), txHash: hash });
    return { token: token.address, amount: String(refundAmount), txHash: hash, explorer };
  } catch (error) {
    log.error("failed to return unused funds", { token: token.address, message: error.message });
    return { token: token.address, amount: String(amount), error: error.message };
  }
}

async function ensureFunds({ sell, amountIn, buyer, log }) {
  const agent = getAgentAddress();

  if (sell.native) {
    if (!config.execution.allowAgentFundedSwaps) {
      throw AppError.paymentRequired(
        "Native ETH sells are disabled: the agent will not risk its own ETH for a fee-sized escrow. Set ALLOW_AGENT_FUNDED_SWAPS=true only for trusted prefunded clients.",
        { token: "ETH", fundingMode: "agent_prefunded", enabled: false },
        "NATIVE_SELL_DISABLED"
      );
    }
    const balance = await getNativeBalance(agent);
    if (balance < amountIn + NATIVE_GAS_RESERVE) {
      throw AppError.unavailable(
        "Agent wallet lacks native ETH for this swap. Native sells must be pre-funded.",
        {
          requiredWei: String(amountIn + NATIVE_GAS_RESERVE),
          balanceWei: String(balance),
          fundingMode: "prefunded",
        },
        "INSUFFICIENT_AGENT_LIQUIDITY"
      );
    }
    return { source: "agent", token: sell, amount: amountIn, swapped: false, tradeSent: false, intermediate: null };
  }

  const agentIsClient = buyer.toLowerCase() === agent.toLowerCase();
  const agentBalance = await getTokenBalance(sell.address, agent);
  if ((config.execution.allowAgentFundedSwaps || agentIsClient) && agentBalance >= amountIn) {
    return { source: "agent", token: sell, amount: amountIn, swapped: false, tradeSent: false, intermediate: null };
  }

  const allowance = await getAllowance(sell.address, buyer, agent);
  if (allowance < amountIn) {
    throw AppError.paymentRequired(
      `Client must approve the agent wallet to spend ${sell.symbol}, or pre-fund the agent wallet.`,
      {
        token: sell.address,
        owner: buyer,
        spender: agent,
        required: String(amountIn),
        allowance: String(allowance),
        approveHint: `Call ${sell.symbol}.approve("${agent}", amount) from the client wallet before creating the job.`,
      },
      "INSUFFICIENT_ALLOWANCE"
    );
  }

  const before = agentBalance;
  const { hash } = await sendTransaction(
    { to: sell.address, data: encodeErc20TransferFrom(buyer, agent, amountIn) },
    { label: "pull-client-funds" }
  );
  const after = await getTokenBalance(sell.address, agent);
  const received = after - before;

  if (received <= 0n) {
    throw AppError.upstream("Client token pull delivered nothing.", { token: sell.address }, "FUNDING_FAILED");
  }
  if (received < amountIn) {
    const returned = await returnErc20({ token: sell, amount: received, to: buyer, log });
    throw AppError.badRequest(
      "Fee-on-transfer token detected: agent received less than requested. Funds were returned.",
      { requested: String(amountIn), received: String(received), returned },
      "FEE_ON_TRANSFER_UNSUPPORTED"
    );
  }

  return {
    source: "buyer",
    token: sell,
    amount: received,
    pulledTxHash: hash,
    swapped: false,
    tradeSent: false,
    intermediate: null,
  };
}

async function executeKyberLeg({ sell, buy, amountIn, slippageBps, recipient, log, funding }) {
  const agent = getAgentAddress();
  if (buy.native && recipient.toLowerCase() === agent.toLowerCase()) {
    throw AppError.badRequest(
      "Native output cannot be routed to the agent wallet.",
      undefined,
      "INVALID_RECIPIENT"
    );
  }

  let lastError;

  for (let attempt = 1; attempt <= config.execution.maxAttempts; attempt += 1) {
    let before = null;
    let quote = null;
    let minOut = null;
    let built = null;

    try {
      quote = await getQuote({ tokenIn: sell.address, tokenOut: buy.address, amountIn });
      minOut = minAmountOut(quote.amountOut, slippageBps);

      if (!sell.native) {
        await ensureAllowance(sell.address, quote.router, amountIn, { label: `approve-swap-${sell.symbol}` });
      }

      built = await buildSwap({
        routeSummary: quote.routeSummary,
        sender: agent,
        recipient,
        slippageTolerance: slippageBps,
      });

      before = await readBalanceStable(buy, recipient);
      const { hash, explorer } = await sendTransaction(
        { to: built.to, data: built.data, value: built.value },
        { label: `swap-${sell.symbol}-${buy.symbol}` }
      );
      if (funding) funding.tradeSent = true;
      const after = await readBalanceStable(buy, recipient);
      const delivered = after > before ? after - before : 0n;

      if (delivered < minOut) {
        throw AppError.upstream(
          "Swap executed but delivered below the slippage floor.",
          { txHash: hash, delivered: String(delivered), minimum: String(minOut) },
          "SLIPPAGE_VIOLATION"
        );
      }

      return {
        venue: "kyberswap",
        router: built.to,
        txHash: hash,
        explorer,
        quotedOut: quote.amountOut,
        minOut,
        delivered,
        amountInUsd: quote.amountInUsd,
        amountOutUsd: quote.amountOutUsd,
        routeId: quote.routeId,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      if (error.code === "TX_CONFIRMATION_TIMEOUT" && error.details?.txHash) {
        const receipt = await publicClient
          .getTransactionReceipt({ hash: error.details.txHash })
          .catch(() => null);

        if (receipt === null) {
          // Unknown outcome: never retry, the trade may already be included.
          if (funding) funding.tradeSent = true;
          throw error;
        }

        const isTradeTx = Boolean(
          built?.to && receipt.to && receipt.to.toLowerCase() === built.to.toLowerCase()
        );

        if (receipt.status === "success" && isTradeTx) {
          if (funding) funding.tradeSent = true;
          const after = await readBalanceStable(buy, recipient).catch(() => null);
          const delivered = before !== null && after !== null && after > before ? after - before : 0n;
          if (delivered > 0n) {
            log.warn("swap confirmed after timeout window", { txHash: error.details.txHash });
            return {
              venue: "kyberswap",
              router: null,
              txHash: error.details.txHash,
              explorer: error.details.explorer,
              quotedOut: quote?.amountOut ?? delivered,
              minOut: minOut ?? 0n,
              delivered,
              confirmedLate: true,
              attempts: attempt,
            };
          }
          throw AppError.upstream(
            "Swap transaction was confirmed but the output could not be verified. Not retrying to avoid a double spend.",
            { txHash: error.details.txHash, minimum: String(minOut ?? 0n) },
            "SWAP_UNVERIFIED"
          );
        }

        // Approval or reverted transaction: no trade funds moved, retry is safe.
        if (funding) funding.tradeSent = false;
      }

      const retryable = isRetryable(error) && error.code !== "NO_ROUTE";
      if (funding?.tradeSent) throw error;
      if (!retryable || attempt >= config.execution.maxAttempts) throw error;
      log.warn("swap attempt failed; retrying", {
        attempt,
        code: error.code,
        message: error.message,
      });
      await sleepForAttempt(attempt);
    }
  }

  throw lastError;
}

async function executeBondingLeg({ token, outToken, amountIn, slippageBps, recipient, log, side, funding }) {
  let lastError;

  for (let attempt = 1; attempt <= config.execution.maxAttempts; attempt += 1) {
    let before = null;
    try {
      const quote =
        side === "buy"
          ? await quoteBondingBuy({ token: token.address, amountIn })
          : await quoteBondingSell({ token: token.address, amountIn });
      if (!quote) throw new AppError("No Virtuals bonding route.", undefined, "NO_ROUTE");

      const minOut = minAmountOut(quote.amountOut, slippageBps);
      before = await readBalanceStable(outToken, recipient);

      const result =
        side === "buy"
          ? await executeBondingBuy({
              tokenAddress: token.address,
              amountIn,
              recipient,
              assetToken: quote.assetToken,
            })
          : await executeBondingSell({ tokenAddress: token.address, amountIn, recipient });
      if (funding) funding.tradeSent = true;

      const after = await readBalanceStable(outToken, recipient);
      const delivered = after > before ? after - before : 0n;
      const slippageExceeded = delivered < minOut;

      if (delivered === 0n) {
        throw AppError.upstream(
          "Virtuals bonding trade settled but no output was received.",
          { txHash: result.txHash, minimum: String(minOut) },
          "NO_OUTPUT_DELIVERED"
        );
      }

      return {
        venue: "virtuals-bonding",
        router: result.router,
        txHash: result.txHash,
        explorer: result.explorer,
        quotedOut: quote.amountOut,
        minOut,
        delivered,
        slippageExceeded,
        assetToken: quote.assetToken,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (error.code === "TX_CONFIRMATION_TIMEOUT" && error.details?.txHash) {
        const receipt = await publicClient
          .getTransactionReceipt({ hash: error.details.txHash })
          .catch(() => null);

        if (receipt === null) {
          if (funding) funding.tradeSent = true;
          throw error;
        }

        const isTradeTx = Boolean(
          receipt.to && receipt.to.toLowerCase() === VIRTUALS_ROUTER.toLowerCase()
        );

        if (receipt.status === "success" && isTradeTx) {
          if (funding) funding.tradeSent = true;
          const after = await readBalanceStable(outToken, recipient).catch(() => null);
          if (before !== null && after !== null && after > before) {
            return {
              venue: "virtuals-bonding",
              txHash: error.details.txHash,
              explorer: error.details.explorer,
              delivered: after - before,
              confirmedLate: true,
              attempts: attempt,
            };
          }
          throw AppError.upstream(
            "Bonding transaction was confirmed but the output could not be verified. Not retrying to avoid a double spend.",
            { txHash: error.details.txHash },
            "BONDING_UNVERIFIED"
          );
        }

        if (funding) funding.tradeSent = false;
      }
      if (funding?.tradeSent) throw error;
      if (!isRetryable(error) || attempt >= config.execution.maxAttempts) throw error;
      log.warn("bonding attempt failed; retrying", { attempt, code: error.code, message: error.message });
      await sleepForAttempt(attempt);
    }
  }

  throw lastError;
}

async function executeComposite({ sell, buy, amountIn, slippageBps, recipient, log, funding }) {
  const assetAddress = await getVirtualsAssetToken();
  const virtualToken = { address: assetAddress, symbol: "VIRTUAL", decimals: 18, native: false };

  const firstLeg = await executeKyberLeg({
    sell,
    buy: virtualToken,
    amountIn,
    slippageBps,
    recipient: getAgentAddress(),
    log,
    funding,
  });
  funding.swapped = true;

  const received = firstLeg.delivered;
  if (received <= 0n) {
    throw AppError.upstream("Composite leg 1 delivered no VIRTUAL.", undefined, "COMPOSITE_FAILED");
  }

  funding.intermediate = { token: virtualToken, amount: received };
  // Scope the trade-sent flag to the second leg so a pre-broadcast failure can
  // still return the intermediate VIRTUAL to the client.
  funding.tradeSent = false;

  const secondLeg = await executeBondingLeg({
    token: buy,
    outToken: buy,
    amountIn: received,
    slippageBps,
    recipient,
    log,
    side: "buy",
    funding,
  });
  funding.intermediate = null;

  return { firstLeg, secondLeg };
}

export async function executeSwap({ params, buyer, log = logger }) {
  const sell = await resolveToken(params.sellToken);
  const buy = await resolveToken(params.buyToken);

  if (sell.address.toLowerCase() === buy.address.toLowerCase() && sell.native === buy.native) {
    throw AppError.badRequest("sellToken and buyToken must differ.", undefined, "SAME_TOKEN");
  }
  if (sell.native && buy.native) {
    throw AppError.badRequest("Cannot swap native ETH to native ETH.", undefined, "INVALID_PAIR");
  }

  const recipient = getAddress(buyer);
  if (recipient === zeroAddress) throw AppError.badRequest("buyer cannot be the zero address.", undefined, "INVALID_RECIPIENT");

  const amountIn = toUnits(params.amount, sell.decimals);
  const slippageBps = params.maxSlippageBps;
  const agent = getAgentAddress();

  log.info("swap starting", {
    sell: sell.symbol,
    buy: buy.symbol,
    amountIn: String(amountIn),
    slippageBps,
    recipient,
    agent,
  });

  const funding = await ensureFunds({ sell, amountIn, buyer: recipient, log });

  try {
    let execution;
    let routeType = "kyberswap";

    try {
      execution = await executeKyberLeg({
        sell,
        buy,
        amountIn,
        slippageBps,
        recipient,
        log,
        funding,
      });
    } catch (error) {
      if (error.code !== "NO_ROUTE") throw error;

      log.warn("no direct AMM route; trying Virtuals bonding", { sell: sell.symbol, buy: buy.symbol });

      const asset = await getVirtualsAssetToken();
      if (sell.address.toLowerCase() === asset.toLowerCase() && !buy.native) {
        execution = await executeBondingLeg({
          token: buy,
          outToken: buy,
          amountIn,
          slippageBps,
          recipient,
          log,
          side: "buy",
          funding,
        });
        routeType = "virtuals-bonding";
      } else if (buy.address.toLowerCase() === asset.toLowerCase() && !sell.native) {
        execution = await executeBondingLeg({
          token: sell,
          outToken: buy,
          amountIn,
          slippageBps,
          recipient,
          log,
          side: "sell",
          funding,
        });
        routeType = "virtuals-bonding";
      } else if (!sell.native && isStable(sell) && !buy.native) {
        const composite = await executeComposite({
          sell,
          buy,
          amountIn,
          slippageBps,
          recipient,
          log,
          funding,
        });
        routeType = "kyberswap+virtuals";
        execution = {
          venue: routeType,
          txHash: composite.secondLeg.txHash,
          explorer: composite.secondLeg.explorer,
          quotedOut: composite.secondLeg.quotedOut,
          minOut: composite.secondLeg.minOut,
          delivered: composite.secondLeg.delivered,
          slippageExceeded: composite.secondLeg.slippageExceeded,
          legs: [
            {
              venue: "kyberswap",
              txHash: composite.firstLeg.txHash,
              explorer: composite.firstLeg.explorer,
              delivered: String(composite.firstLeg.delivered),
              minOut: String(composite.firstLeg.minOut),
            },
            {
              venue: "virtuals-bonding",
              txHash: composite.secondLeg.txHash,
              explorer: composite.secondLeg.explorer,
              delivered: String(composite.secondLeg.delivered),
              minOut: String(composite.secondLeg.minOut),
            },
          ],
        };
      } else {
        throw AppError.badRequest(
          "No executable route found on KyberSwap or the Virtuals bonding router for this pair.",
          { sell: sell.symbol, buy: buy.symbol },
          "NO_ROUTE"
        );
      }
    }

    funding.swapped = true;

    return {
      venue: routeType,
      status: "executed",
      sellToken: tokenRef(sell),
      buyToken: tokenRef(buy),
      amountIn: String(amountIn),
      amountInFormatted: fromUnits(amountIn, sell.decimals),
      amountOut: String(execution.delivered),
      amountOutFormatted: fromUnits(execution.delivered, buy.decimals),
      quotedAmountOut: execution.quotedOut ? String(execution.quotedOut) : null,
      minAmountOut: execution.minOut ? String(execution.minOut) : null,
      minAmountOutFormatted: execution.minOut ? fromUnits(execution.minOut, buy.decimals) : null,
      slippageBps,
      slippageExceeded: Boolean(execution.slippageExceeded),
      txHash: execution.txHash,
      explorer: execution.explorer,
      router: execution.router || null,
      legs: execution.legs || null,
      usd: {
        in: execution.amountInUsd ?? null,
        out: execution.amountOutUsd ?? null,
      },
      funding: {
        source: funding.source,
        pullTxHash: funding.pulledTxHash || null,
      },
      attempts: execution.attempts || 1,
      confirmedLate: Boolean(execution.confirmedLate),
      recipient,
    };
  } catch (error) {
    let returned = null;
    if (funding.tradeSent) {
      error.details = {
        ...(error.details || {}),
        manualReview:
          "A trade transaction was broadcast; unused funds were not auto-returned to avoid a double spend.",
      };
    } else if (funding.intermediate) {
      returned = await returnErc20({
        token: funding.intermediate.token,
        amount: funding.intermediate.amount,
        to: recipient,
        log,
      });
    } else if (!funding.swapped && funding.source === "buyer") {
      returned = await returnErc20({
        token: funding.token,
        amount: funding.amount,
        to: recipient,
        log,
      });
    }
    if (returned) error.details = { ...(error.details || {}), returnedFunds: returned };

    log.error("swap failed", {
      code: error.code,
      message: error.message,
      sell: sell.symbol,
      buy: buy.symbol,
    });
    throw error;
  }
}

const isStable = (token) =>
  STABLE_SYMBOLS.has(String(token.symbol).toUpperCase()) ||
  [USDC.address, BASE_TOKENS.USDC_E.address, BASE_TOKENS.DAI.address, BASE_TOKENS.EURC.address]
    .map((address) => address.toLowerCase())
    .includes(token.address.toLowerCase());

const previewShape = ({ sell, buy, amountIn, slippageBps, venue, amountOut, extra = {} }) => ({
  venue,
  sellToken: tokenRef(sell),
  buyToken: tokenRef(buy),
  amountIn: String(amountIn),
  amountInFormatted: fromUnits(amountIn, sell.decimals),
  expectedAmountOut: String(amountOut),
  expectedAmountOutFormatted: fromUnits(amountOut, buy.decimals),
  minimumAmountOut: String(minAmountOut(amountOut, slippageBps)),
  minimumAmountOutFormatted: fromUnits(minAmountOut(amountOut, slippageBps), buy.decimals),
  slippageBps,
  ...extra,
});

export async function previewSwap({ sellToken, buyToken, amount, slippageBps }) {
  const sell = await resolveToken(sellToken);
  const buy = await resolveToken(buyToken);
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
    throw AppError.badRequest("sellToken and buyToken must differ.", undefined, "SAME_TOKEN");
  }
  if (sell.native && !config.execution.allowAgentFundedSwaps) {
    throw AppError.paymentRequired(
      "Native ETH sells are disabled unless ALLOW_AGENT_FUNDED_SWAPS=true.",
      { token: "ETH", enabled: false },
      "NATIVE_SELL_DISABLED"
    );
  }
  const amountIn = toUnits(amount, sell.decimals);
  const funding = {
    source: sell.native ? "agent_prefunded" : "client_allowance_or_agent_prefunded",
    agentFundedSwapsEnabled: config.execution.allowAgentFundedSwaps,
  };

  let directError;
  try {
    const quote = await getQuote({ tokenIn: sell.address, tokenOut: buy.address, amountIn });
    return previewShape({
      sell,
      buy,
      amountIn,
      slippageBps,
      venue: "kyberswap",
      amountOut: quote.amountOut,
      extra: { funding, usd: { in: quote.amountInUsd, out: quote.amountOutUsd } },
    });
  } catch (error) {
    if (error.code !== "NO_ROUTE") throw error;
    directError = error;
  }

  const assetAddress = (await getVirtualsAssetToken().catch(() => null))?.toLowerCase();

  if (assetAddress && sell.address.toLowerCase() === assetAddress) {
    const bondingQuote = await quoteBondingBuy({ token: buy.address, amountIn });
    if (bondingQuote) {
      return previewShape({
        sell,
        buy,
        amountIn,
        slippageBps,
        venue: "virtuals-bonding",
        amountOut: bondingQuote.amountOut,
        extra: { funding, side: "buy" },
      });
    }
  }

  if (assetAddress && buy.address.toLowerCase() === assetAddress) {
    const bondingQuote = await quoteBondingSell({ token: sell.address, amountIn });
    if (bondingQuote) {
      return previewShape({
        sell,
        buy,
        amountIn,
        slippageBps,
        venue: "virtuals-bonding",
        amountOut: bondingQuote.amountOut,
        extra: { funding, side: "sell" },
      });
    }
  }

  if (assetAddress && isStable(sell) && !buy.native) {
    try {
      const firstLeg = await getQuote({ tokenIn: sell.address, tokenOut: assetAddress, amountIn });
      const secondLeg = await quoteBondingBuy({ token: buy.address, amountIn: firstLeg.amountOut });
      if (secondLeg) {
        return previewShape({
          sell,
          buy,
          amountIn,
          slippageBps,
          venue: "kyberswap+virtuals",
          amountOut: secondLeg.amountOut,
          extra: {
            funding,
            legs: [
              {
                venue: "kyberswap",
                tokenOut: assetAddress,
                expectedAmountOut: String(firstLeg.amountOut),
                minimumAmountOut: String(minAmountOut(firstLeg.amountOut, slippageBps)),
              },
              {
                venue: "virtuals-bonding",
                expectedAmountOut: String(secondLeg.amountOut),
                minimumAmountOut: String(minAmountOut(secondLeg.amountOut, slippageBps)),
              },
            ],
          },
        });
      }
    } catch (error) {
      if (error.code !== "NO_ROUTE") throw error;
    }
  }

  throw directError;
}
