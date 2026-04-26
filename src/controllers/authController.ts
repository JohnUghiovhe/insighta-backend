import { Request, Response } from "express";
import { pool, withTransaction } from "../db";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, REQUEST_TIMEOUT_MS } from "../config";
import { createOpaqueToken, createPkceChallenge, generateUuidV7, hashToken } from "../utils/crypto";
import { toError } from "../utils/http";
import { Role } from "../types";

const toIso = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
};

const issueTokenPair = async (client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, userId: string) => {
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);

  await client.query(
    `INSERT INTO access_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '3 minutes')`,
    [generateUuidV7(), userId, accessTokenHash]
  );

  await client.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
    [generateUuidV7(), userId, refreshTokenHash]
  );

  return {
    accessToken,
    refreshToken,
    accessTokenHash,
    refreshTokenHash
  };
};

const fetchJson = async <T>(url: string, headers?: Record<string, string>): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers });
  if (!response.ok) {
    throw new Error("UPSTREAM_STATUS_ERROR");
  }
  return (await response.json()) as T;
};

const exchangeGithubCode = async (
  githubClientId: string,
  githubClientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<string> => {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: githubClientId,
      client_secret: githubClientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!tokenResponse.ok) {
    throw new Error("GITHUB_TOKEN_EXCHANGE_FAILED");
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    throw new Error("GITHUB_TOKEN_EXCHANGE_FAILED");
  }

  return tokenPayload.access_token;
};

const upsertUserAndIssueTokens = async (
  githubAccessToken: string
): Promise<{
  user: Record<string, unknown>;
  tokenPair: Awaited<ReturnType<typeof issueTokenPair>>;
}> =>
  withTransaction(async (client) => {
    const githubUser = await fetchJson<{
      id: number;
      login: string;
      avatar_url: string;
      email: string | null;
    }>("https://api.github.com/user", {
      Authorization: `Bearer ${githubAccessToken}`,
      "User-Agent": "insighta-labs-plus"
    });

    let email = githubUser.email;
    if (!email) {
      try {
        const emailResult = await fetchJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
          "https://api.github.com/user/emails",
          {
            Authorization: `Bearer ${githubAccessToken}`,
            "User-Agent": "insighta-labs-plus"
          }
        );
        const primaryVerified = emailResult.find((item) => item.primary && item.verified);
        email = primaryVerified?.email ?? null;
      } catch {
        email = null;
      }
    }

    const userResult = await client.query(
      `INSERT INTO users (
        id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'analyst', TRUE, NOW(), NOW())
      ON CONFLICT (github_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        email = EXCLUDED.email,
        avatar_url = EXCLUDED.avatar_url,
        last_login_at = NOW()
      RETURNING id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at`,
      [generateUuidV7(), String(githubUser.id), githubUser.login, email, githubUser.avatar_url]
    );

    const user = userResult.rows[0];
    const tokenPair = await issueTokenPair(client, String(user.id));
    return { user, tokenPair };
  });

const sendAuthSuccess = (res: Response, result: { user: Record<string, unknown>; tokenPair: Awaited<ReturnType<typeof issueTokenPair>> }) => {
  res.status(200).json({
    status: "success",
    access_token: result.tokenPair.accessToken,
    refresh_token: result.tokenPair.refreshToken,
    access_token_expires_in_seconds: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token_expires_in_seconds: REFRESH_TOKEN_TTL_MS / 1000,
    data: {
      id: String(result.user.id),
      github_id: String(result.user.github_id),
      username: String(result.user.username),
      email: result.user.email ? String(result.user.email) : null,
      avatar_url: result.user.avatar_url ? String(result.user.avatar_url) : null,
      role: String(result.user.role) as Role,
      is_active: Boolean(result.user.is_active),
      last_login_at: toIso(result.user.last_login_at),
      created_at: toIso(result.user.created_at)
    }
  });
};

