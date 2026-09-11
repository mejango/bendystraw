import { ponder, type Context } from "ponder:registry";
import {
  routerPendingCall,
  routerPendingCallEvent,
  routerRetainedBalance,
} from "ponder:schema";
import { encodeAbiParameters, keccak256, type Hex } from "viem";

const VERSION = 6;

type GatewayEvent = {
  args: { id: Hex; caller: Hex };
  log: { address: Hex; logIndex: number };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: Hex; from: Hex };
};

type RetainedCall = {
  amount: bigint;
  preferAddToBalance: boolean;
  shouldReturnHeldFees: boolean;
  beneficiary: Hex;
  projectId: bigint;
  refundTo: Hex;
  sourceProjectId: bigint;
  token: Hex;
};

const normalized = (address: Hex) => address.toLowerCase() as Hex;

function callCommitment(call: RetainedCall, memo: string, metadata: Hex) {
  return keccak256(encodeAbiParameters([
    {
      type: "tuple",
      components: [
        { name: "amount", type: "uint256" },
        { name: "preferAddToBalance", type: "bool" },
        { name: "shouldReturnHeldFees", type: "bool" },
        { name: "beneficiary", type: "address" },
        { name: "projectId", type: "uint256" },
        { name: "refundTo", type: "address" },
        { name: "sourceProjectId", type: "uint256" },
        { name: "token", type: "address" },
      ],
    },
    { type: "string" },
    { type: "bytes" },
  ], [call, memo, metadata]));
}

function callKey(event: GatewayEvent, context: Context) {
  return {
    chainId: context.chain.id,
    gateway: normalized(event.log.address),
    pendingCallId: event.args.id,
  };
}

function historyParams(event: GatewayEvent, context: Context) {
  const key = callKey(event, context);
  return {
    ...key,
    id: `${key.chainId}:${key.gateway}:${event.transaction.hash}:${event.log.logIndex}`,
    version: VERSION,
    txHash: event.transaction.hash,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    caller: event.args.caller,
    from: event.transaction.from,
  };
}

// Read Ponder's transaction-aware state, never an end-of-block RPC snapshot:
// queue, retry and resolution can all occur in the same block or transaction.
async function requirePending(event: GatewayEvent, context: Context) {
  const pending = await context.db.find(routerPendingCall, callKey(event, context));
  if (!pending || (pending.status !== "queued" && pending.status !== "retried")) {
    throw new Error(`Missing active gateway call ${event.args.id} on ${context.chain.id}`);
  }
  return pending;
}

ponder.on("JBRouterTerminalGateway6:JBRouterTerminalGateway_QueuePendingCall", async ({ event, context }) => {
  const { call, memo, metadata, errorHash } = event.args;
  const key = callKey(event, context);
  const fields = {
    ...call,
    projectId: Number(call.projectId),
    sourceProjectId: Number(call.sourceProjectId),
    token: normalized(call.token),
  };
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(routerPendingCall).values({
    ...key,
    ...fields,
    version: VERSION,
    retainedAmount: call.amount,
    memo,
    metadata,
    callCommitment: callCommitment(call, memo, metadata),
    status: "queued",
    initialErrorHash: errorHash,
    latestErrorHash: errorHash,
    failureCount: 0,
    attemptCount: 0,
    nextAttemptAt: 0n,
    createdAt: timestamp,
    updatedAt: timestamp,
    queueTxHash: event.transaction.hash,
    latestTxHash: event.transaction.hash,
  });

  await context.db.insert(routerRetainedBalance).values({
    chainId: key.chainId,
    gateway: key.gateway,
    version: VERSION,
    sourceProjectId: fields.sourceProjectId,
    token: fields.token,
    retainedAmount: call.amount,
    pendingCallCount: 1,
    queuedAmount: call.amount,
    settledAmount: 0n,
    refundedAmount: 0n,
    updatedAt: timestamp,
  }).onConflictDoUpdate((balance) => ({
    retainedAmount: balance.retainedAmount + call.amount,
    pendingCallCount: balance.pendingCallCount + 1,
    queuedAmount: balance.queuedAmount + call.amount,
    updatedAt: timestamp,
  }));

  await context.db.insert(routerPendingCallEvent).values({
    ...historyParams(event, context),
    projectId: fields.projectId,
    sourceProjectId: fields.sourceProjectId,
    token: fields.token,
    amount: call.amount,
    retainedAmountDelta: call.amount,
    type: "queued",
    errorHash,
    failureCount: 0,
    nextAttemptAt: 0n,
  });
});

