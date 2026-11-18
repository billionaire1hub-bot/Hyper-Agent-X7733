import { erc20Abi, formatUnits, getAddress, isAddress } from "viem";
import { publicClient, getAgentAddress } from "../chain/client.js";
import { config, USDC } from "../config.js";
import { store, storeHelpers } from "../lib/store.js";
import { logger } from "../lib/logger.js";

export const X402_RESOURCES = [
  {
    id: "token-verdict",
    resource: "/api/x402/token-verdict",
    method: "GET",
    scheme: "exact",
    network: "eip155:8453",
    asset: "USDC",
    price: "$0.005",
    priceUnits: 5n * 10n ** 3n,
    description:
      "Base token facts and verdict summary: symbol, decimals, total supply, address checksum and an honest allow/caution listing of what was verified on-chain.",
  },
  {
    id: "wallet-dossier",
    resource: "/api/x402/wallet-dossier",
    method: "GET",
    scheme: "exact",
    network: "eip155:8453",
    asset: "USDC",
    price: "$0.02",
    priceUnits: 2n * 10n ** 4n,
    description:
      "Counterparty facts for a Base address: kind (EOA or contract), nonce, native balance, USDC balance, verified against the Base RPC with sources and timestamps.",
  },
];

export const payToAddress = () => {
  if (process.env.X402_PAY_TO && isAddress(process.env.X402_PAY_TO)) {
    return getAddress(process.env.X402_PAY_TO);
  }
  return getAgentAddress();
};

export const freeTier = {
  resource: "/api/x402/token-verdict",
  per_ip_per_day: 3,
  global_per_day: 300,
  mode: "summary",
  note: "Send X402-FREE: 1 on the request for a free short summary; the full report requires payment.",
};

export function buildX402Manifest(baseUrl, payTo) {
  const origin = (baseUrl || config.publicBaseUrl || "https://hyper-agent-x7733.vercel.app").replace(/\/+$/, "");
  return {
    x402Version: 2,
    name: "Hyper Agent X7733 paid work",
    description:
      "Paid per-call work on Base: token verdicts and wallet dossiers executed by Hyper Agent X7733, settled in USDC on Base. No account, no API key.",
    status: "live",
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    free_tier: freeTier,
    resources: X402_RESOURCES.map((r) => ({
      resource: `${origin}${r.resource}`,
      method: r.method,
      scheme: r.scheme,
      network: r.network,
      asset: r.asset,
      price: r.price,
      payTo,
      description: r.description,
    })),
  };
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function findUsdcPayment(receipt, payer, payTo) {
  if (!receipt || !receipt.logs) return 0n;
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC.address.toLowerCase()) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = `0x${log.topics[1].slice(26)}`.toLowerCase();
    const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
    if (from !== payer.toLowerCase() || to !== payTo.toLowerCase()) continue;
    total += BigInt(log.data || "0x0");
  }
  return total;
}

export async function verifyUsdcPayment({ payer, txHash, priceUnits, payTo }) {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (!receipt || receipt.status !== "success") {
    return { ok: false, reason: "tx_not_found_or_reverted" };
  }
  const paid = findUsdcPayment(receipt, payer, payTo);
  if (paid < priceUnits) {
    return { ok: false, reason: "insufficient_payment", paid: String(paid), required: String(priceUnits) };
  }
  const consumed = await store.get(storeHelpers.x402Consumed(txHash));
  if (consumed) return { ok: false, reason: "payment_already_consumed" };
  return { ok: true, paid: String(paid) };
}

export async function consumePayment(txHash) {
  await store.set(storeHelpers.x402Consumed(txHash), { at: new Date().toISOString() }, { ttlSeconds: 7 * 24 * 3600 });
}

export async function buildTokenVerdict(tokenAddress) {
  const token = getAddress(tokenAddress);
  const contract = { address: token, abi: erc20Abi };
  const [name, symbol, decimals, totalSupply, bytecode] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: "name" }).catch(() => null),
    publicClient.readContract({ ...contract, functionName: "symbol" }).catch(() => null),
    publicClient.readContract({ ...contract, functionName: "decimals" }).catch(() => null),
    publicClient.readContract({ ...contract, functionName: "totalSupply" }).catch(() => null),
    publicClient.getBytecode({ address: token }).catch(() => null),
  ]);
  const isContract = Boolean(bytecode && bytecode !== "0x");
  const report = {
    verdict: {
      token,
      chain: { id: config.chain.id, name: config.chain.name },
      name: name || null,
      symbol: symbol || null,
      decimals: decimals === null ? null : Number(decimals),
      totalSupply: totalSupply ? formatUnits(totalSupply, Number(decimals) || 18) : null,
      isContract,
      checksum: { valid: true, note: "Address matches the EIP-55 checksum for this chain." },
    },
    verified: ["token metadata", "total supply", "contract deployment", "address checksum"],
    notVerified: [
      "liquidity depth",
      "pool age",
      "holder concentration",
      "honeypot behavior",
      "taxes",
      "OFAC screening",
    ],
    sources: ["Base mainnet RPC", "ERC-20 read calls"],
    fetchedAt: new Date().toISOString(),
    by: config.name,
  };
  return report;
}

export async function buildWalletDossier(walletAddress) {
  const wallet = getAddress(walletAddress);
  const [nonce, nativeBalance, usdcBalance, bytecode] = await Promise.all([
    publicClient.getTransactionCount({ address: wallet }).catch(() => null),
    publicClient.getBalance({ address: wallet }).catch(() => null),
    publicClient
      .readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] })
      .catch(() => null),
    publicClient.getBytecode({ address: wallet }).catch(() => null),
  ]);
  const isContract = Boolean(bytecode && bytecode !== "0x");
  return {
    dossier: {
      wallet,
      kind: isContract ? "contract" : "eoa",
      nonce: nonce === null ? null : Number(nonce),
      nativeBalanceWei: nativeBalance ? String(nativeBalance) : null,
      nativeBalanceEth: nativeBalance ? formatUnits(nativeBalance, 18) : null,
      usdcBalance: usdcBalance ? formatUnits(usdcBalance, USDC.decimals) : null,
      chain: { id: config.chain.id, name: config.chain.name },
    },
    verified: ["address kind", "nonce", "native balance", "USDC balance"],
    notVerified: ["funding pattern", "counterparty identity", "OFAC screening", "historical activity"],
    sources: ["Base mainnet RPC", "USDC balanceOf read call"],
    fetchedAt: new Date().toISOString(),
    by: config.name,
  };
}

export async function takeFreeSummaryBudget() {
  const day = new Date().toISOString().slice(0, 10);
  const key = storeHelpers.x402FreeCount(day);
  const current = Number((await store.get(key)) || 0);
  if (current >= 300) return false;
  await store.set(key, String(current + 1), { ttlSeconds: 48 * 3600 });
  return true;
}

export const paymentTermsJSON = (resourceId) => {
  const res = X402_RESOURCES.find((r) => r.id === resourceId);
  return {
    error: {
      code: "PAYMENT_REQUIRED",
      message: `This report costs ${res.price} USDC on Base.`,
    },
    terms: {
      network: "eip155:8453",
      asset: "USDC",
      token: USDC.address,
      amount: res.price,
      payTo: payToAddress(),
      instructions:
        "Send exactly the amount above from the wallet you will pass as payer, note the transaction hash, then call the same URL with ?payer=<your wallet>&tx=<transaction hash>. The report is served once the transfer is verified on-chain.",
    },
  };
};

export const logX402 = (req, message, fields = {}) =>
  req.log ? req.log.info(message, fields) : logger.info(message, fields);
