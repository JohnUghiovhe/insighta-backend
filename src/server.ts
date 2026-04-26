import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Pool, PoolClient } from "pg";

type GenderizeResponse = {
  count: number | null;
  gender: "male" | "female" | null;
  probability: number | null;
};

type AgifyResponse = {
  age: number | null;
};

type NationalizeCountry = {
  country_id: string;
  probability: number;
};

type NationalizeResponse = {
  country: NationalizeCountry[];
};

type ProfileRow = {
  id: string;
  name: string;
  gender: "male" | "female";
  gender_probability: number;
  age: number;
  age_group: "child" | "teenager" | "adult" | "senior";
  country_id: string;
  country_name: string;
  country_probability: number;
  created_at: string;
};

type SeedProfile = Omit<ProfileRow, "id" | "created_at">;

type ParsedFilters = {
  gender?: "male" | "female";
  age_group?: "child" | "teenager" | "adult" | "senior";
  country_id?: string;
  min_age?: number;
  max_age?: number;
  min_gender_probability?: number;
  min_country_probability?: number;
};

type PagingAndSort = {
  page: number;
  limit: number;
  sortBy: "age" | "created_at" | "gender_probability";
  order: "asc" | "desc";
};

type Role = "admin" | "analyst";

type AuthUser = {
  id: string;
  github_id: string;
  username: string;
  email: string | null;
  avatar_url: string | null;
  role: Role;
  is_active: boolean;
};

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 3021;
const REQUEST_TIMEOUT_MS = 5000;
const SEED_PATH = path.resolve(process.cwd(), "seed_profiles.json");
const ALLOWED_AGE_GROUPS = new Set(["child", "teenager", "adult", "senior"]);
const ALLOWED_SORT_COLUMNS = new Set(["age", "created_at", "gender_probability"]);
const ALLOWED_ORDER = new Set(["asc", "desc"]);
const ACCESS_TOKEN_TTL_MS = 3 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 5 * 60 * 1000;
const PKCE_STATE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 120;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

const rateStore = new Map<string, { count: number; windowStart: number }>();

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }
  next();
});

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = rateStore.get(ip);

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateStore.set(ip, { count: 1, windowStart: now });
  } else {
    current.count += 1;
    if (current.count > RATE_LIMIT_MAX_REQUESTS) {
      toError(res, 429, "Too many requests");
      return;
    }
  }

  // Opportunistic cleanup to keep memory bounded.
  if (rateStore.size > 10_000) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [key, value] of rateStore.entries()) {
      if (value.windowStart < cutoff) {
        rateStore.delete(key);
      }
    }
  }

  next();
});

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: durationMs,
        user_id: req.authUser?.id ?? null,
        ip: req.ip || req.socket.remoteAddress || "unknown"
      })
    );
  });
  next();
});

const toError = (res: Response, code: number, message: string): void => {
  res.status(code).json({ status: "error", message });
};

const generateUuidV7 = (): string => {
  const timestamp = BigInt(Date.now());
  const bytes = randomBytes(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const hashToken = (rawToken: string): string => {
  return createHash("sha256").update(rawToken).digest("hex");
};

const createOpaqueToken = (): string => {
  return randomBytes(48).toString("base64url");
};

const createPkceChallenge = (codeVerifier: string): string => {
  return createHash("sha256").update(codeVerifier).digest("base64url");
};

const toIso = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
};

const normalizeProfileRow = (row: Record<string, unknown>): ProfileRow => {
  return {
    id: String(row.id),
    name: String(row.name),
    gender: String(row.gender) as ProfileRow["gender"],
    gender_probability: Number(row.gender_probability),
    age: Number(row.age),
    age_group: String(row.age_group) as ProfileRow["age_group"],
    country_id: String(row.country_id),
    country_name: String(row.country_name),
    country_probability: Number(row.country_probability),
    created_at: toIso(row.created_at)
  };
};

const getAgeGroup = (age: number): "child" | "teenager" | "adult" | "senior" => {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
};

const parseName = (name: unknown): { value?: string; code?: number; message?: string } => {
  if (name === undefined || name === null) return { code: 400, message: "Missing or empty parameter" };
  if (typeof name !== "string") return { code: 422, message: "Invalid parameter type" };
  const value = name.trim().toLowerCase();
  if (!value) return { code: 400, message: "Missing or empty parameter" };
  return { value };
};

const fetchJson = async <T>(url: string, headers?: Record<string, string>): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers });
  if (!response.ok) {
    throw new Error("UPSTREAM_STATUS_ERROR");
  }
  return (await response.json()) as T;
};

