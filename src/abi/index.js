// Official ACP (Agent Commerce Protocol) surface, extracted from
// @virtuals-protocol/acp-node-v2 core/acpAbi.js. Only the members this agent
// uses are included.
export const ACP_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "getJob",
    outputs: [
      {
        components: [
          { internalType: "address", name: "client", type: "address" },
          { internalType: "uint8", name: "status", type: "uint8" },
          { internalType: "address", name: "provider", type: "address" },
          { internalType: "uint48", name: "expiredAt", type: "uint48" },
          { internalType: "address", name: "evaluator", type: "address" },
          { internalType: "address", name: "hook", type: "address" },
          { internalType: "uint256", name: "budget", type: "uint256" },
          { internalType: "string", name: "description", type: "string" },
        ],
        internalType: "struct AgenticCommerceV3.Job",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "jobCounter",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "paymentToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes32", name: "deliverable", type: "bytes32" },
      { internalType: "bytes", name: "optParams", type: "bytes" },
    ],
    name: "submit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes32", name: "reason", type: "bytes32" },
      { internalType: "bytes", name: "optParams", type: "bytes" },
    ],
    name: "reject",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "claimRefund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

export const ACP_JOB_STATUS = {
  0: "OPEN",
  1: "FUNDED",
  2: "SUBMITTED",
  3: "COMPLETED",
  4: "REJECTED",
  5: "EXPIRED",
};

// Virtuals bonding-curve router (FRouter) + bonding curve, from the official
// Virtual-Protocol/vp-trade-sdk.
export const VIRTUALS_ROUTER_ABI = [
  {
    inputs: [],
    name: "assetToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "address", name: "assetToken_", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
    ],
    name: "getAmountsOut",
    outputs: [{ internalType: "uint256", name: "_amountOut", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "address", name: "to", type: "address" },
    ],
    name: "buy",
    outputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "address", name: "to", type: "address" },
    ],
    name: "sell",
    outputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
];

export const ERC20_BYTES32_ABI = [
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
];
