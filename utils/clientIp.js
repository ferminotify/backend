// The client's address, for rate limits. X-Forwarded-For is written by whoever sends the
// request, so it is only believed when the request comes from our own reverse proxy (a
// loopback or private address: Caddy/nginx on the host, Docker's bridge), and then only
// its last entry, the one the proxy appended. A request reaching the port directly
// counts as its own address.
const PRIVATE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80:)/i;

const bare = (ip) => String(ip || '').replace(/^::ffff:/i, '');

export function clientIp(req) {
  const remote = bare(req.socket?.remoteAddress || req.ip);
  if (!PRIVATE.test(remote)) return remote;
  const hops = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => bare(s.trim()))
    .filter(Boolean);
  return hops[hops.length - 1] || remote;
}
