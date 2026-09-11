// Execute the actual registered handlers with an in-memory Ponder database.
// This exercises custody accounting and event order without an RPC dependency.
// Run: yarn tsx scripts/check-router-retained-custody.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { toHex, zeroAddress } from "viem";

type Row = Record<string, any>;
const tables = {
  routerPendingCall: "routerPendingCall",
  routerPendingCallEvent: "routerPendingCallEvent",
  routerRetainedBalance: "routerRetainedBalance",
  routerPermitFailureEvent: "routerPermitFailureEvent",
} as const;
type Table = keyof typeof tables;
const keys: Record<Table, string[]> = {
  routerPendingCall: ["chainId", "gateway", "pendingCallId"],
  routerPendingCallEvent: ["id"],
  routerRetainedBalance: ["chainId", "gateway", "sourceProjectId", "token"],
  routerPermitFailureEvent: ["id"],
};
const rows: Record<Table, Map<string, Row>> = {
  routerPendingCall: new Map(),
  routerPendingCallEvent: new Map(),
  routerRetainedBalance: new Map(),
  routerPermitFailureEvent: new Map(),
};
const rowKey = (table: Table, row: Row) => JSON.stringify(keys[table].map((key) => row[key]));
const db = {
  async find(table: Table, key: Row) {
    return rows[table].get(rowKey(table, key)) ?? null;
  },
  insert(table: Table) {
    return {
      values(value: Row) {
        const key = rowKey(table, value);
        const insert = () => {
          assert.ok(!rows[table].has(key), `Duplicate ${table} key ${key}`);
          rows[table].set(key, { ...value });
        };
        return {
          then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            return Promise.resolve().then(insert).then(resolve, reject);
          },
          async onConflictDoUpdate(update: (row: Row) => Row) {
            const previous = rows[table].get(key);
            if (previous) rows[table].set(key, { ...previous, ...update(previous) });
            else insert();
          },
        };
      },
    };
  },
  update(table: Table, key: Row) {
    return {
      async set(update: Row) {
        const id = rowKey(table, key);
        const previous = rows[table].get(id);
        assert.ok(previous, `Missing ${table} key ${id}`);
        rows[table].set(id, { ...previous, ...update });
      },
    };
  },
};

const handlers = new Map<string, (input: Row) => Promise<void>>();
const require = createRequire(import.meta.url);
for (const filename of ["JBRouterTerminalGateway.ts", "JBRouterTerminal.ts"]) {
  const source = readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports: {},
    require(name: string) {
      if (name === "ponder:registry") return {
        ponder: { on(name: string, handler: (input: Row) => Promise<void>) { handlers.set(name, handler); } },
      };
      if (name === "ponder:schema") return tables;
      return require(name);
    },
  });
}
assert.equal(handlers.size, 6);

const gateway = "0x1111111111111111111111111111111111111111";
const gateway2 = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const token = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const errorA = toHex(0x1234n, { size: 32 });
const errorB = toHex(0x5678n, { size: 32 });
const chainId = 84532;
const call = {
  amount: 100n,
  preferAddToBalance: false,
  shouldReturnHeldFees: false,
  beneficiary: payer,
  projectId: 1n,
  refundTo: payer,
  sourceProjectId: 2n,
  token,
};
const call2 = { ...call, amount: 40n };
let logIndex = 0;
async function emit(
  name: string,
  id: bigint,
  args: Row,
  overrides: { chainId?: number; gateway?: string; timestamp?: bigint } = {},
) {
  const handler = handlers.get(`JBRouterTerminalGateway6:JBRouterTerminalGateway_${name}`);
  assert.ok(handler);
  await handler({
    context: { chain: { id: overrides.chainId ?? chainId }, db },
    event: {
      args: { id: toHex(id, { size: 32 }), caller: payer, ...args },
      log: { address: overrides.gateway ?? gateway, logIndex: logIndex++ },
      block: { number: 900n, timestamp: overrides.timestamp ?? 1000n },
      transaction: { hash: toHex(0xbeefn, { size: 32 }), from: payer },
    },
  });
}
async function pending(id: bigint) {
  const row = await db.find("routerPendingCall", { chainId, gateway, pendingCallId: toHex(id, { size: 32 }) });
  assert.ok(row);
  return row;
}
async function balance() {
  const row = await db.find("routerRetainedBalance", { chainId, gateway, sourceProjectId: 2, token });
  assert.ok(row);
  return row;
}
const queue = (call: Row) => ({ call, memo: "retained fee", metadata: "0x1234", errorHash: errorA });

await emit("QueuePendingCall", 1n, queue(call));
await emit("QueuePendingCall", 2n, queue(call2));
assert.equal((await balance()).retainedAmount, 140n);
assert.equal((await balance()).pendingCallCount, 2);
assert.equal((await pending(1n)).failureCount, 0, "Initial queue is not a qualified failure");
assert.equal((await pending(1n)).nextAttemptAt, 0n, "First retry is immediately available");
assert.equal((await pending(1n)).version, 6);
assert.equal((await pending(1n)).metadata, "0x1234");