const getExternalData = async (
  name: string
): Promise<{
  gender: "male" | "female";
  genderProbability: number;
  age: number;
  ageGroup: "child" | "teenager" | "adult" | "senior";
  countryId: string;
  countryProbability: number;
}> => {
  const [genderize, agify, nationalize] = await Promise.all([
    fetchJson<GenderizeResponse>(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
    fetchJson<AgifyResponse>(`https://api.agify.io?name=${encodeURIComponent(name)}`),
    fetchJson<NationalizeResponse>(`https://api.nationalize.io?name=${encodeURIComponent(name)}`)
  ]);

  if (!genderize.gender) throw new Error("Genderize_INVALID");
  if (agify.age === null || Number.isNaN(Number(agify.age))) throw new Error("Agify_INVALID");
  if (!Array.isArray(nationalize.country) || nationalize.country.length === 0) throw new Error("Nationalize_INVALID");

  const topCountry = nationalize.country.reduce((best, current) =>
    current.probability > best.probability ? current : best
  );
  const age = Number(agify.age);

  return {
    gender: genderize.gender,
    genderProbability: Number(genderize.probability ?? 0),
    age,
    ageGroup: getAgeGroup(age),
    countryId: topCountry.country_id.toUpperCase(),
    countryProbability: Number(topCountry.probability ?? 0)
  };
};

const getInvalidUpstreamError = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  if (error.message.startsWith("Genderize_")) return "Genderize returned an invalid response";
  if (error.message.startsWith("Agify_")) return "Agify returned an invalid response";
  if (error.message.startsWith("Nationalize_")) return "Nationalize returned an invalid response";
  return null;
};

const buildWhereClause = (filters: ParsedFilters): { clause: string; values: Array<string | number> } => {
  const where: string[] = [];
  const values: Array<string | number> = [];
  let index = 1;

  if (filters.gender) {
    where.push(`gender = $${index++}`);
    values.push(filters.gender);
  }
  if (filters.age_group) {
    where.push(`age_group = $${index++}`);
    values.push(filters.age_group);
  }
  if (filters.country_id) {
    where.push(`country_id = $${index++}`);
    values.push(filters.country_id);
  }
  if (typeof filters.min_age === "number") {
    where.push(`age >= $${index++}`);
    values.push(filters.min_age);
  }
  if (typeof filters.max_age === "number") {
    where.push(`age <= $${index++}`);
    values.push(filters.max_age);
  }
  if (typeof filters.min_gender_probability === "number") {
    where.push(`gender_probability >= $${index++}`);
    values.push(filters.min_gender_probability);
  }
  if (typeof filters.min_country_probability === "number") {
    where.push(`country_probability >= $${index++}`);
    values.push(filters.min_country_probability);
  }

  return {
    clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    values
  };
};

const ensureValidNumber = (value: unknown): number | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return "invalid";
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return "invalid";
  return parsed;
};

