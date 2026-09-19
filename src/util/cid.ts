const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// Subdomain gateways serve content from `https://<cid>.<gateway>`, and DNS
// labels are case-insensitive, so a base58 CIDv0 has to be re-encoded as a
// base32 CIDv1 before it can be used as a subdomain.
export function toCidV1(cid: string) {
  if (!cid.startsWith("Qm")) {
    // Already a CIDv1. projectMetadataPath only admits base32, whose alphabet
    // survives lowercasing, so this is safe for the base32upper "B" form too.
    return cid.toLowerCase();
  }

  const multihash = base58Decode(cid);

  // A CIDv0 is always the sha2-256 (0x12) 32-byte (0x20) multihash of a dag-pb
  // node. Anything else isn't representable by the prefix we add below.
  if (
    !multihash ||
    multihash.length !== 34 ||
    multihash[0] !== 0x12 ||
    multihash[1] !== 0x20
  ) {
    return null;
  }

  // 0x01 = CIDv1, 0x70 = dag-pb.
  return `b${base32Encode(Uint8Array.from([0x01, 0x70, ...multihash]))}`;
}

function base58Decode(value: string) {
  const bytes = [0];

  for (const char of value) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry === -1) return null;

    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading "1" encodes a leading zero byte.
  for (let i = 0; i < value.length && value[i] === "1"; i++) {
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

// RFC 4648 base32, lowercase and unpadded, as multibase "b" requires.
function base32Encode(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let encoded = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return encoded;
}

// JB721 tiers store their IPFS pointer as the 32-byte sha2-256 digest of a
// CIDv0 (JBIpfsDecoder in nana-721-hook). Re-add the 0x1220 multihash prefix
// and base58-encode to get the `Qm…` CID back. Null for the zero value.
export function encodedIpfsUriToCid(encodedIpfsUri: string | null | undefined) {
  if (!encodedIpfsUri || !/^0x[0-9a-f]{64}$/i.test(encodedIpfsUri)) return null;
  if (/^0x0+$/.test(encodedIpfsUri)) return null;
  const digest = Buffer.from(encodedIpfsUri.slice(2), "hex");
  return base58Encode(Uint8Array.from([0x12, 0x20, ...digest]));
}

function base58Encode(bytes: Uint8Array) {
  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;

    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let encoded = "";
  // Each leading zero byte encodes as a leading "1".
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) encoded += "1";
  for (let i = digits.length - 1; i >= 0; i--) encoded += BASE58_ALPHABET[digits[i]!];

  return encoded;
}
