// Role-based access control — see schema.sql's users.role column comment
// for the three roles' meaning. This is the single place the role enum and
// its ordering-free permission checks live; routes.ts never compares role
// strings directly, always through requireRole, so a typo'd role name
// fails closed (unrecognized role matches nothing) rather than silently
// granting access.
import type { Request, Response, NextFunction } from "express";

export const ROLES = ["admin", "it_support", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

interface RoleAwareRequest extends Request {
  user?: { role: Role };
}

// Express middleware factory: 403s any request whose session role isn't in
// `allowed`. Must run after the base session-auth middleware (routes.ts)
// so req.user is already populated — never used standalone.
export function requireRole(...allowed: Role[]) {
  return (req: RoleAwareRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Your account does not have permission to do this." });
      return;
    }
    next();
  };
}
