import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { config, walletConfigured, ONCHAIN_EXECUTION_OFFERINGS } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { storeHelpers, withLock } from "../lib/store.js";

export const publicClient = createPublicClient({
  chain: base,
  transport: http(config.chain.rpcUrl, { timeout: 15000, retryCount: 2 }),
});

let cachedAccount = null;
let cachedWallet = null;

export function getAgentAccount() {
  if (!walletConfigured) {
    throw AppError.unavailable(
      "Agent execution wallet is not configured. Set AGENT_PRIVATE_KEY.",
      { missing: "AGENT_PRIVATE_KEY" },
      "WALLET_NOT_CONFIGURED"
    );
  }
  if (!cachedAccount) {
    cachedAccount = privateKeyToAccount(config.wallet.privateKey);
    cachedWallet = createWalletClient({
      account: cachedAccount,
      chain: base,
      transport: http(config.chain.rpcUrl, { timeout: 15000, retryCount: 2 }),
    });
  }
  return cachedAccount;
}

export const getAgentAddress = () => getAgentAccount().address;

export function getWalletClient() {
  getAgentAccount();
  return cachedWallet;
}

export const explorerTx = (hash) => `${config.chain.explorer}/tx/${hash}`;
export const explorerAddress = (address) => `${config.chain.explorer}/address/${address}`;

export const toUnits = (amount, decimals) => {
  try {
    const value = parseUnits(String(amount), decimals);
    if (value <= 0n) throw new Error("Amount must be greater than zero");
    return value;
  } catch (error) {
    throw AppError.badRequest(`Invalid amount "${amount}": ${error.message}`, undefined, "INVALID_AMOUNT");
  }
};

export const fromUnits = (value, decimals) => formatUnits(value, decimals);

export async function getNativeBalance(address) {
  return publicClient.getBalance({ address });
}

const ETH_BALANCE_CACHE_MS = 15_000;
let cachedEthBalance = { value: null, at: 0 };

export async function agentEthBalance({ force = false } = {}) {
  if (!walletConfigured) return null;
  if (!force && cachedEthBalance.value !== null && Date.now() - cachedEthBalance.at < ETH_BALANCE_CACHE_MS) {
    return cachedEthBalance.value;
  }
  const balance = await getNativeBalance(getAgentAddress());
  cachedEthBalance = { value: balance, at: Date.now() };
  return balance;
}

export function onchainGasGated({ offeringId, ethBalance, unlockThresholdWei = 0n }) {
  if (!ONCHAIN_EXECUTION_OFFERINGS.has(offeringId)) return false;
  if (ethBalance === null || ethBalance === undefined) return false;
  const threshold = unlockThresholdWei > 0n ? unlockThresholdWei : 1n;
  return ethBalance < threshold;
}

export async function getTokenBalance(token, owner) {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function getAllowance(token, owner, spender) {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function getTransactionCount(address) {
  return publicClient.getTransactionCount({ address, blockTag: "pending" });
}

/**
 * Serializes every outbound transaction through a wallet lock (shared through
 * Upstash when configured) and an explicit pending nonce. This prevents nonce
 * collisions between concurrent serverless invocations.
 */
export async function sendTransaction(request, { label = "transaction" } = {}) {
  const account = getAgentAccount();
  const wallet = getWalletClient();

  const { acquired, result } = await withLock(
    storeHelpers.walletLock(),
    50,
    async () => {
      const nonce = await getTransactionCount(account.address);
      let gas;
      try {
        gas = await publicClient.estimateGas({
          account,
          to: request.to,
          data: request.data,
          value: request.value ?? 0n,
        });
      } catch (error) {
        throw AppError.upstream(
          `${label}: gas estimation failed (${shortRpcError(error)})`,
          { hint: "The transaction would revert or the wallet lacks gas/allowance." },
          "GAS_ESTIMATION_FAILED",
          error
        );
      }

      const hash = await wallet.sendTransaction({
        account,
        chain: base,
        to: request.to,
        data: request.data,
        value: request.value ?? 0n,
        gas: (gas * 125n) / 100n,
        nonce,
      });

      logger.info("transaction sent", { label, hash, nonce: String(nonce) });

      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: config.execution.confirmations,
          timeout: config.execution.txTimeoutMs,
          pollingInterval: 1000,
        });
      } catch (error) {
        throw new AppError(
          `${label}: transaction was broadcast but confirmation was not observed (${shortRpcError(error)})`,
          {
            status: 504,
            code: "TX_CONFIRMATION_TIMEOUT",
            details: { txHash: hash, explorer: explorerTx(hash) },
            retryable: true,
            cause: error,
          }
        );
      }

      if (receipt.status !== "success") {
        throw AppError.upstream(
          `${label}: transaction reverted on-chain`,
          { txHash: hash, explorer: explorerTx(hash) },
          "TX_REVERTED"
        );
      }

      return { hash, receipt, nonce: String(nonce) };
    },
    { waitMs: 20000 }
  );

  if (!acquired) {
    throw AppError.unavailable(
      "Execution wallet is busy with another transaction. Retry shortly.",
      undefined,
      "WALLET_BUSY"
    );
  }

  return { ...result, explorer: explorerTx(result.hash) };
}

export async function ensureAllowance(token, spender, amount, { label = "approve" } = {}) {
  const account = getAgentAccount();
  const current = await getAllowance(token, account.address, spender);
  if (current >= amount) return { approved: false, allowance: current };

  const { hash } = await sendTransaction(
    {
      to: token,
      data: encodeApprove(spender, amount),
    },
    { label }
  );

  const updated = await getAllowance(token, account.address, spender);
  if (updated < amount) {
    throw AppError.upstream(
      `${label}: allowance still insufficient after approval`,
      { token, spender, required: String(amount), actual: String(updated) },
      "APPROVAL_FAILED"
    );
  }

  return { approved: true, txHash: hash, allowance: updated };
}

export function encodeApprove(spender, amount) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
}

export function encodeErc20Transfer(to, amount) {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}

export function encodeErc20TransferFrom(from, to, amount) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transferFrom",
    args: [from, to, amount],
  });
}

export function shortRpcError(error) {
  const message = error?.shortMessage || error?.message || String(error);
  return message.split("\n")[0].slice(0, 240);
}

export async function waitForBalanceAtLeast({ getBalance, minimum, timeoutMs = 15000, intervalMs = 750 }) {
  const deadline = Date.now() + timeoutMs;
  let balance = await getBalance();
  while (balance < minimum && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    balance = await getBalance();
  }
  return balance;
}
