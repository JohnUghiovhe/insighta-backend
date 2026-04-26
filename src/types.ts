export type GenderizeResponse = {
  count: number | null;
  gender: "male" | "female" | null;
  probability: number | null;
};

export type AgifyResponse = {
  age: number | null;
};

export type NationalizeCountry = {
  country_id: string;
  probability: number;
};

export type NationalizeResponse = {
  country: NationalizeCountry[];
};

export type ProfileRow = {
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

export type SeedProfile = Omit<ProfileRow, "id" | "created_at">;

export type ParsedFilters = {
  gender?: "male" | "female";
  age_group?: "child" | "teenager" | "adult" | "senior";
  country_id?: string;
  min_age?: number;
  max_age?: number;
  min_gender_probability?: number;
  min_country_probability?: number;
};

export type PagingAndSort = {
  page?: number;
  limit: number;
  sortBy: "age" | "created_at" | "gender_probability";
  order: "asc" | "desc";
  cursor?: {
    created_at: string;
    id: string;
  };
};

export type Role = "admin" | "analyst";

export type AuthUser = {
  id: string;
  github_id: string;
  username: string;
  email: string | null;
  avatar_url: string | null;
  role: Role;
  is_active: boolean;
};

export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};
