import express, { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
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
  gender: string;
  gender_probability: number;
  sample_size: number;
  age: number;
  age_group: string;
  country_id: string;
  country_probability: number;
  created_at: string;
};

const app = express();
const PORT = Number(process.env.PORT) || 3021;
const REQUEST_TIMEOUT_MS = 5000;
const DB_DIR = process.env.DB_DIR ? path.resolve(process.env.DB_DIR) : path.resolve(process.cwd(), "data");
const DB_PATH = path.resolve(DB_DIR, "profiles.db");

app.use(express.json());

// Required so browser clients can call this endpoint cross-origin.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

const toError = (res: Response, code: number, message: string): void => {
  res.status(code).json({ status: "error", message });
};

const generateUuidV7 = (): string => {
  const timestamp = BigInt(Date.now());
  const bytes = randomBytes(16);

  // First 48 bits are unix epoch milliseconds.
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  // Version 7 and RFC 4122 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const parseName = (name: unknown): { value?: string; code?: number; message?: string } => {
  if (name === undefined || name === null) {
    return { code: 400, message: "Missing or empty name" };
  }

  if (typeof name !== "string") {
    return { code: 422, message: "Invalid type" };
  }

  const value = name.trim().toLowerCase();
  if (!value) {
    return { code: 400, message: "Missing or empty name" };
  }

  return { value };
};

const getAgeGroup = (age: number): "child" | "teenager" | "adult" | "senior" => {
  if (age <= 12) {
    return "child";
  }
  if (age <= 19) {
    return "teenager";
  }
  if (age <= 59) {
    return "adult";
  }
  return "senior";
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
  sampleSize: number;
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

  if (genderize.gender === null || Number(genderize.count ?? 0) === 0) {
    throw new Error("Genderize_INVALID");
  }

  if (agify.age === null) {
    throw new Error("Agify_INVALID");
  }

  if (!Array.isArray(nationalize.country) || nationalize.country.length === 0) {
    throw new Error("Nationalize_INVALID");
  }

  const topCountry = nationalize.country.reduce((best, current) => {
    return current.probability > best.probability ? current : best;
  });

  const age = Number(agify.age);

  return {
    gender: genderize.gender,
    genderProbability: Number(genderize.probability ?? 0),
    sampleSize: Number(genderize.count ?? 0),
    age,
    ageGroup: getAgeGroup(age),
    countryId: topCountry.country_id,
    countryProbability: Number(topCountry.probability)
  };
};

const toProfileResponse = (profile: ProfileRow) => ({
  id: profile.id,
  name: profile.name,
  gender: profile.gender,
  gender_probability: profile.gender_probability,
  sample_size: profile.sample_size,
  age: profile.age,
  age_group: profile.age_group,
  country_id: profile.country_id,
  country_probability: profile.country_probability,
  created_at: profile.created_at
});

const toProfileListItem = (profile: ProfileRow) => ({
  id: profile.id,
  name: profile.name,
  gender: profile.gender,
  age: profile.age,
  age_group: profile.age_group,
  country_id: profile.country_id
});

const getInvalidUpstreamError = (error: unknown): string | null => {
  if (!(error instanceof Error)) {
    return null;
  }

  if (error.message.startsWith("Genderize_")) {
    return "Genderize returned an invalid response";
  }

  if (error.message.startsWith("Agify_")) {
    return "Agify returned an invalid response";
  }

  if (error.message.startsWith("Nationalize_")) {
    return "Nationalize returned an invalid response";
  }

  return null;
};

const isSqliteUniqueNameConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === "SQLITE_CONSTRAINT") {
    return true;
  }

  return error.message.includes("UNIQUE constraint failed: profiles.name");
};

const initializeDatabase = async (): Promise<Database> => {
  fs.mkdirSync(DB_DIR, { recursive: true });

  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      gender TEXT NOT NULL,
      gender_probability REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      age INTEGER NOT NULL,
      age_group TEXT NOT NULL,
      country_id TEXT NOT NULL,
      country_probability REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return db;
};

let dbPromise: Promise<Database> | null = null;

const getDb = (): Promise<Database> => {
  if (!dbPromise) {
    dbPromise = initializeDatabase();
  }
  return dbPromise;
};