for (const count of [1, 2, 3]) {
  await emit("RecordTerminalCallFailure", 1n, {
    errorHash: errorA, count, nextAttemptAt: BigInt(count) * 86400n,
  });
}
assert.equal((await pending(1n)).failureCount, 3);
assert.equal((await balance()).retainedAmount, 140n, "Failed retries keep input custody");

// Finalization with a changed failure class stays pending and resets its streak.
await emit("RecordTerminalCallFailure", 1n, { errorHash: errorB, count: 1, nextAttemptAt: 400000n });
assert.equal((await pending(1n)).failureCount, 1);
assert.equal((await pending(1n)).attemptCount, 4);
assert.equal((await pending(1n)).latestErrorHash, errorB);
assert.equal((await pending(1n)).initialErrorHash, errorA);
for (const count of [2, 3]) {
  await emit("RecordTerminalCallFailure", 1n, {
    errorHash: errorB, count, nextAttemptAt: 400000n + BigInt(count) * 86400n,
  });
}
await emit("RefundPendingCall", 1n, { call });
assert.equal((await pending(1n)).status, "refunded");
assert.equal((await pending(1n)).retainedAmount, 0n);
assert.equal((await pending(1n)).nextAttemptAt, null);
assert.equal((await pending(1n)).failureCount, 0);
assert.equal((await pending(1n)).attemptCount, 7);
assert.equal((await balance()).retainedAmount, 40n);
assert.equal((await balance()).refundedAmount, 100n);

// Successful processing needs no failure event; preserve its project-token result.
await emit("ProcessPendingCall", 2n, { call: call2, beneficiaryTokenCount: 5000n });
assert.equal((await pending(2n)).status, "settled");
assert.equal((await pending(2n)).beneficiaryTokenCount, 5000n);
assert.equal((await balance()).settledAmount, 40n);
assert.equal((await balance()).retainedAmount, 0n);
assert.equal((await balance()).pendingCallCount, 0);
assert.equal(rows.routerPendingCallEvent.size, 10);
const history = [...rows.routerPendingCallEvent.values()];
assert.equal(history.reduce((amount, event) => amount + event.retainedAmountDelta, 0n), 0n);
assert.equal(history.at(-2)?.errorHash, errorB, "Refund records the reproduced failure class");
assert.equal(history.at(-1)?.errorHash, null, "Successful retry has no failure");

// Same identifiers on another chain or gateway must never merge their custody.
await emit("QueuePendingCall", 1n, queue(call), { gateway: gateway2 });
await emit("QueuePendingCall", 1n, queue(call), { chainId: 11155111 });
await emit("QueuePendingCall", 3n, queue({
  ...call, sourceProjectId: 7n, preferAddToBalance: true,
  shouldReturnHeldFees: true, beneficiary: zeroAddress,
}));
await emit("QueuePendingCall", 4n, queue({ ...call, token: payer }));
assert.equal(rows.routerRetainedBalance.size, 5);
assert.equal((await balance()).retainedAmount, 0n);
assert.equal((await pending(3n)).preferAddToBalance, true);
assert.equal((await pending(3n)).shouldReturnHeldFees, true);

// Missing queue data and double release must stop indexing, never be swallowed.
await assert.rejects(emit("RecordTerminalCallFailure", 999n, {
  errorHash: errorA, count: 1, nextAttemptAt: 86400n,
}), /Missing active gateway call/);
await assert.rejects(emit("RefundPendingCall", 1n, { call }), /Missing active gateway call/);
await assert.rejects(emit("ProcessPendingCall", 3n, {
  call: { ...call, sourceProjectId: 7n, amount: 999n }, beneficiaryTokenCount: 1n,
}), /does not match queued call/);
assert.equal((await pending(3n)).retainedAmount, 100n);

const permitEvent = {
  args: { token, owner: payer, reason: "0x123456789abc" },
  log: { address: gateway2, logIndex: logIndex++ },
  block: { number: 901n, timestamp: 2000n },
  transaction: { hash: toHex(0xfeedn, { size: 32 }), from: payer },
};
const libraryFailure = handlers.get("JBRouterTerminal6:Permit2AllowanceFailed(address indexed token, address indexed owner, bytes reason)");
const routerFailure = handlers.get("JBRouterTerminal6:Permit2AllowanceFailed(address indexed token, address indexed owner, bytes reason, address caller)");
assert.ok(libraryFailure);
assert.ok(routerFailure);
await libraryFailure({ context: { chain: { id: chainId }, db }, event: permitEvent });
await routerFailure({
  context: { chain: { id: chainId }, db },
  event: { ...permitEvent, args: { ...permitEvent.args, caller: gateway }, log: { ...permitEvent.log, logIndex: logIndex++ } },
});
const permitRows = [...rows.routerPermitFailureEvent.values()];
assert.equal(permitRows.length, 2);
assert.equal(permitRows[0]?.caller, payer);
assert.equal(permitRows[0]?.callerFromEvent, false);
assert.equal(permitRows[1]?.caller, gateway);
assert.equal(permitRows[1]?.callerFromEvent, true);
assert.equal(permitRows[1]?.reason, "0x123456789abc");
assert.equal(permitRows[1]?.terminal, gateway2);
assert.equal(permitRows[1]?.version, 6);

console.log("Router handlers: retained-custody lifecycle, failure streaks, isolation and both permit overloads passed.");
