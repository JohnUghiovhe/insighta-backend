import { Request, Response } from "express";
import { pool } from "../db";
import { Role } from "../types";
import { toError } from "../utils/http";

const isRole = (value: unknown): value is Role => value === "admin" || value === "analyst";

const toIsoOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export const updateUserRole = async (req: Request, res: Response): Promise<void> => {
  const userId = typeof req.params.id === "string" ? req.params.id.trim() : "";
  const role = req.body?.role;

  if (!userId) {
    toError(res, 400, "User ID is required");
    return;
  }

  if (!isRole(role)) {
    toError(res, 400, "role must be admin or analyst");
    return;
  }

  const result = await pool.query(
    `UPDATE users
     SET role = $1
     WHERE id = $2
     RETURNING id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at`,
    [role, userId]
  );

  const updatedUser = result.rows[0];
  if (!updatedUser) {
    toError(res, 404, "User not found");
    return;
  }

  res.status(200).json({
    status: "success",
    data: {
      id: String(updatedUser.id),
      github_id: String(updatedUser.github_id),
      username: String(updatedUser.username),
      email: updatedUser.email ? String(updatedUser.email) : null,
      avatar_url: updatedUser.avatar_url ? String(updatedUser.avatar_url) : null,
      role: String(updatedUser.role) as Role,
      is_active: Boolean(updatedUser.is_active),
      last_login_at: toIsoOrNull(updatedUser.last_login_at),
      created_at: new Date(String(updatedUser.created_at)).toISOString()
    }
  });
};