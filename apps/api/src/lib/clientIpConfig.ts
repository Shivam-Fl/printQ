import { env } from '../config/env.js';
import { parseTrustProxy, resolveClientIp } from './clientIp.js';
import type { IncomingHttpHeaders } from 'node:http';

export const trustProxySetting = parseTrustProxy(env.TRUST_PROXY, env.TRUST_PROXY_CIDRS);

/** Client IP for a raw Node request/handshake, using the same rules as Express's req.ip. */
export function clientIpOf(remoteAddress: string | undefined, headers: IncomingHttpHeaders): string {
  return resolveClientIp(trustProxySetting, remoteAddress, headers);
}