const parseFilterQuery = (query: Request["query"]): ParsedFilters | null => {
  const filters: ParsedFilters = {};

  const readSingle = (key: string): string | undefined | "invalid" => {
    const val = query[key];
    if (val === undefined) return undefined;
    if (Array.isArray(val) || typeof val !== "string") return "invalid";
    const trimmed = val.trim();
    if (!trimmed) return "invalid";
    return trimmed;
  };

  const gender = readSingle("gender");
  const ageGroup = readSingle("age_group");
  const countryId = readSingle("country_id");
  const minAge = ensureValidNumber(readSingle("min_age"));
  const maxAge = ensureValidNumber(readSingle("max_age"));
  const minGenderProbability = ensureValidNumber(readSingle("min_gender_probability"));
  const minCountryProbability = ensureValidNumber(readSingle("min_country_probability"));

  if (
    gender === "invalid" ||
    ageGroup === "invalid" ||
    countryId === "invalid" ||
    minAge === "invalid" ||
    maxAge === "invalid" ||
    minGenderProbability === "invalid" ||
    minCountryProbability === "invalid"
  ) {
    return null;
  }

  if (gender) {
    const parsedGender = gender.toLowerCase();
    if (parsedGender !== "male" && parsedGender !== "female") return null;
    filters.gender = parsedGender;
  }

  if (ageGroup) {
    const parsedAgeGroup = ageGroup.toLowerCase();
    if (!ALLOWED_AGE_GROUPS.has(parsedAgeGroup)) return null;
    filters.age_group = parsedAgeGroup as ParsedFilters["age_group"];
  }

  if (countryId) {
    const parsedCountryId = countryId.toUpperCase();
    if (!/^[A-Z]{2}$/.test(parsedCountryId)) return null;
    filters.country_id = parsedCountryId;
  }

  if (typeof minAge === "number") filters.min_age = minAge;
  if (typeof maxAge === "number") filters.max_age = maxAge;
  if (typeof minGenderProbability === "number" && minGenderProbability >= 0 && minGenderProbability <= 1) {
    filters.min_gender_probability = minGenderProbability;
  } else if (minGenderProbability !== undefined) {
    return null;
  }
  if (typeof minCountryProbability === "number" && minCountryProbability >= 0 && minCountryProbability <= 1) {
    filters.min_country_probability = minCountryProbability;
  } else if (minCountryProbability !== undefined) {
    return null;
  }

  if (
    typeof filters.min_age === "number" &&
    typeof filters.max_age === "number" &&
    filters.min_age > filters.max_age
  ) {
    return null;
  }

  return filters;
};

const parsePagingAndSort = (query: Request["query"]): PagingAndSort | null => {
  const pageRaw = query.page;
  const limitRaw = query.limit;
  const sortByRaw = query.sort_by;
  const orderRaw = query.order;

  if (Array.isArray(pageRaw) || Array.isArray(limitRaw) || Array.isArray(sortByRaw) || Array.isArray(orderRaw)) {
    return null;
  }

  const page = pageRaw === undefined ? 1 : Number(pageRaw);
  const limit = limitRaw === undefined ? 10 : Number(limitRaw);

  if (!Number.isInteger(page) || page < 1) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return null;

  const sortBy = (typeof sortByRaw === "string" ? sortByRaw.trim().toLowerCase() : "created_at") as
    | "age"
    | "created_at"
    | "gender_probability";
  const order = (typeof orderRaw === "string" ? orderRaw.trim().toLowerCase() : "desc") as "asc" | "desc";

  if (!ALLOWED_SORT_COLUMNS.has(sortBy) || !ALLOWED_ORDER.has(order)) return null;

  return { page, limit, sortBy, order };
};

const parseNaturalLanguageQuery = async (db: Queryable, rawQuery: string): Promise<ParsedFilters | null> => {
  const q = rawQuery.toLowerCase().trim().replace(/\s+/g, " ");
  if (!q) return null;

  const filters: ParsedFilters = {};
  const hasMale = /\bmale(s)?\b/.test(q) || /\bman\b/.test(q) || /\bmen\b/.test(q);
  const hasFemale = /\bfemale(s)?\b/.test(q) || /\bwoman\b/.test(q) || /\bwomen\b/.test(q);

  if (hasMale && !hasFemale) filters.gender = "male";
  if (hasFemale && !hasMale) filters.gender = "female";

  if (/\byoung\b/.test(q)) {
    filters.min_age = 16;
    filters.max_age = 24;
  }

  if (/\bchild(ren)?\b/.test(q)) filters.age_group = "child";
  if (/\bteen(age|ager|agers)?\b/.test(q)) filters.age_group = "teenager";
  if (/\badult(s)?\b/.test(q)) filters.age_group = "adult";
  if (/\bsenior(s)?\b/.test(q) || /\belderly\b/.test(q)) filters.age_group = "senior";

  const above = q.match(/\b(?:above|over|older than|greater than)\s+(\d{1,3})\b/);
  const below = q.match(/\b(?:below|under|younger than|less than)\s+(\d{1,3})\b/);
  if (above) filters.min_age = Number(above[1]);
  if (below) filters.max_age = Number(below[1]);

  const from = q.match(/\bfrom\s+([a-z ]+?)\b(?:\s+(?:with|and|above|below|under|over|older|younger)|$)/);
  if (from) {
    const countryName = from[1].trim().replace(/\s+/g, " ");
    const result = await db.query(
      "SELECT country_id FROM profiles WHERE LOWER(country_name) = LOWER($1) LIMIT 1",
      [countryName]
    );
    const row = result.rows[0];
    if (row?.country_id) {
      filters.country_id = String(row.country_id);
    } else {
      return null;
    }
  }

  const hasAnyFilter = Object.keys(filters).length > 0;
  if (!hasAnyFilter) return null;
  if (
    typeof filters.min_age === "number" &&
    typeof filters.max_age === "number" &&
    filters.min_age > filters.max_age
  ) {
    return null;
  }

  return filters;
};

