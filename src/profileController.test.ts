import { describe, expect, it, vi } from "vitest";
import {
  appendCursorCondition,
  encodeCursor,
  parseFilterQuery,
  parseNaturalLanguageQuery,
  parsePagingAndSort
} from "./controllers/profileController";
import { buildQueryCacheKey, normalizeParsedFilters } from "./utils/queryCache";

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));

vi.mock("./db", () => ({
  pool: {
    query: poolQuery
  }
}));

describe("profile query parsing", () => {
  it("parses valid filter query", () => {
    const parsed = parseFilterQuery({
      gender: "male",
      country_id: "ng",
      age_group: "adult",
      min_age: "25",
      max_age: "40",
      min_gender_probability: "0.5",
      min_country_probability: "0.4"
    });

    expect(parsed).toEqual({
      gender: "male",
      country_id: "NG",
      age_group: "adult",
      min_age: 25,
      max_age: 40,
      min_gender_probability: 0.5,
      min_country_probability: 0.4
    });
  });

  it("rejects invalid filter query values", () => {
    const parsed = parseFilterQuery({
      gender: "unknown",
      min_age: "50",
      max_age: "20"
    });

    expect(parsed).toBeNull();
  });
});

describe("paging and cursor parsing", () => {
  it("uses default paging/sort values", () => {
    const parsed = parsePagingAndSort({});

    expect(parsed).toEqual({
      page: 1,
      limit: 10,
      sortBy: "created_at",
      order: "desc"
    });
  });

  it("parses cursor pagination when valid", () => {
    const cursor = encodeCursor({
      id: "abc",
      created_at: "2026-01-01T00:00:00.000Z"
    });

    const parsed = parsePagingAndSort({
      cursor,
      sort_by: "created_at",
      order: "asc",
      limit: "20"
    });

    expect(parsed).toEqual({
      limit: 20,
      sortBy: "created_at",
      order: "asc",
      cursor: {
        id: "abc",
        created_at: "2026-01-01T00:00:00.000Z"
      }
    });
  });

  it("rejects cursor when sort_by is not created_at", () => {
    const cursor = encodeCursor({
      id: "abc",
      created_at: "2026-01-01T00:00:00.000Z"
    });

    const parsed = parsePagingAndSort({
      cursor,
      sort_by: "age"
    });

    expect(parsed).toBeNull();
  });
});

describe("cursor SQL condition", () => {
  it("builds descending cursor condition and appends values", () => {
    const values: Array<string | number> = ["male"];

    const clause = appendCursorCondition("WHERE gender = $1", "desc", {
      id: "id-1",
      created_at: "2026-01-01T00:00:00.000Z"
    }, values);

    expect(clause).toContain("created_at < $2");
    expect(clause).toContain("id < $4");
    expect(values).toEqual(["male", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "id-1"]);
  });
});

describe("query normalization", () => {
  it("produces the same cache key for equivalent filters", () => {
    const left = buildQueryCacheKey(
      "list",
      normalizeParsedFilters({ gender: "female", country_id: "ng", min_age: 20, max_age: 45 }),
      { limit: 10, sortBy: "created_at", order: "desc", page: 1 }
    );

    const right = buildQueryCacheKey(
      "list",
      normalizeParsedFilters({ country_id: "NG", max_age: 45, min_age: 20, gender: "female" }),
      { limit: 10, sortBy: "created_at", order: "desc", page: 1 }
    );

    expect(left).toBe(right);
  });
});

describe("natural language query parsing", () => {
  it("parses en-dash age ranges and hyphenated country names", async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT LOWER(country_name)")) {
        return {
          rows: [
            { country_name: "mozambique" },
            { country_name: "burkina faso" }
          ]
        };
      }

      if (sql.includes("SELECT country_id FROM profiles")) {
        return {
          rows: [{ country_id: "MZ" }]
        };
      }

      return { rows: [] };
    });

    const parsed = await parseNaturalLanguageQuery({ query: poolQuery } as never, "Mozambique women aged 20–35");

    expect(parsed).toEqual({
      gender: "female",
      min_age: 20,
      max_age: 35,
      country_id: "MZ"
    });

    const hyphenated = await parseNaturalLanguageQuery({ query: poolQuery } as never, "burkina-faso women aged 20-35");

    expect(hyphenated).toEqual({
      gender: "female",
      min_age: 20,
      max_age: 35,
      country_id: "MZ"
    });
  });
});