ponder.on("JBRouterTerminalGateway6:JBRouterTerminalGateway_RecordTerminalCallFailure", async ({ event, context }) => {
  const pending = await requirePending(event, context);
  const { errorHash, count, nextAttemptAt } = event.args;
  await context.db.update(routerPendingCall, callKey(event, context)).set({
    status: "retried",
    latestErrorHash: errorHash,
    failureCount: count,
    attemptCount: pending.attemptCount + 1,
    nextAttemptAt,
    updatedAt: Number(event.block.timestamp),
    latestTxHash: event.transaction.hash,
  });

  await context.db.insert(routerPendingCallEvent).values({
    ...historyParams(event, context),
    projectId: pending.projectId,
    sourceProjectId: pending.sourceProjectId,
    token: pending.token,
    amount: pending.amount,
    retainedAmountDelta: 0n,
    type: "retried",
    errorHash,
    // Use the emitted count: a changed failure class resets the streak to one.
    failureCount: count,
    nextAttemptAt,
  });
});

async function resolveCall(
  event: GatewayEvent & { args: { id: Hex; caller: Hex; call: RetainedCall } },
  context: Context,
  status: "settled" | "refunded",
  beneficiaryTokenCount: bigint | null,
) {
  const pending = await requirePending(event, context);
  if (callCommitment(event.args.call, pending.memo, pending.metadata) !== pending.callCommitment) {
    throw new Error(`Gateway resolution does not match queued call ${event.args.id}`);
  }
  const balanceKey = {
    chainId: context.chain.id,
    gateway: normalized(event.log.address),
    sourceProjectId: pending.sourceProjectId,
    token: pending.token,
  };
  const balance = await context.db.find(routerRetainedBalance, balanceKey);
  if (!balance || balance.retainedAmount < pending.amount || balance.pendingCallCount < 1) {
    throw new Error(`Inconsistent gateway custody for call ${event.args.id}`);
  }
  const timestamp = Number(event.block.timestamp);
  await context.db.update(routerRetainedBalance, balanceKey).set({
    retainedAmount: balance.retainedAmount - pending.amount,
    pendingCallCount: balance.pendingCallCount - 1,
    settledAmount: balance.settledAmount + (status === "settled" ? pending.amount : 0n),
    refundedAmount: balance.refundedAmount + (status === "refunded" ? pending.amount : 0n),
    updatedAt: timestamp,
  });
  await context.db.update(routerPendingCall, callKey(event, context)).set({
    status,
    retainedAmount: 0n,
    failureCount: 0,
    attemptCount: pending.attemptCount + 1,
    nextAttemptAt: null,
    beneficiaryTokenCount,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    latestTxHash: event.transaction.hash,
  });
  await context.db.insert(routerPendingCallEvent).values({
    ...historyParams(event, context),
    projectId: pending.projectId,
    sourceProjectId: pending.sourceProjectId,
    token: pending.token,
    amount: pending.amount,
    retainedAmountDelta: -pending.amount,
    type: status,
    // A refund confirms the last failure class; success has no failure.
    errorHash: status === "refunded" ? pending.latestErrorHash : null,
    beneficiaryTokenCount,
  });
}

ponder.on("JBRouterTerminalGateway6:JBRouterTerminalGateway_ProcessPendingCall", async ({ event, context }) => {
  await resolveCall(event, context, "settled", event.args.beneficiaryTokenCount);
});

ponder.on("JBRouterTerminalGateway6:JBRouterTerminalGateway_RefundPendingCall", async ({ event, context }) => {
  await resolveCall(event, context, "refunded", null);
});
