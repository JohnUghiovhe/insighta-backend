import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

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

const DB_DIR = process.env.DB_DIR ? path.resolve(process.env.DB_DIR) : path.resolve(process.cwd(), "data");
const DB_PATH = path.resolve(DB_DIR, "profiles.db");
const SEED_PATH = path.resolve(process.cwd(), "seed_profiles.json");

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
  fs.mkdirSync(DB_DIR, { recursive: true });

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

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

  const seedRaw = fs.readFileSync(SEED_PATH, "utf8");
  const seedData = JSON.parse(seedRaw) as { profiles?: SeedProfile[] };
  const rows = Array.isArray(seedData.profiles) ? seedData.profiles : [];

  await db.exec("BEGIN");
  try {
    const stmt = await db.prepare(
      `INSERT OR IGNORE INTO profiles (
        id, name, gender, gender_probability, age, age_group,
        country_id, country_name, country_probability, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    try {
      for (const profile of rows) {
        await stmt.run(
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
    } finally {
      await stmt.finalize();
    }

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }

  const countRow = await db.get<{ total: number }>("SELECT COUNT(*) as total FROM profiles");
  await db.close();

  console.log(`Seed complete. Source rows: ${rows.length}. Rows currently in DB: ${Number(countRow?.total ?? 0)}.`);
};

run().catch((error) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});
