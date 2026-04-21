import express, { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { open, Database } from "sqlite";
import sqlite3 from "sqlite3";

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

type CursorPayload = {
  created_at: string;
  id: string;
};

const app = express();
const PORT = Number(process.env.PORT) || 3021;
const REQUEST_TIMEOUT_MS = 5000;
const DB_DIR = process.env.DB_DIR ? path.resolve(process.env.DB_DIR) : path.resolve(process.cwd(), "data");
const DB_PATH = path.resolve(DB_DIR, "profiles.db");
const SEED_PATH = path.resolve(process.cwd(), "seed_profiles.json");
const ALLOWED_AGE_GROUPS = new Set(["child", "teenager", "adult", "senior"]);
const ALLOWED_SORT_COLUMNS = new Set(["age", "created_at", "gender_probability"]);
const ALLOWED_ORDER = new Set(["asc", "desc"]);

app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error("UPSTREAM_STATUS_ERROR");
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

const isSqliteUniqueNameConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "SQLITE_CONSTRAINT" || error.message.includes("UNIQUE constraint failed: profiles.name");
};

const buildWhereClause = (filters: ParsedFilters): { clause: string; values: Array<string | number> } => {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (filters.gender) {
    where.push("gender = ?");
    values.push(filters.gender);
  }
  if (filters.age_group) {
    where.push("age_group = ?");
    values.push(filters.age_group);
  }
  if (filters.country_id) {
    where.push("country_id = ?");
    values.push(filters.country_id);
  }
  if (typeof filters.min_age === "number") {
    where.push("age >= ?");
    values.push(filters.min_age);
  }
  if (typeof filters.max_age === "number") {
    where.push("age <= ?");
    values.push(filters.max_age);
  }
  if (typeof filters.min_gender_probability === "number") {
    where.push("gender_probability >= ?");
    values.push(filters.min_gender_probability);
  }
  if (typeof filters.min_country_probability === "number") {
    where.push("country_probability >= ?");
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

const parsePagingAndSort = (
  query: Request["query"]
): {
  page?: number;
  limit: number;
  sortBy: "age" | "created_at" | "gender_probability";
  order: "asc" | "desc";
  cursor?: CursorPayload;
} | null => {
  const pageRaw = query.page;
  const limitRaw = query.limit;
  const sortByRaw = query.sort_by;
  const orderRaw = query.order;
  const cursorRaw = query.cursor;

  if (
    Array.isArray(pageRaw) ||
    Array.isArray(limitRaw) ||
    Array.isArray(sortByRaw) ||
    Array.isArray(orderRaw) ||
    Array.isArray(cursorRaw)
  ) {
    return null;
  }

  const limit = limitRaw === undefined ? 10 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return null;
  }

  const sortBy = (typeof sortByRaw === "string" ? sortByRaw.trim().toLowerCase() : "created_at") as
    | "age"
    | "created_at"
    | "gender_probability";
  const order = (typeof orderRaw === "string" ? orderRaw.trim().toLowerCase() : "desc") as "asc" | "desc";

  if (!ALLOWED_SORT_COLUMNS.has(sortBy) || !ALLOWED_ORDER.has(order)) return null;

  let cursor: CursorPayload | undefined;
  if (cursorRaw !== undefined) {
    if (typeof cursorRaw !== "string" || !cursorRaw.trim()) return null;
    if (sortBy !== "created_at") return null;
    if (pageRaw !== undefined) return null;

    try {
      const decoded = Buffer.from(cursorRaw, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded) as CursorPayload;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.created_at !== "string" ||
        !parsed.created_at ||
        typeof parsed.id !== "string" ||
        !parsed.id
      ) {
        return null;
      }
      cursor = parsed;
    } catch {
      return null;
    }
  }

  if (cursor) {
    return { limit, sortBy, order, cursor };
  }

  const page = pageRaw === undefined ? 1 : Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) return null;

  return { page, limit, sortBy, order };
};

const encodeCursor = (row: Pick<ProfileRow, "created_at" | "id">): string => {
  return Buffer.from(
    JSON.stringify({
      created_at: row.created_at,
      id: row.id
    }),
    "utf8"
  ).toString("base64url");
};

