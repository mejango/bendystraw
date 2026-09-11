import { ROLLOUT_DEPLOYMENTS } from "./rolloutDeployments";

export type RolloutDeployment = typeof ROLLOUT_DEPLOYMENTS.deployments[number];
export type RolloutChain = RolloutDeployment["chain"] | "optimismSepolia";
export type RolloutContract = RolloutDeployment["contract"];
type NetworkChain<Testnet extends boolean> = Testnet extends true
  ? Extract<RolloutChain, `${string}Sepolia`>
  : Exclude<RolloutChain, `${string}Sepolia`>;

/** Ponder watches every deployed generation from the first receipt on each chain. */
export function rolloutChains<Testnet extends boolean>(contract: RolloutContract, testnet: Testnet) {
  const result: Record<string, { address: `0x${string}`[]; startBlock: number }> = {};
  for (const deployment of ROLLOUT_DEPLOYMENTS.deployments) {
    if (deployment.contract !== contract || deployment.testnet !== testnet) continue;
    const address = deployment.address as `0x${string}`;
    const previous = result[deployment.chain];
    result[deployment.chain] = previous
      ? { address: [...new Set([...previous.address, address])], startBlock: Math.min(previous.startBlock, deployment.startBlock) }
      : { address: [address], startBlock: deployment.startBlock };
  }
  // Ponder enumerates only present keys. This dictionary type keeps its virtual
  // Context from including undefined chains while narrowing each network's keys.
  // An empty map enables no sources: proposals never activate a mainnet gateway.
  return result as Record<NetworkChain<Testnet>, { address: `0x${string}`[]; startBlock: number }>;
}

export function firstRolloutBlock(contract: RolloutContract, chain: RolloutChain) {
  const blocks = ROLLOUT_DEPLOYMENTS.deployments
    .filter((deployment) => deployment.contract === contract && deployment.chain === chain)
    .map((deployment) => deployment.startBlock);
  if (!blocks.length) throw new Error(`No deployment receipt for ${contract} on ${chain}`);
  return Math.min(...blocks);
}
