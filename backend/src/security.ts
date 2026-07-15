import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.slice("::ffff:".length));
  return false;
}

// Blocks navigation/fetch to private, loopback, link-local, and cloud-metadata
// addresses so this server can't be used as an open SSRF proxy into its own
// network if the shared secret leaks. Does NOT defend against DNS rebinding
// (hostname resolving to a public IP at check-time then a private one at
// request-time) — accepted tradeoff for an internal tool with a small,
// trusted user base rather than a public-facing service.
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new Error(`Refusing to fetch blocked host: ${url.hostname}`);
  }

  const version = isIP(url.hostname);
  const addresses = version
    ? [{ address: url.hostname, family: version }]
    : await lookup(url.hostname, { all: true });

  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (blocked) {
      throw new Error(`Refusing to fetch private/internal address: ${address}`);
    }
  }
}