const buildPaginationLinks = (req: Request, page: number, limit: number, totalPages: number) => {
  const build = (targetPage: number | null): string | null => {
    if (targetPage === null) return null;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") {
        params.set(key, value);
      }
    }
    params.set("page", String(targetPage));
    params.set("limit", String(limit));
    return `${req.path}?${params.toString()}`;
  };

  return {
    self: build(page),
    next: totalPages > 0 && page < totalPages ? build(page + 1) : null,
    prev: page > 1 && totalPages > 0 ? build(page - 1) : null
  };
};

const toCsvValue = (value: string | number): string => {
  const asString = String(value);
  if (asString.includes(",") || asString.includes("\"") || asString.includes("\n")) {
    return `"${asString.replace(/\"/g, "\"\"")}"`;
  }
  return asString;
};

const profilesToCsv = (rows: ProfileRow[]): string => {
  const headers = [
    "id",
    "name",
    "gender",
    "gender_probability",
    "age",
    "age_group",
    "country_id",
    "country_name",
    "country_probability",
    "created_at"
  ];

  const body = rows.map((row) =>
    [
      row.id,
      row.name,
      row.gender,
      row.gender_probability,
      row.age,
      row.age_group,
      row.country_id,
      row.country_name,
      row.country_probability,
      row.created_at
    ]
      .map((cell) => toCsvValue(cell))
      .join(",")
  );

  return [headers.join(","), ...body].join("\n");
};

const issueTokenPair = async (
  db: PoolClient,
  userId: string
): Promise<{ accessToken: string; refreshToken: string; accessTokenHash: string; refreshTokenHash: string }> => {
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);

  await db.query(
    `INSERT INTO access_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '3 minutes')`,
    [generateUuidV7(), userId, accessTokenHash]
  );

  await db.query(
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

const authenticateAccessToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        u.is_active
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
      is_active: Boolean(row.is_active)
    };

    next();
  } catch {
    toError(res, 500, "Server failure");
  }
};

