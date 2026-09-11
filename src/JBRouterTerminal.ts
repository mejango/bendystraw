import { ponder, type Context } from "ponder:registry";
import { routerPermitFailureEvent } from "ponder:schema";
import type { Hex } from "viem";

type PermitFailureEvent = {
  args: { token: Hex; owner: Hex; reason: Hex; caller?: Hex };
  log: { address: Hex; logIndex: number };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: Hex; from: Hex };
};

async function recordPermitFailure(event: PermitFailureEvent, context: Context) {
  const terminal = event.log.address.toLowerCase() as Hex;
  await context.db.insert(routerPermitFailureEvent).values({
    id: `${context.chain.id}:${terminal}:${event.transaction.hash}:${event.log.logIndex}`,
    chainId: context.chain.id,
    version: 6,
    terminal,
    token: event.args.token,
    owner: event.args.owner,
    reason: event.args.reason,
    caller: event.args.caller ?? event.transaction.from,
    callerFromEvent: event.args.caller !== undefined,
    from: event.transaction.from,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
    logIndex: event.log.logIndex,
  });
}

ponder.on("JBRouterTerminal6:Permit2AllowanceFailed(address indexed token, address indexed owner, bytes reason)", async ({ event, context }) => {
  await recordPermitFailure(event, context);
});

ponder.on("JBRouterTerminal6:Permit2AllowanceFailed(address indexed token, address indexed owner, bytes reason, address caller)", async ({ event, context }) => {
  await recordPermitFailure(event, context);
});
