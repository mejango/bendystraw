export const ALLOWED_ORIGINS = [
  "https://retail.banny.eth.sucks",
  "https://retail.banny.eth.shop",
  "https://juicebox.money",
  "https://sepolia.juicebox.money",
  "https://www.juicebox.money",
  "https://app.revnet.eth.sucks",
  "https://revnet.app",
  "https://www.revnet.app",
];

const IPFS_GATEWAY_HOSTS = new Set([
  "cloudflare-ipfs.com",
  "dweb.link",
  "gateway.pinata.cloud",
  "ipfs.io",
]);

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isIpfsGateway(hostname: string) {
  return (
    IPFS_GATEWAY_HOSTS.has(hostname) ||
    hostname.endsWith(".ipfs.dweb.link") ||
    hostname.endsWith(".ipfs.inbrowser.link")
  );
}

export function allowedCorsOrigin(origin: string) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;

  try {
    const url = new URL(origin);
    if (isLocalhost(url.hostname)) return origin;
    if (isIpfsGateway(url.hostname)) return origin;
  } catch {
    return null;
  }

  return null;
}