app.post("/api/profiles", async (req: Request, res: Response) => {
    const parsedName = parseName(req.body?.name);
    if (!parsedName.value) {
      return toError(res, parsedName.code ?? 400, parsedName.message ?? "Missing or empty name");
    }

    try {
      const db = await getDb();
      const existingProfile = await db.get<ProfileRow>(
        "SELECT * FROM profiles WHERE LOWER(name) = LOWER(?)",
        parsedName.value
      );

      if (existingProfile) {
        return res.status(200).json({
          status: "success",
          message: "Profile already exists",
          data: toProfileResponse(existingProfile)
        });
      }

      const external = await getExternalData(parsedName.value);
      const profile: ProfileRow = {
        id: generateUuidV7(),
        name: parsedName.value,
        gender: external.gender,
        gender_probability: external.genderProbability,
        sample_size: external.sampleSize,
        age: external.age,
        age_group: external.ageGroup,
        country_id: external.countryId,
        country_probability: external.countryProbability,
        created_at: new Date().toISOString()
      };

      try {
        await db.run(
          `INSERT INTO profiles (
            id, name, gender, gender_probability, sample_size,
            age, age_group, country_id, country_probability, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          profile.id,
          profile.name,
          profile.gender,
          profile.gender_probability,
          profile.sample_size,
          profile.age,
          profile.age_group,
          profile.country_id,
          profile.country_probability,
          profile.created_at
        );
      } catch (insertError) {
        // Handle create races idempotently: another request inserted same name first.
        if (isSqliteUniqueNameConflict(insertError)) {
          const existingAfterConflict = await db.get<ProfileRow>(
            "SELECT * FROM profiles WHERE LOWER(name) = LOWER(?)",
            parsedName.value
          );

          if (existingAfterConflict) {
            return res.status(200).json({
              status: "success",
              message: "Profile already exists",
              data: toProfileResponse(existingAfterConflict)
            });
          }
        }

        throw insertError;
      }

      return res.status(201).json({
        status: "success",
        data: toProfileResponse(profile)
      });
    } catch (error) {
      const upstreamMessage = getInvalidUpstreamError(error);
      if (upstreamMessage) {
        return toError(res, 502, upstreamMessage);
      }

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

app.get("/api/profiles/:id", async (req: Request, res: Response) => {
    try {
      const db = await getDb();
      const profile = await db.get<ProfileRow>("SELECT * FROM profiles WHERE id = ?", req.params.id);
      if (!profile) {
        return toError(res, 404, "Profile not found");
      }

      return res.status(200).json({
        status: "success",
        data: toProfileResponse(profile)
      });
    } catch {
      return toError(res, 500, "Server failure");
    }
});

app.get("/api/profiles", async (req: Request, res: Response) => {
    try {
      const db = await getDb();
      const filters: string[] = [];
      const params: string[] = [];
      const allowedGenders = new Set(["male", "female"]);
      const allowedAgeGroups = new Set(["child", "teenager", "adult", "senior"]);

      const gender = typeof req.query.gender === "string" ? req.query.gender.trim().toLowerCase() : undefined;
      const countryId = typeof req.query.country_id === "string" ? req.query.country_id.trim().toUpperCase() : undefined;
      const ageGroup = typeof req.query.age_group === "string" ? req.query.age_group.trim().toLowerCase() : undefined;

      if (gender && !allowedGenders.has(gender)) {
        return toError(res, 422, "Invalid gender filter");
      }
      if (countryId && !/^[A-Z]{2}$/.test(countryId)) {
        return toError(res, 422, "Invalid country_id filter");
      }
      if (ageGroup && !allowedAgeGroups.has(ageGroup)) {
        return toError(res, 422, "Invalid age_group filter");
      }

      if (gender) {
        filters.push("LOWER(gender) = ?");
        params.push(gender);
      }
      if (countryId) {
        filters.push("UPPER(country_id) = ?");
        params.push(countryId);
      }
      if (ageGroup) {
        filters.push("LOWER(age_group) = ?");
        params.push(ageGroup);
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      const rows = await db.all<ProfileRow[]>(`SELECT * FROM profiles ${whereClause} ORDER BY created_at DESC`, ...params);

      return res.status(200).json({
        status: "success",
        count: rows.length,
        data: rows.map(toProfileListItem)
      });
    } catch {
      return toError(res, 500, "Server failure");
    }
});

app.delete("/api/profiles/:id", async (req: Request, res: Response) => {
    try {
      const db = await getDb();
      const result = await db.run("DELETE FROM profiles WHERE id = ?", req.params.id);
      if (result.changes === 0) {
        return toError(res, 404, "Profile not found");
      }

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
