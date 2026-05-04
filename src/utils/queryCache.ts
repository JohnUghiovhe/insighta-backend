import { PagingAndSort, ParsedFilters } from "../types";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type QueryCache<T> = {
  get: (key: string) => T | undefined;
  set: (key: string, value: T) => void;
  delete: (key: string) => void;
  clear: () => void;
};

export const normalizeParsedFilters = (filters: ParsedFilters): ParsedFilters => {
  const normalized: ParsedFilters = {};

  if (filters.gender) normalized.gender = filters.gender.toLowerCase() as ParsedFilters["gender"];
  if (filters.age_group) normalized.age_group = filters.age_group.toLowerCase() as ParsedFilters["age_group"];
  if (filters.country_id) normalized.country_id = filters.country_id.toUpperCase();
  if (typeof filters.min_age === "number") normalized.min_age = filters.min_age;
  if (typeof filters.max_age === "number") normalized.max_age = filters.max_age;
  if (typeof filters.min_gender_probability === "number") {
    normalized.min_gender_probability = filters.min_gender_probability;
  }
  if (typeof filters.min_country_probability === "number") {
    normalized.min_country_probability = filters.min_country_probability;
  }

  return normalized;
};

const canonicalNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "NaN";
  return Number(value).toString();
};

const canonicalCursor = (cursor?: PagingAndSort["cursor"]): string | null => {
  if (!cursor) return null;
  return `${cursor.created_at}::${cursor.id}`;
};

export const buildQueryCacheKey = (
  scope: string,
  filters: ParsedFilters,
  paging?: Pick<PagingAndSort, "limit" | "order" | "sortBy" | "page"> & { cursor?: PagingAndSort["cursor"] },
  extras?: Record<string, string | number | boolean | undefined>
): string => {
  const normalized = normalizeParsedFilters(filters);
  const parts = [scope];

  if (normalized.gender) parts.push(`gender=${normalized.gender}`);
  if (normalized.age_group) parts.push(`age_group=${normalized.age_group}`);
  if (normalized.country_id) parts.push(`country_id=${normalized.country_id}`);
  if (typeof normalized.min_age === "number") parts.push(`min_age=${canonicalNumber(normalized.min_age)}`);
  if (typeof normalized.max_age === "number") parts.push(`max_age=${canonicalNumber(normalized.max_age)}`);
  if (typeof normalized.min_gender_probability === "number") {
    parts.push(`min_gender_probability=${canonicalNumber(normalized.min_gender_probability)}`);
  }
  if (typeof normalized.min_country_probability === "number") {
    parts.push(`min_country_probability=${canonicalNumber(normalized.min_country_probability)}`);
  }

  if (paging) {
    if (typeof paging.page === "number") parts.push(`page=${paging.page}`);
    parts.push(`limit=${paging.limit}`);
    parts.push(`sortBy=${paging.sortBy}`);
    parts.push(`order=${paging.order}`);
    const cursor = canonicalCursor(paging.cursor);
    if (cursor) parts.push(`cursor=${cursor}`);
  }

  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value === undefined) continue;
      parts.push(`${key}=${String(value)}`);
    }
  }

  return parts.join("|");
};

export const createInMemoryCache = <T>(maxEntries = 250, ttlMs = 30_000): QueryCache<T> => {
  const store = new Map<string, CacheEntry<T>>();

  const evictExpired = (now: number): void => {
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  };

  const evictOldest = (): void => {
    const oldestKey = store.keys().next().value as string | undefined;
    if (oldestKey) store.delete(oldestKey);
  };

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      const now = Date.now();
      evictExpired(now);
      store.set(key, { value, expiresAt: now + ttlMs });
      while (store.size > maxEntries) {
        evictOldest();
      }
    },
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
};