export const githubLogin = async (_req: Request, res: Response): Promise<void> => {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubRedirectUri = process.env.GITHUB_REDIRECT_URI;

  if (!githubClientId || !githubRedirectUri) {
    toError(res, 500, "GitHub OAuth is not configured");
    return;
  }

  const state = createOpaqueToken();
  const codeVerifier = createOpaqueToken();
  const codeChallenge = createPkceChallenge(codeVerifier);

  await pool.query(
    `INSERT INTO oauth_pkce_states (state, code_verifier, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [state, codeVerifier]
  );

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", githubClientId);
  authorizeUrl.searchParams.set("redirect_uri", githubRedirectUri);
  authorizeUrl.searchParams.set("scope", process.env.GITHUB_SCOPE || "read:user user:email");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  res.redirect(authorizeUrl.toString());
};

export const githubLoginInit = async (_req: Request, res: Response): Promise<void> => {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  if (!githubClientId) {
    toError(res, 500, "GitHub OAuth is not configured");
    return;
  }

  res.status(200).json({
    status: "success",
    client_id: githubClientId,
    scope: process.env.GITHUB_SCOPE || "read:user user:email"
  });
};

export const githubCallback = async (req: Request, res: Response): Promise<void> => {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const githubRedirectUri = process.env.GITHUB_REDIRECT_URI;

  if (!githubClientId || !githubClientSecret || !githubRedirectUri) {
    toError(res, 500, "GitHub OAuth is not configured");
    return;
  }

  if (Array.isArray(req.query.code) || Array.isArray(req.query.state)) {
    toError(res, 400, "Invalid OAuth callback parameters");
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  if (!code || !state) {
    toError(res, 400, "Invalid OAuth callback parameters");
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      const pkceResult = await client.query(
        `SELECT code_verifier
         FROM oauth_pkce_states
         WHERE state = $1 AND expires_at > NOW()
         LIMIT 1`,
        [state]
      );

      const pkceState = pkceResult.rows[0];
      if (!pkceState?.code_verifier) {
        throw new Error("INVALID_OAUTH_STATE");
      }

      await client.query("DELETE FROM oauth_pkce_states WHERE state = $1", [state]);

      const githubAccessToken = await exchangeGithubCode(
        githubClientId,
        githubClientSecret,
        code,
        githubRedirectUri,
        String(pkceState.code_verifier)
      );
      return upsertUserAndIssueTokens(githubAccessToken);
    });

    sendAuthSuccess(res, result);
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_OAUTH_STATE") {
      toError(res, 400, "Invalid or expired OAuth state");
      return;
    }
    if (error instanceof Error && error.message === "GITHUB_TOKEN_EXCHANGE_FAILED") {
      toError(res, 502, "GitHub token exchange failed");
      return;
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      toError(res, 502, "GitHub request timeout");
      return;
    }
    toError(res, 500, "Server failure");
  }
};

export const githubCliExchange = async (req: Request, res: Response): Promise<void> => {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!githubClientId || !githubClientSecret) {
    toError(res, 500, "GitHub OAuth is not configured");
    return;
  }

  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const codeVerifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier.trim() : "";
  const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri.trim() : "";
  if (!code || !codeVerifier || !redirectUri) {
    toError(res, 400, "code, code_verifier and redirect_uri are required");
    return;
  }

  try {
    const githubAccessToken = await exchangeGithubCode(githubClientId, githubClientSecret, code, redirectUri, codeVerifier);
    const result = await upsertUserAndIssueTokens(githubAccessToken);
    sendAuthSuccess(res, result);
  } catch (error) {
    if (error instanceof Error && error.message === "GITHUB_TOKEN_EXCHANGE_FAILED") {
      toError(res, 502, "GitHub token exchange failed");
      return;
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      toError(res, 502, "GitHub request timeout");
      return;
    }
    toError(res, 500, "Server failure");
  }
};

export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  const refreshTokenValue = req.body?.refresh_token;
  if (typeof refreshTokenValue !== "string" || !refreshTokenValue.trim()) {
    toError(res, 400, "refresh_token is required");
    return;
  }

  try {
    const refreshTokenHash = hashToken(refreshTokenValue);
    const result = await withTransaction(async (client) => {
      const tokenResult = await client.query(
        `SELECT rt.id, rt.user_id, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1
           AND rt.is_revoked = FALSE
           AND rt.expires_at > NOW()
         LIMIT 1`,
        [refreshTokenHash]
      );

      const tokenRow = tokenResult.rows[0];
      if (!tokenRow) {
        throw new Error("INVALID_REFRESH_TOKEN");
      }

      if (!tokenRow.is_active) {
        throw new Error("INACTIVE_USER");
      }

      const newTokenPair = await issueTokenPair(client, String(tokenRow.user_id));

      await client.query(
        `UPDATE refresh_tokens
         SET is_revoked = TRUE,
             replaced_by_token_hash = $2
         WHERE id = $1`,
        [tokenRow.id, newTokenPair.refreshTokenHash]
      );

      return newTokenPair;
    });

    res.status(200).json({
      status: "success",
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      access_token_expires_in_seconds: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token_expires_in_seconds: REFRESH_TOKEN_TTL_MS / 1000
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_REFRESH_TOKEN") {
      toError(res, 401, "Invalid or expired refresh token");
      return;
    }
    if (error instanceof Error && error.message === "INACTIVE_USER") {
      toError(res, 403, "User account is inactive");
      return;
    }
    toError(res, 500, "Server failure");
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  const refreshTokenValue = req.body?.refresh_token;
  if (typeof refreshTokenValue !== "string" || !refreshTokenValue.trim()) {
    toError(res, 400, "refresh_token is required");
    return;
  }

  try {
    const refreshTokenHash = hashToken(refreshTokenValue);
    await pool.query(
      `UPDATE refresh_tokens
       SET is_revoked = TRUE
       WHERE token_hash = $1 AND is_revoked = FALSE`,
      [refreshTokenHash]
    );

    res.status(200).json({
      status: "success",
      message: "Logged out"
    });
  } catch {
    toError(res, 500, "Server failure");
  }
};
