import { NextFunction, Request, Response } from "express";
import { pool } from "../db";
import { hashToken } from "../utils/crypto";
import { toError } from "../utils/http";
import { AuthUser, Role } from "../types";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export const authenticateAccessToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authorization = req.header("Authorization");
    if (!authorization || !authorization.startsWith("Bearer ")) {
      toError(res, 401, "Authentication required");
      return;
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      toError(res, 401, "Authentication required");
      return;
    }

    const tokenHash = hashToken(token);
    const result = await pool.query(
      `SELECT
        u.id,
        u.github_id,
        u.username,
        u.email,
        u.avatar_url,
        u.role,
        u.is_active,
        u.last_login_at,
        u.created_at
       FROM access_tokens at
       JOIN users u ON u.id = at.user_id
       WHERE at.token_hash = $1
         AND at.is_revoked = FALSE
         AND at.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );

    const row = result.rows[0];
    if (!row) {
      toError(res, 401, "Invalid or expired access token");
      return;
    }

    if (!row.is_active) {
      toError(res, 403, "User account is inactive");
      return;
    }

    req.authUser = {
      id: String(row.id),
      github_id: String(row.github_id),
      username: String(row.username),
      email: row.email ? String(row.email) : null,
      avatar_url: row.avatar_url ? String(row.avatar_url) : null,
      role: String(row.role) as Role,
      is_active: Boolean(row.is_active),
      last_login_at: row.last_login_at ? new Date(String(row.last_login_at)).toISOString() : null,
      created_at: new Date(String(row.created_at)).toISOString()
    };

    next();
  } catch {
    toError(res, 500, "Server failure");
  }
};

export const authorizeRoles = (...allowedRoles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.authUser;
    if (!user) {
      toError(res, 401, "Authentication required");
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      toError(res, 403, "Forbidden");
      return;
    }

    next();
  };
};
