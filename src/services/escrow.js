import { encodeFunctionData, getAddress, keccak256, toBytes, zeroAddress } from "viem";
import { config, USDC, walletConfigured } from "../config.js";
import { ACP_ABI, ACP_JOB_STATUS } from "../abi/index.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  getAgentAddress,
  getTokenBalance,
  publicClient,
  sendTransaction,
  shortRpcError,
} from "../chain/client.js";
import { basePriceFor, priceUnitsFor, resolveQuote } from "./pricing.js";

const acpContract = () => {
  try {
    return getAddress(config.acp.contract);
  } catch {
    throw AppError.unavailable(
      "ACP_CONTRACT_ADDRESS is invalid.",
      { configured: config.acp.contract },
      "ACP_NOT_CONFIGURED"
    );
  }
};

let paymentTokenCache = null;

export async function getPaymentToken() {
  if (paymentTokenCache && paymentTokenCache.expiresAt > Date.now()) return paymentTokenCache.value;
  const token = await publicClient.readContract({
    address: acpContract(),
    abi: ACP_ABI,
    functionName: "paymentToken",
  });
  const value = getAddress(token);
  paymentTokenCache = { value, expiresAt: Date.now() + 5 * 60 * 1000 };
  return value;
}

export function parseJobId(input) {
  const raw = String(input ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw AppError.badRequest(
      "jobId must be the numeric ACP on-chain job id (uint256).",
      { jobId: raw },
      "INVALID_JOB_ID"
    );
  }
  const value = BigInt(raw);
  if (value <= 0n) throw AppError.badRequest("jobId must be greater than zero.", { jobId: raw }, "INVALID_JOB_ID");
  return value;
}

export async function getAcpJob(jobId) {
  const id = parseJobId(jobId);
  let job;
  try {
    job = await publicClient.readContract({
      address: acpContract(),
      abi: ACP_ABI,
      functionName: "getJob",
      args: [id],
    });
  } catch (error) {
    throw AppError.upstream(
      `Unable to read ACP job ${id}: ${shortRpcError(error)}`,
      { jobId: String(id), escrow: config.acp.contract },
      "ACP_READ_FAILED",
      error
    );
  }

  return normalizeJob(id, job);
}

function normalizeJob(id, job) {
  if (!job || job.client === zeroAddress) return null;

  return {
    id: String(id),
    client: getAddress(job.client),
    provider: getAddress(job.provider),
    evaluator: getAddress(job.evaluator),
    hook: job.hook === zeroAddress ? null : getAddress(job.hook),
    status: Number(job.status),
    statusName: ACP_JOB_STATUS[Number(job.status)] || "UNKNOWN",
    budget: BigInt(job.budget),
    expiredAt: Number(job.expiredAt),
    description: job.description,
  };
}

export async function getJobCounter() {
  try {
    const counter = await publicClient.readContract({
      address: acpContract(),
      abi: ACP_ABI,
      functionName: "jobCounter",
    });
    return BigInt(counter);
  } catch (error) {
    throw AppError.upstream(
      `Unable to read ACP job counter: ${shortRpcError(error)}`,
      { escrow: config.acp.contract },
      "ACP_READ_FAILED",
      error
    );
  }
}

const MULTICALL_CHUNK = 25;

/**
 * Reads a batch of ACP jobs with one multicall per chunk. Returns null entries
 * for ids that do not exist or whose individual read failed.
 */
export async function getAcpJobs(ids) {
  const results = [];
  for (let index = 0; index < ids.length; index += MULTICALL_CHUNK) {
    const chunk = ids.slice(index, index + MULTICALL_CHUNK);
    const contracts = chunk.map((id) => ({
      address: acpContract(),
      abi: ACP_ABI,
      functionName: "getJob",
      args: [BigInt(id)],
    }));

    let reads;
    try {
      reads = await publicClient.multicall({ contracts, allowFailure: true });
    } catch (error) {
      logger.warn("ACP multicall failed; reading jobs individually", {
        message: shortRpcError(error),
      });
      for (const id of chunk) {
        results.push(await getAcpJob(id).catch(() => null));
      }
      continue;
    }

    reads.forEach((entry, offset) => {
      results.push(entry.status === "success" ? normalizeJob(chunk[offset], entry.result) : null);
    });
  }
  return results;
}

