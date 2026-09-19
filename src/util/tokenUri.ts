import { encodedIpfsUriToCid } from "./cid";
import { parseProjectMetadata } from "./projectMetadata";

export const parseTokenUri = <T extends object>(tokenUri: string) => {
  try {
    const base64 = tokenUri.split("data:application/json;base64,")[1];
    return base64 ? (JSON.parse(atob(base64)) as T) : undefined;
  } catch (e) {
    console.warn("Failed to parse tokenUri", tokenUri);
  }
};

// A tier's resolvedUri is only populated when the hook has a tokenUriResolver
// (Banny). Every other hook serves the tier's own encodedIPFSUri, so fall
// back to fetching that JSON from IPFS the way project metadata is.
export async function parseTierMetadata({
  resolvedUri,
  encodedIpfsUri,
}: {
  resolvedUri: string;
  encodedIpfsUri: string | null | undefined;
}) {
  const fromResolver = parseTokenUri(resolvedUri);
  if (fromResolver) return fromResolver;

  const cid = encodedIpfsUriToCid(encodedIpfsUri);
  if (!cid) return undefined;

  return (await parseProjectMetadata(`ipfs://${cid}`)) ?? undefined;
}
