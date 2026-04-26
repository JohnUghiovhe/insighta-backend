import { Request, Response } from "express";
import { pool } from "../db";
import { generateUuidV7 } from "../utils/crypto";
import { toError } from "../utils/http";
import {
  ALLOWED_AGE_GROUPS,
  ALLOWED_ORDER,
  ALLOWED_SORT_COLUMNS,
  REQUEST_TIMEOUT_MS
} from "../config";
import {
  AgifyResponse,
  GenderizeResponse,
  NationalizeResponse,
  ParsedFilters,
  PagingAndSort,
  ProfileRow,
  Queryable
} from "../types";

const toIso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
};

const normalizeProfileRow = (row: Record<string, unknown>): ProfileRow => ({
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
});

const getAgeGroup = (age: number): ProfileRow["age_group"] => {
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
  if (!response.ok) throw new Error("UPSTREAM_STATUS_ERROR");
  return (await response.json()) as T;
};

const getExternalData = async (
  name: string
): Promise<{
  gender: "male" | "female";
  genderProbability: number;
  age: number;
  ageGroup: ProfileRow["age_group"];
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

  return { clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", values };
};

const ensureValidNumber = (value: unknown): number | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return "invalid";
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return "invalid";
  return parsed;
};

export const parseFilterQuery = (query: Request["query"]): ParsedFilters | null => {
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

export const parsePagingAndSort = (query: Request["query"]): PagingAndSort | null => {
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

  let cursor: { created_at: string; id: string } | undefined;
  if (cursorRaw !== undefined) {
    if (typeof cursorRaw !== "string" || !cursorRaw.trim()) return null;
    if (sortBy !== "created_at") return null;
    if (pageRaw !== undefined) return null;
    try {
      const decoded = Buffer.from(cursorRaw, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded) as { created_at?: string; id?: string };
      if (!parsed.created_at || !parsed.id) return null;
      cursor = { created_at: parsed.created_at, id: parsed.id };
    } catch {
      return null;
    }
  }

  if (cursor) {
    return { limit, sortBy, order, cursor };
  }

  return { page, limit, sortBy, order };
};

export const encodeCursor = (row: Pick<ProfileRow, "created_at" | "id">): string => {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), "utf8").toString("base64url");
};

export const appendCursorCondition = (
  whereClause: string,
  order: "asc" | "desc",
  cursor: { created_at: string; id: string },
  values: Array<string | number>
): string => {
  values.push(cursor.created_at, cursor.created_at, cursor.id);
  const comparator = order === "asc" ? ">" : "<";
  const baseIndex = values.length - 2;
  const cursorCondition = `(created_at ${comparator} $${baseIndex} OR (created_at = $${baseIndex + 1} AND id ${comparator} $${baseIndex + 2}))`;
  return whereClause ? `${whereClause} AND ${cursorCondition}` : `WHERE ${cursorCondition}`;
};

const buildPaginationLinks = (req: Request, page: number, limit: number, totalPages: number) => {
  const build = (targetPage: number | null): string | null => {
    if (targetPage === null) return null;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") params.set(key, value);
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
    const result = await db.query("SELECT country_id FROM profiles WHERE LOWER(country_name) = LOWER($1) LIMIT 1", [
      countryName
    ]);
    const row = result.rows[0];
    if (row?.country_id) {
      filters.country_id = String(row.country_id);
    } else {
      return null;
    }
  }

  if (Object.keys(filters).length === 0) return null;
  if (typeof filters.min_age === "number" && typeof filters.max_age === "number" && filters.min_age > filters.max_age) {
    return null;
  }

  return filters;
};

const isUniqueNameConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return (error as { code?: string }).code === "23505";
};

export const createProfileHandlers = () => {
  const createProfile = async (req: Request, res: Response) => {
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
        if (isUniqueNameConflict(insertError)) {
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
  };

  const searchProfiles = async (req: Request, res: Response) => {
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
  };

  const getProfile = async (req: Request, res: Response) => {
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
  };

  const listProfiles = async (req: Request, res: Response) => {
    try {
      const parsedFilters = parseFilterQuery(req.query);
      const pageSort = parsePagingAndSort(req.query);
      if (!parsedFilters || !pageSort) {
        toError(res, 422, "Invalid query parameters");
        return;
      }

      const { clause, values } = buildWhereClause(parsedFilters);
      const orderBy = `${pageSort.sortBy} ${pageSort.order.toUpperCase()}, id ${pageSort.order.toUpperCase()}`;
      const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM profiles ${clause}`, values);
      const total = Number(totalResult.rows[0]?.total ?? 0);
      const totalPages = total === 0 ? 0 : Math.ceil(total / pageSort.limit);

      if (pageSort.cursor) {
        const cursorValues = [...values];
        const cursorClause = appendCursorCondition(clause, pageSort.order, pageSort.cursor, cursorValues);
        const cursorResult = await pool.query(
          `SELECT * FROM profiles ${cursorClause} ORDER BY ${orderBy} LIMIT $${cursorValues.length + 1}`,
          [...cursorValues, pageSort.limit + 1]
        );
        const hasMore = cursorResult.rows.length > pageSort.limit;
        const dataRows = hasMore ? cursorResult.rows.slice(0, pageSort.limit) : cursorResult.rows;
        const data = dataRows.map((row) => normalizeProfileRow(row));
        const nextCursor = hasMore && data.length > 0 ? encodeCursor(data[data.length - 1]) : null;

        res.status(200).json({
          status: "success",
          page: 1,
          limit: pageSort.limit,
          total,
          total_pages: totalPages,
          links: {
            self: `${req.path}?cursor=${encodeURIComponent(String(req.query.cursor || ""))}&limit=${pageSort.limit}`,
            next: nextCursor
              ? `${req.path}?cursor=${encodeURIComponent(nextCursor)}&limit=${pageSort.limit}&sort_by=created_at&order=${pageSort.order}`
              : null,
            prev: null
          },
          next_cursor: nextCursor,
          data
        });
        return;
      }

      const offset = ((pageSort.page ?? 1) - 1) * pageSort.limit;
      const listResult = await pool.query(
        `SELECT * FROM profiles ${clause} ORDER BY ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSort.limit, offset]
      );

      res.status(200).json({
        status: "success",
        page: pageSort.page ?? 1,
        limit: pageSort.limit,
        total,
        total_pages: totalPages,
        links: buildPaginationLinks(req, pageSort.page ?? 1, pageSort.limit, totalPages),
        data: listResult.rows.map((row) => normalizeProfileRow(row))
      });
    } catch {
      toError(res, 500, "Server failure");
    }
  };

  const exportProfiles = async (req: Request, res: Response) => {
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
      const csv = profilesToCsv(result.rows.map((row) => normalizeProfileRow(row)));
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="profiles_${timestamp}.csv"`);
      res.status(200).send(csv);
    } catch {
      toError(res, 500, "Server failure");
    }
  };

  const deleteProfile = async (req: Request, res: Response) => {
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
  };

  return { createProfile, searchProfiles, getProfile, listProfiles, exportProfiles, deleteProfile };
};
