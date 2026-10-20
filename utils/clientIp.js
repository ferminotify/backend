// The client's address, for rate limits. X-Forwarded-For is written by whoever sends the
// request, so it is only believed when the request comes from our own reverse proxy (a
// loopback or private address: Caddy/nginx on the host, Docker's bridge), and then only
// its last entry, the one the proxy appended. A request reaching the port directly
// counts as its own address.
// Behind a hosted proxy chain (Render sits behind Cloudflare) the last entry is the chain's
// own hop, shared by everybody: CLIENT_IP_HEADER names the header that chain sets to the
// real client and cannot be forged through it (e.g. true-client-ip or cf-connecting-ip).
const PRIVATE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80:)/i;

const bare = (ip) => String(ip || '').replace(/^::ffff:/i, '');

export function clientIp(req) {
  const remote = bare(req.socket?.remoteAddress || req.ip);
  if (!PRIVATE.test(remote)) return remote;
  const header = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  const trusted = header && bare(String(req.headers[header] || '').split(',')[0].trim());
  if (trusted) return trusted;
  const hops = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => bare(s.trim()))
    .filter(Boolean);
  return hops[hops.length - 1] || remote;
}