const appendCursorCondition = (
  whereClause: string,
  order: "asc" | "desc",
  cursor: CursorPayload,
  values: Array<string | number>
): string => {
  values.push(cursor.created_at, cursor.created_at, cursor.id);
  const comparator = order === "asc" ? ">" : "<";
  const start = values.length - 2;
  const cursorCondition = `(created_at ${comparator} ? OR (created_at = ? AND id ${comparator} ?))`;

  if (!whereClause) {
    return `WHERE ${cursorCondition}`;
  }

  return `${whereClause} AND ${cursorCondition}`;
};

const parseNaturalLanguageQuery = async (db: Database, rawQuery: string): Promise<ParsedFilters | null> => {
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
    const row = await db.get<{ country_id: string }>(
      "SELECT country_id FROM profiles WHERE LOWER(country_name) = LOWER(?) LIMIT 1",
      countryName
    );
    if (row) {
      filters.country_id = row.country_id;
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

const initializeDatabase = async (): Promise<Database> => {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const tableExists = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles'"
  );

  if (tableExists) {
    const columns = await db.all<Array<{ name: string }>>("PRAGMA table_info(profiles)");
    const existingColumnSet = new Set(columns.map((column) => column.name));
    const requiredColumns = [
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
    const isCompatible =
      requiredColumns.every((column) => existingColumnSet.has(column)) && !existingColumnSet.has("sample_size");

    if (!isCompatible) {
      await db.exec("DROP TABLE profiles;");
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      gender TEXT NOT NULL,
      gender_probability REAL NOT NULL,
      age INTEGER NOT NULL,
      age_group TEXT NOT NULL,
      country_id TEXT NOT NULL,
      country_name TEXT NOT NULL,
      country_probability REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await db.exec(`
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

  const seedRaw = fs.readFileSync(SEED_PATH, "utf8");
  const seedData = JSON.parse(seedRaw) as { profiles?: SeedProfile[] };
  const rows = Array.isArray(seedData.profiles) ? seedData.profiles : [];

  for (const profile of rows) {
    await db.run(
      `INSERT OR IGNORE INTO profiles (
        id, name, gender, gender_probability, age, age_group,
        country_id, country_name, country_probability, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generateUuidV7(),
      String(profile.name).trim().toLowerCase(),
      profile.gender,
      Number(profile.gender_probability),
      Number(profile.age),
      profile.age_group,
      String(profile.country_id).toUpperCase(),
      String(profile.country_name).trim(),
      Number(profile.country_probability),
      new Date().toISOString()
    );
  }

  return db;
};

let dbPromise: Promise<Database> | null = null;
const getDb = (): Promise<Database> => {
  if (!dbPromise) dbPromise = initializeDatabase();
  return dbPromise;
};

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/api/profiles", async (req: Request, res: Response) => {
  const parsedName = parseName(req.body?.name);
  if (!parsedName.value) return toError(res, parsedName.code ?? 400, parsedName.message ?? "Missing or empty parameter");

  try {
    const db = await getDb();
    const existing = await db.get<ProfileRow>("SELECT * FROM profiles WHERE name = ? COLLATE NOCASE", parsedName.value);
    if (existing) {
      return res.status(200).json({ status: "success", message: "Profile already exists", data: existing });
    }

    const external = await getExternalData(parsedName.value);
    const countryName =
      (
        await db.get<{ country_name: string }>(
          "SELECT country_name FROM profiles WHERE country_id = ? LIMIT 1",
          external.countryId
        )
      )?.country_name ?? external.countryId;

    const profile: ProfileRow = {
      id: generateUuidV7(),
      name: parsedName.value,
      gender: external.gender,
      gender_probability: external.genderProbability,
      age: external.age,
      age_group: external.ageGroup,
      country_id: external.countryId,
      country_name: countryName,
      country_probability: external.countryProbability,
      created_at: new Date().toISOString()
    };

    try {
      await db.run(
        `INSERT INTO profiles (
          id, name, gender, gender_probability, age, age_group,
          country_id, country_name, country_probability, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    } catch (insertError) {
      if (isSqliteUniqueNameConflict(insertError)) {
        const existingAfterConflict = await db.get<ProfileRow>(
          "SELECT * FROM profiles WHERE name = ? COLLATE NOCASE",
          parsedName.value
        );
        if (existingAfterConflict) {
          return res.status(200).json({
            status: "success",
            message: "Profile already exists",
            data: existingAfterConflict
          });
        }
      }
      throw insertError;
    }

    return res.status(201).json({ status: "success", data: profile });
  } catch (error) {
    const upstreamMessage = getInvalidUpstreamError(error);
    if (upstreamMessage) return toError(res, 502, upstreamMessage);
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        (error.message === "UPSTREAM_STATUS_ERROR" || error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      return toError(res, 502, "Upstream service failure");
    }
    return toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles/search", async (req: Request, res: Response) => {
  try {
    if (Array.isArray(req.query.q) || typeof req.query.q !== "string" || !req.query.q.trim()) {
      return toError(res, 400, "Missing or empty parameter");
    }

    const pageRaw = req.query.page;
    const limitRaw = req.query.limit;
    if (Array.isArray(pageRaw) || Array.isArray(limitRaw)) return toError(res, 422, "Invalid query parameters");

    const page = pageRaw === undefined ? 1 : Number(pageRaw);
    const limit = limitRaw === undefined ? 10 : Number(limitRaw);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return toError(res, 422, "Invalid query parameters");
    }

    const db = await getDb();
    const interpreted = await parseNaturalLanguageQuery(db, req.query.q);
    if (!interpreted) return toError(res, 400, "Unable to interpret query");

    const { clause, values } = buildWhereClause(interpreted);
    const offset = (page - 1) * limit;
    const totalRow = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM profiles ${clause}`,
      ...values
    );
    const rows = await db.all<ProfileRow[]>(
      `SELECT * FROM profiles ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...values,
      limit,
      offset
    );

    return res.status(200).json({
      status: "success",
      page,
      limit,
      total: Number(totalRow?.total ?? 0),
      data: rows
    });
  } catch {
    return toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles/:id", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const profile = await db.get<ProfileRow>("SELECT * FROM profiles WHERE id = ?", req.params.id);
    if (!profile) return toError(res, 404, "Profile not found");
    return res.status(200).json({ status: "success", data: profile });
  } catch {
    return toError(res, 500, "Server failure");
  }
});

app.get("/api/profiles", async (req: Request, res: Response) => {
  try {
    const parsedFilters = parseFilterQuery(req.query);
    const pageSort = parsePagingAndSort(req.query);
    if (!parsedFilters || !pageSort) return toError(res, 422, "Invalid query parameters");

    const db = await getDb();
    const { clause, values } = buildWhereClause(parsedFilters);
    const orderSql = `ORDER BY ${pageSort.sortBy} ${pageSort.order.toUpperCase()}, id ${pageSort.order.toUpperCase()}`;

    const totalRow = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM profiles ${clause}`,
      ...values
    );

    if (pageSort.cursor) {
      const cursorValues = [...values];
      const cursorClause = appendCursorCondition(clause, pageSort.order, pageSort.cursor, cursorValues);
      const rows = await db.all<ProfileRow[]>(
        `SELECT * FROM profiles ${cursorClause} ${orderSql} LIMIT ?`,
        ...cursorValues,
        pageSort.limit + 1
      );

      const hasMore = rows.length > pageSort.limit;
      const data = hasMore ? rows.slice(0, pageSort.limit) : rows;
      const nextCursor = hasMore && data.length > 0 ? encodeCursor(data[data.length - 1]) : null;

      return res.status(200).json({
        status: "success",
        limit: pageSort.limit,
        total: Number(totalRow?.total ?? 0),
        next_cursor: nextCursor,
        data
      });
    }

    const offset = ((pageSort.page ?? 1) - 1) * pageSort.limit;
    const rows = await db.all<ProfileRow[]>(
      `SELECT * FROM profiles ${clause} ${orderSql} LIMIT ? OFFSET ?`,
      ...values,
      pageSort.limit,
      offset
    );

    return res.status(200).json({
      status: "success",
      page: pageSort.page,
      limit: pageSort.limit,
      total: Number(totalRow?.total ?? 0),
      data: rows
    });
  } catch {
    return toError(res, 500, "Server failure");
  }
});

app.delete("/api/profiles/:id", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const result = await db.run("DELETE FROM profiles WHERE id = ?", req.params.id);
    if (result.changes === 0) return toError(res, 404, "Profile not found");
    return res.status(204).send();
  } catch {
    return toError(res, 500, "Server failure");
  }
});

const startServer = async (): Promise<void> => {
  await getDb();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

export default app;
