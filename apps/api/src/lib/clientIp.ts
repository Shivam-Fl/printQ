import type { IncomingHttpHeaders } from 'node:http';
import proxyaddr from 'proxy-addr';

/**
 * Client-IP resolution behind a proxy chain, shared by Express (rate limiters,
 * logs) and the socket.io handshake.
 *
 * Production chain: client -> Cloudflare edge -> Render proxy -> app. Cloudflare
 * appends the real client to X-Forwarded-For and Render appends the Cloudflare
 * edge that connected to it, so a fixed "trust proxy = 1" resolves to a
 * *rotating Cloudflare edge IP*, not the client. Instead of counting hops we
 * trust by address: walk X-Forwarded-For from the right, skipping hops that are
 * published Cloudflare ranges (plus loopback/private addresses, i.e. Render's
 * internal proxy), and take the first address we do not trust. Anything a
 * client writes into X-Forwarded-For sits to the LEFT of that address, so it is
 * never reached; CF-Connecting-IP and True-Client-IP are not read at all (they
 * are spoofable when the origin is reached around Cloudflare).
 *
 * TRUST_PROXY modes:
 *   "1" / "2" ... number of trusted proxy hops (Express semantics; default 1)
 *   "cloudflare"  trust Cloudflare ranges + private/loopback hops (+ TRUST_PROXY_CIDRS)
 *   "none"        ignore forwarding headers; use the socket address
 */
export const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

export type TrustProxySetting = number | string[] | false;

export function parseTrustProxy(mode: string, extraCidrs: string[] = []): TrustProxySetting {
  const value = mode.trim().toLowerCase();
  if (value === 'none' || value === '0' || value === 'false') return false;
  if (value === 'cloudflare') {
    return ['loopback', 'linklocal', 'uniquelocal', ...CLOUDFLARE_CIDRS, ...extraCidrs];
  }
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0 && hops <= 10) return hops;
  throw new Error(`TRUST_PROXY must be a hop count, "cloudflare" or "none" (got "${mode}")`);
}

/** Same trust decision Express makes for req.ip, for requests Express never sees (websocket upgrade handshakes). */
export function resolveClientIp(
  setting: TrustProxySetting,
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders,
): string {
  const socketIp = remoteAddress ?? 'unknown';
  if (setting === false) return socketIp;
  try {
    const trust = typeof setting === 'number'
      ? (_addr: string, hop: number) => hop < setting
      : proxyaddr.compile(setting);
    return proxyaddr({ headers, socket: { remoteAddress } } as never, trust as never) || socketIp;
  } catch {
    return socketIp;
  }
}