export async function verifyEscrow({ jobId, offering, buyer, params = {}, quoteId = null }) {
  if (!walletConfigured) {
    throw AppError.unavailable(
      "Agent wallet is not configured, so ACP provider identity cannot be verified.",
      { missing: "AGENT_PRIVATE_KEY" },
      "WALLET_NOT_CONFIGURED"
    );
  }

  const agent = getAgentAddress();
  const contract = acpContract();

  const [code, counter] = await Promise.all([
    publicClient.getBytecode({ address: contract }).catch(() => null),
    publicClient.readContract({ address: contract, abi: ACP_ABI, functionName: "jobCounter" }).catch(() => null),
  ]);

  if (!code || code === "0x") {
    throw AppError.unavailable(
      "ACP escrow contract is not deployed at the configured address on Base.",
      { address: contract },
      "ACP_CONTRACT_MISSING"
    );
  }

  const job = await getAcpJob(jobId);
  if (!job) {
    throw AppError.notFound(
      `ACP job ${jobId} does not exist on Base.`,
      "ESCROW_NOT_FOUND"
    );
  }
  if (counter !== null && BigInt(job.id) > BigInt(counter)) {
    throw AppError.notFound(`ACP job ${jobId} does not exist yet (jobCounter=${counter}).`, "ESCROW_NOT_FOUND");
  }

  if (job.status !== 1) {
    const statusMessages = {
      0: "Escrow is OPEN but not funded. Client must call fund() before work can start.",
      2: "Job is already SUBMITTED and awaiting evaluation.",
      3: "Job is already COMPLETED and settled.",
      4: "Job has been REJECTED and is refundable by the client.",
      5: "Job has EXPIRED; funds are refundable by the client via claimRefund().",
    };
    throw new AppError(statusMessages[job.status] || `Job is in status ${job.statusName}.`, {
      status: job.status === 0 ? 402 : 409,
      code: job.status === 0 ? "ESCROW_NOT_FUNDED" : "INVALID_JOB_STATE",
      details: { jobId: job.id, jobStatus: job.statusName },
    });
  }

  if (job.provider.toLowerCase() !== agent.toLowerCase()) {
    throw AppError.conflict(
      "This ACP job is assigned to a different provider wallet.",
      { jobId: job.id, provider: job.provider, agent },
      "ESCROW_WRONG_PROVIDER"
    );
  }

  const quote = await resolveQuote({ quoteId, offering, params, client: buyer || job.client });
  const required = quote ? BigInt(quote.priceUnits) : priceUnitsFor(offering, params);
  const priceUsdc = quote ? quote.priceUsdc : basePriceFor(offering, params);
  if (job.budget < required) {
    throw AppError.paymentRequired(
      `Escrow budget ${job.budget} is below the offering price ${required} (USDC base units).`,
      {
        jobId: job.id,
        budgetUnits: String(job.budget),
        requiredUnits: String(required),
        priceUsdc,
        ...(quote ? { quoteId: quote.id, quoteExpiresAt: quote.expiresAt } : {}),
      },
      "ESCROW_BUDGET_TOO_LOW"
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (job.expiredAt <= now + config.acp.minEscrowWindowSeconds) {
    throw AppError.conflict(
      "Job expired, or its escrow expiry is too close to guarantee execution.",
      {
        jobId: job.id,
        expiredAt: job.expiredAt,
        secondsRemaining: job.expiredAt - now,
        minimumWindowSeconds: config.acp.minEscrowWindowSeconds,
      },
      "ESCROW_EXPIRING"
    );
  }

  if (buyer && getAddress(buyer).toLowerCase() !== job.client.toLowerCase()) {
    throw AppError.forbidden(
      "buyer does not match the ACP job client.",
      { buyer: getAddress(buyer), client: job.client },
      "BUYER_MISMATCH"
    );
  }

  let paymentToken;
  try {
    paymentToken = await getPaymentToken();
  } catch (error) {
    throw AppError.upstream("Unable to read ACP payment token.", undefined, "ACP_READ_FAILED", error);
  }

  if (paymentToken.toLowerCase() !== USDC.address.toLowerCase()) {
    throw AppError.conflict(
      "ACP escrow is not denominated in Base USDC.",
      { paymentToken },
      "ESCROW_WRONG_TOKEN"
    );
  }

  let escrowBalance;
  try {
    escrowBalance = await getTokenBalance(USDC.address, contract);
  } catch (error) {
    throw AppError.upstream("Unable to read ACP escrow USDC balance.", undefined, "RPC_READ_FAILED", error);
  }
  if (escrowBalance < job.budget) {
    throw AppError.unavailable(
      "ACP escrow contract is undercollateralized for this job.",
      { escrowBalance: String(escrowBalance), budget: String(job.budget) },
      "ESCROW_INSOLVENT"
    );
  }

  logger.info("escrow verified", {
    jobId: job.id,
    client: job.client,
    provider: job.provider,
    budget: String(job.budget),
    required: String(required),
    quoteId: quote?.id || null,
    expiredAt: job.expiredAt,
  });

  return {
    verified: true,
    escrowContract: contract,
    paymentToken,
    requiredUnits: required,
    priceUsdc,
    quote: quote
      ? {
          id: quote.id,
          model: quote.model,
          listUsdc: quote.listUsdc,
          priceUsdc: quote.priceUsdc,
          bonusUsdc: quote.bonusUsdc,
          discountBps: quote.discountBps,
          referrer: quote.referrer || null,
          expiresAt: quote.expiresAt,
        }
      : null,
    job: {
      ...job,
      budget: String(job.budget),
      expiresInSeconds: job.expiredAt - now,
    },
    escrowBalance: String(escrowBalance),
    verifiedAt: new Date().toISOString(),
  };
}

export async function rejectJob(jobId, reason) {
  const id = parseJobId(jobId);
  const reasonHash = keccak256(toBytes(String(reason).slice(0, 200)));
  const data = encodeFunctionData({
    abi: ACP_ABI,
    functionName: "reject",
    args: [id, reasonHash, "0x"],
  });

  const { hash, explorer } = await sendTransaction(
    { to: acpContract(), data },
    { label: `acp-reject-${id}` }
  );
  return { txHash: hash, explorer };
}

export async function submitDeliverable(jobId, deliverableHash) {
  const id = parseJobId(jobId);
  const data = encodeFunctionData({
    abi: ACP_ABI,
    functionName: "submit",
    args: [id, deliverableHash, "0x"],
  });

  const { hash, explorer } = await sendTransaction(
    { to: acpContract(), data },
    { label: `acp-submit-${id}` }
  );
  return { txHash: hash, explorer };
}
