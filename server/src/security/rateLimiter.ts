// Login brute-force guard. Keyed by client IP (express-rate-limit's default
// keyGenerator) rather than the submitted username, since limiting per
// username lets an attacker simply cycle usernames to dodge the limit
// entirely — per-IP is the one that actually throttles a scripted guessing
// run. Requires index.ts's `app.set("trust proxy", ...)` to be configured
// correctly (this server sits behind nginx in every real deployment), or
// every request would appear to come from nginx's own loopback address and
// share one bucket across every real client — express-rate-limit itself
// refuses to start in that misconfigured state rather than silently doing
// the wrong thing.
//
// 10 attempts / 15 minutes is generous enough to absorb a real operator
// mistyping a password a few times (including a whole office sharing one
// NAT'd public IP), while still capping a scripted guessing run at under
// 1,000 attempts/day — nowhere near enough to brute-force a real random
// password, and slow enough that it stops being a practical attack path.
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Only failed attempts (401, etc.) count toward the limit — otherwise a
  // legitimate operator who's already logged in successfully several times
  // in one window (multiple tabs, re-logging in after a session expired,
  // ...) would eventually get locked out by their own successful logins,
  // which defeats the point: this guards against guessing, not against
  // being a real, correctly-authenticating user.
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Try again in a few minutes." },
});

// For authenticated, expensive-per-call routes (NL command dispatch,
// installer generation, uploads) shared across every tenant on this
// deployment — keyed by orgId, not IP, so one org's usage can never starve
// another org's bucket (unlike loginRateLimiter, which is deliberately
// per-IP since login has no org-scoped session yet to key on). Falls back
// to req.ip only for the theoretical case of this running before auth
// middleware; every real call site here sits behind session validation.
// The fallback goes through ipKeyGenerator (not a raw req.ip string) —
// express-rate-limit validates at startup that a custom keyGenerator
// normalizes IPv6 addresses this way (an un-normalized IPv6 address lets a
// client bypass the limit by rotating addresses within its own /64),
// refusing to start otherwise (ERR_ERL_KEY_GEN_IPV6).
export function createOrgRateLimiter(opts: { windowMs: number; limit: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => (req as Request & { user?: { orgId?: string } }).user?.orgId ?? ipKeyGenerator(req.ip ?? "unknown"),
    message: { error: opts.message },
  });
}