const authorizeRoles = (...allowedRoles: Role[]) => {
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

const requireApiVersion = (req: Request, res: Response, next: NextFunction): void => {
  const version = req.header("X-API-Version");
  if (version !== "1") {
    toError(res, 400, "API version header required");
    return;
  }
  next();
};

const initializeDatabase = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      gender TEXT NOT NULL,
      gender_probability DOUBLE PRECISION NOT NULL,
      age INTEGER NOT NULL,
      age_group TEXT NOT NULL,
      country_id TEXT NOT NULL,
      country_name TEXT NOT NULL,
      country_probability DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_name_lower ON profiles (LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_profiles_gender ON profiles(gender);
    CREATE INDEX IF NOT EXISTS idx_profiles_age_group ON profiles(age_group);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_id ON profiles(country_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_age ON profiles(age);
    CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at);
    CREATE INDEX IF NOT EXISTS idx_profiles_gender_probability ON profiles(gender_probability);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_probability ON profiles(country_probability);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_name ON profiles(country_name);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_name_lower ON profiles(LOWER(country_name));
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      github_id VARCHAR(128) NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      avatar_url TEXT,
      role VARCHAR(20) NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_pkce_states (
      state VARCHAR(255) PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
      replaced_by_token_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_access_tokens_token_hash ON access_tokens(token_hash);
  `);

  const seedRaw = fs.readFileSync(SEED_PATH, "utf8");
  const seedData = JSON.parse(seedRaw) as { profiles?: SeedProfile[] };
  const rows = Array.isArray(seedData.profiles) ? seedData.profiles : [];

  const countResult = await pool.query("SELECT COUNT(*)::int AS total FROM profiles");
  const existingTotal = Number(countResult.rows[0]?.total ?? 0);
  if (existingTotal >= rows.length) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const profile of rows) {
      await client.query(
        `INSERT INTO profiles (
           id, name, gender, gender_probability, age, age_group,
           country_id, country_name, country_probability, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (LOWER(name)) DO NOTHING`,
        [
          generateUuidV7(),
          String(profile.name).trim().toLowerCase(),
          profile.gender,
          Number(profile.gender_probability),
          Number(profile.age),
          profile.age_group,
          String(profile.country_id).toUpperCase(),
          String(profile.country_name).trim(),
          Number(profile.country_probability)
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/auth/github", async (_req: Request, res: Response) => {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubRedirectUri = process.env.GITHUB_REDIRECT_URI;

  if (!githubClientId || !githubRedirectUri) {
    toError(res, 500, "GitHub OAuth is not configured");
    return;
  }

  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
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
});

app.get("/auth/github/callback", async (req: Request, res: Response) => {
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const pkceResult = await client.query(
      `SELECT code_verifier
       FROM oauth_pkce_states
       WHERE state = $1 AND expires_at > NOW()
       LIMIT 1`,
      [state]
    );

    const pkceState = pkceResult.rows[0];
    if (!pkceState?.code_verifier) {
      await client.query("ROLLBACK");
      toError(res, 400, "Invalid or expired OAuth state");
      return;
    }

    await client.query("DELETE FROM oauth_pkce_states WHERE state = $1", [state]);

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
        redirect_uri: githubRedirectUri,
        code_verifier: String(pkceState.code_verifier)
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!tokenResponse.ok) {
      await client.query("ROLLBACK");
      toError(res, 502, "GitHub token exchange failed");
      return;
    }

    const tokenPayload = (await tokenResponse.json()) as { access_token?: string; error?: string };
    if (!tokenPayload.access_token) {
      await client.query("ROLLBACK");
      toError(res, 502, "GitHub token exchange failed");
      return;
    }

    const githubUser = (await fetchJson<{
      id: number;
      login: string;
      avatar_url: string;
      email: string | null;
    }>("https://api.github.com/user", {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      "User-Agent": "insighta-labs-plus"
    })) as {
      id: number;
      login: string;
      avatar_url: string;
      email: string | null;
    };

    let email = githubUser.email;
    if (!email) {
      try {
        const emailResult = await fetchJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
          "https://api.github.com/user/emails",
          {
            Authorization: `Bearer ${tokenPayload.access_token}`,
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

    await client.query("COMMIT");

    res.status(200).json({
      status: "success",
      access_token: tokenPair.accessToken,
      refresh_token: tokenPair.refreshToken,
      access_token_expires_in_seconds: 180,
      refresh_token_expires_in_seconds: 300,
      data: {
        id: String(user.id),
        github_id: String(user.github_id),
        username: String(user.username),
        email: user.email ? String(user.email) : null,
        avatar_url: user.avatar_url ? String(user.avatar_url) : null,
        role: String(user.role),
        is_active: Boolean(user.is_active),
        last_login_at: toIso(user.last_login_at),
        created_at: toIso(user.created_at)
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      toError(res, 502, "GitHub request timeout");
      return;
    }
    toError(res, 500, "Server failure");
  } finally {
    client.release();
  }
});

app.post("/auth/refresh", async (req: Request, res: Response) => {
  const refreshToken = req.body?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    toError(res, 400, "refresh_token is required");
    return;
  }

  const refreshTokenHash = hashToken(refreshToken);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
      await client.query("ROLLBACK");
      toError(res, 401, "Invalid or expired refresh token");
      return;
    }

    if (!tokenRow.is_active) {
      await client.query("ROLLBACK");
      toError(res, 403, "User account is inactive");
      return;
    }

    const newTokenPair = await issueTokenPair(client, String(tokenRow.user_id));

    await client.query(
      `UPDATE refresh_tokens
       SET is_revoked = TRUE,
           replaced_by_token_hash = $2
       WHERE id = $1`,
      [tokenRow.id, newTokenPair.refreshTokenHash]
    );

    await client.query("COMMIT");

    res.status(200).json({
      status: "success",
      access_token: newTokenPair.accessToken,
      refresh_token: newTokenPair.refreshToken,
      access_token_expires_in_seconds: 180,
      refresh_token_expires_in_seconds: 300
    });
  } catch {
    await client.query("ROLLBACK");
    toError(res, 500, "Server failure");
  } finally {
    client.release();
  }
});

app.post("/auth/logout", async (req: Request, res: Response) => {
  const refreshToken = req.body?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    toError(res, 400, "refresh_token is required");
    return;
  }

  try {
    const refreshTokenHash = hashToken(refreshToken);
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
});

app.use("/api", authenticateAccessToken);
app.use("/api/profiles", requireApiVersion);

app.post("/api/profiles", authorizeRoles("admin"), async (req: Request, res: Response) => {
  const parsedName = parseName(req.body?.name);
  if (!parsedName.value) {
    toError(res, parsedName.code ?? 400, parsedName.message ?? "Missing or empty parameter");
    return;
  }

  try {
    const existingResult = await pool.query("SELECT * FROM profiles WHERE LOWER(name) = LOWER($1) LIMIT 1", [
      parsedName.value
    ]);
    const existing = existingResult.rows[0];
    if (existing) {
      res.status(200).json({ status: "success", message: "Profile already exists", data: normalizeProfileRow(existing) });
      return;
    }

    const external = await getExternalData(parsedName.value);
    const countryResult = await pool.query("SELECT country_name FROM profiles WHERE country_id = $1 LIMIT 1", [
      external.countryId
    ]);

    const profile: ProfileRow = {
      id: generateUuidV7(),
      name: parsedName.value,
      gender: external.gender,
      gender_probability: external.genderProbability,
      age: external.age,
      age_group: external.ageGroup,
      country_id: external.countryId,
      country_name: countryResult.rows[0]?.country_name ? String(countryResult.rows[0].country_name) : external.countryId,
      country_probability: external.countryProbability,
      created_at: new Date().toISOString()
    };

    try {
      await pool.query(
        `INSERT INTO profiles (
          id, name, gender, gender_probability, age, age_group,
          country_id, country_name, country_probability, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          profile.id,
          profile.name,
          profile.gender,
          profile.gender_probability,
          profile.age,
          profile.age_group,
          profile.country_id,
          profile.country_name,
          profile.country_probability,
          profile.created_at
        ]
      );
    } catch (insertError) {
      if ((insertError as { code?: string }).code === "23505") {
        const existingAfterConflict = await pool.query("SELECT * FROM profiles WHERE LOWER(name) = LOWER($1) LIMIT 1", [
          parsedName.value
        ]);
        if (existingAfterConflict.rows[0]) {
          res.status(200).json({
            status: "success",
            message: "Profile already exists",
            data: normalizeProfileRow(existingAfterConflict.rows[0])
          });
          return;
        }
      }
      throw insertError;
    }

    res.status(201).json({ status: "success", data: profile });
  } catch (error) {
    const upstreamMessage = getInvalidUpstreamError(error);
    if (upstreamMessage) {
      toError(res, 502, upstreamMessage);
      return;
    }
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        (error.message === "UPSTREAM_STATUS_ERROR" || error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      toError(res, 502, "Upstream service failure");
      return;
    }
    toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles/search", authorizeRoles("admin", "analyst"), async (req: Request, res: Response) => {
  try {
    if (Array.isArray(req.query.q) || typeof req.query.q !== "string" || !req.query.q.trim()) {
      toError(res, 400, "Missing or empty parameter");
      return;
    }

    const pageRaw = req.query.page;
    const limitRaw = req.query.limit;
    if (Array.isArray(pageRaw) || Array.isArray(limitRaw)) {
      toError(res, 422, "Invalid query parameters");
      return;
    }

    const page = pageRaw === undefined ? 1 : Number(pageRaw);
    const limit = limitRaw === undefined ? 10 : Number(limitRaw);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      toError(res, 422, "Invalid query parameters");
      return;
    }

    const interpreted = await parseNaturalLanguageQuery(pool, req.query.q);
    if (!interpreted) {
      toError(res, 400, "Unable to interpret query");
      return;
    }

    const { clause, values } = buildWhereClause(interpreted);
    const offset = (page - 1) * limit;

    const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM profiles ${clause}`, values);
    const total = Number(totalResult.rows[0]?.total ?? 0);

    const listResult = await pool.query(
      `SELECT * FROM profiles ${clause} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    res.status(200).json({
      status: "success",
      page,
      limit,
      total,
      total_pages: totalPages,
      links: buildPaginationLinks(req, page, limit, totalPages),
      data: listResult.rows.map((row) => normalizeProfileRow(row))
    });
  } catch {
    toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles/:id", authorizeRoles("admin", "analyst"), async (req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT * FROM profiles WHERE id = $1 LIMIT 1", [req.params.id]);
    const profile = result.rows[0];
    if (!profile) {
      toError(res, 404, "Profile not found");
      return;
    }
    res.status(200).json({ status: "success", data: normalizeProfileRow(profile) });
  } catch {
    toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles", authorizeRoles("admin", "analyst"), async (req: Request, res: Response) => {
  try {
    const parsedFilters = parseFilterQuery(req.query);
    const pageSort = parsePagingAndSort(req.query);
    if (!parsedFilters || !pageSort) {
      toError(res, 422, "Invalid query parameters");
      return;
    }

    const { clause, values } = buildWhereClause(parsedFilters);
    const orderBy = `${pageSort.sortBy} ${pageSort.order.toUpperCase()}, id ${pageSort.order.toUpperCase()}`;
    const offset = (pageSort.page - 1) * pageSort.limit;

    const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM profiles ${clause}`, values);
    const total = Number(totalResult.rows[0]?.total ?? 0);

    const listResult = await pool.query(
      `SELECT * FROM profiles ${clause} ORDER BY ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSort.limit, offset]
    );

    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSort.limit);

    res.status(200).json({
      status: "success",
      page: pageSort.page,
      limit: pageSort.limit,
      total,
      total_pages: totalPages,
      links: buildPaginationLinks(req, pageSort.page, pageSort.limit, totalPages),
      data: listResult.rows.map((row) => normalizeProfileRow(row))
    });
  } catch {
    toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles/export", authorizeRoles("admin", "analyst"), async (req: Request, res: Response) => {
  try {
    const format = req.query.format;
    if (format !== "csv") {
      toError(res, 422, "Invalid export format");
      return;
    }

    const parsedFilters = parseFilterQuery(req.query);
    const pageSort = parsePagingAndSort(req.query);
    if (!parsedFilters || !pageSort) {
      toError(res, 422, "Invalid query parameters");
      return;
    }

    const { clause, values } = buildWhereClause(parsedFilters);
    const orderBy = `${pageSort.sortBy} ${pageSort.order.toUpperCase()}, id ${pageSort.order.toUpperCase()}`;

    const result = await pool.query(`SELECT * FROM profiles ${clause} ORDER BY ${orderBy}`, values);
    const rows = result.rows.map((row) => normalizeProfileRow(row));
    const csv = profilesToCsv(rows);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="profiles_${timestamp}.csv"`);
    res.status(200).send(csv);
  } catch {
    toError(res, 500, "Server failure");
  }
});

app.delete("/api/profiles/:id", authorizeRoles("admin"), async (req: Request, res: Response) => {
  try {
    const result = await pool.query("DELETE FROM profiles WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) {
      toError(res, 404, "Profile not found");
      return;
    }
    res.status(204).send();
  } catch {
    toError(res, 500, "Server failure");
  }
});

const startServer = async (): Promise<void> => {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

export default app;