import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

type SeedProfile = {
  name: string;
  gender: "male" | "female";
  gender_probability: number;
  age: number;
  age_group: "child" | "teenager" | "adult" | "senior";
  country_id: string;
  country_name: string;
  country_probability: number;
};

const SEED_PATH = path.resolve(process.cwd(), "seed_profiles.json");

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

const run = async (): Promise<void> => {
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

    CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_name_lower ON profiles (LOWER(name));
  `);

  const seedRaw = fs.readFileSync(SEED_PATH, "utf8");
  const seedData = JSON.parse(seedRaw) as { profiles?: SeedProfile[] };
  const rows = Array.isArray(seedData.profiles) ? seedData.profiles : [];

  const resetProfiles = process.env.SEED_RESET === "true" || process.env.SEED_RESET === "1";
  const resetAuth = process.env.AUTH_RESET === "true" || process.env.AUTH_RESET === "1";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (resetAuth) {
      await client.query("TRUNCATE TABLE access_tokens, refresh_tokens, oauth_pkce_states, users RESTART IDENTITY CASCADE");
    }

    if (resetProfiles) {
      await client.query("TRUNCATE TABLE profiles RESTART IDENTITY CASCADE");
    }

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

  const countResult = await pool.query("SELECT COUNT(*)::int AS total FROM profiles");
  console.log(`Seed complete. Source rows: ${rows.length}. Rows currently in DB: ${Number(countResult.rows[0]?.total ?? 0)}.`);
  await pool.end();
};

run().catch(async (error) => {
  console.error("Seeding failed:", error);
  await pool.end();
  process.exit(1);
});
