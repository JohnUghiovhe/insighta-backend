# Intelligence-query-engine

Intelligence-query-engine is a TypeScript + Express API that stores and serves enriched demographic profiles using SQLite.

It supports:
- profile creation from upstream demographic APIs
- advanced filtering with combined conditions
- sorting and pagination (offset and cursor/keyset)
- natural language query parsing
- idempotent seeding of 2026 profiles
- CORS (`Access-Control-Allow-Origin: *`)

## Tech Stack

- Runtime: Node.js
- Language: TypeScript
- Web framework: Express 5
- Database: SQLite (`sqlite` + `sqlite3`)
- Build/dev: `tsc`, `tsx`

## Project Structure

- `src/server.ts`: main API server and database initialization
- `src/seed.ts`: manual seeding utility for `seed_profiles.json`
- `seed_profiles.json`: source dataset (2026 records)
- `data/profiles.db`: SQLite database file (created at runtime)

## Database Schema

Table: `profiles`

- `id` (UUID v7, primary key)
- `name` (TEXT, unique, case-insensitive)
- `gender` (`male` | `female`)
- `gender_probability` (REAL)
- `age` (INTEGER)
- `age_group` (`child` | `teenager` | `adult` | `senior`)
- `country_id` (ISO alpha-2)
- `country_name` (TEXT)
- `country_probability` (REAL)
- `created_at` (UTC ISO 8601)

Indexes currently created:
- `idx_profiles_gender`
- `idx_profiles_age_group`
- `idx_profiles_country_id`
- `idx_profiles_age`
- `idx_profiles_created_at`
- `idx_profiles_gender_probability`
- `idx_profiles_country_probability`
- `idx_profiles_country_name`
- `idx_profiles_country_name_lower` (functional index on `LOWER(country_name)`)

## Seeding

The app seeds on server startup from `seed_profiles.json` using `INSERT OR IGNORE`, so reruns are idempotent.

Manual seed command:

```bash
npm run seed
```

Seed script summary:
- Reads all 2026 profiles from `seed_profiles.json`
- Inserts with normalized values (lowercased names, uppercased country IDs)
- Uses transaction (`BEGIN/COMMIT/ROLLBACK`)
- Prints source and DB counts on completion

## Run Instructions

Install dependencies:

```bash
npm install
```

Development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Production:

```bash
npm start
```

## Base URL

- Local: `http://localhost:3021`

## Error Format

All errors return:

```json
{ "status": "error", "message": "<error message>" }
```

Common status codes:
- `400`: missing/empty required parameter or unparseable natural language query
- `404`: profile not found
- `422`: invalid query parameters or invalid parameter type
- `500`: server failure
- `502`: upstream service failure or invalid upstream response

## API Endpoints

### Health

`GET /health`

Response:

```json
{ "status": "ok" }
```

### Create Profile

`POST /api/profiles`

Body:

```json
{ "name": "emmanuel" }
```

Behavior:
- Validates `name`
- Checks existing profile by case-insensitive name
- If not found, fetches upstream data from:
  - `genderize.io`
  - `agify.io`
  - `nationalize.io`
- Inserts a new profile and returns it

### Get One Profile

`GET /api/profiles/:id`

Returns one profile or `404`.

### Delete Profile

`DELETE /api/profiles/:id`

Returns `204` when deleted, `404` if not found.

### List Profiles

`GET /api/profiles`

Supports combined filtering, sorting, and pagination.

Filters:
- `gender`
- `age_group`
- `country_id`
- `min_age`
- `max_age`
- `min_gender_probability` (`0..1`)
- `min_country_probability` (`0..1`)

Sorting:
- `sort_by`: `age` | `created_at` | `gender_probability`
- `order`: `asc` | `desc`

Pagination mode A (offset/page):
- `page` default `1`
- `limit` default `10`, max `50`

Pagination mode B (cursor/keyset):
- `cursor` token + `limit`
- only valid when `sort_by=created_at`
- cannot be combined with `page`
- response includes `next_cursor` when more rows exist

Offset example:

`/api/profiles?gender=male&country_id=NG&min_age=25&sort_by=age&order=desc&page=1&limit=10`

Cursor example:

`/api/profiles?gender=male&sort_by=created_at&order=desc&limit=10&cursor=<token>`

### Natural Language Search

`GET /api/profiles/search?q=<query>&page=<n>&limit=<n>`

Example:

`/api/profiles/search?q=young males from nigeria&page=1&limit=10`

Returns `400` with `Unable to interpret query` when no rule can be applied.

## Natural Language Parsing Rules

The parser is rule-based (non-LLM):

1. Normalize to lowercase and collapse whitespace.
2. Gender detection:
   - male words -> `gender=male`
   - female words -> `gender=female`
   - if both appear, gender filter is omitted
3. Age-group detection:
   - child/children -> `age_group=child`
   - teen/teenage/teenager(s) -> `age_group=teenager`
   - adult(s) -> `age_group=adult`
   - senior(s)/elderly -> `age_group=senior`
4. Numeric age constraints:
   - above/over/older than/greater than `<n>` -> `min_age`
   - below/under/younger than/less than `<n>` -> `max_age`
5. Special keyword:
   - young -> fixed `min_age=16`, `max_age=24`
6. Country phrase:
   - `from <country name>` mapped by case-insensitive `country_name` lookup
7. If no valid rule produced filters, return `Unable to interpret query`.

## Validation Rules (Highlights)

- `name` is required and must be a non-empty string
- `country_id` filter must be two uppercase letters
- probabilities must be numeric and in range `0..1`
- `min_age <= max_age`
- `page >= 1`, `1 <= limit <= 50`
- invalid arrays/multi-values for single-valued params are rejected

## Current Feature Status

Implemented and production-safe:
- SQLite persistence
- startup seeding + manual seed script
- combined filtering
- sorting
- offset and cursor pagination
- natural language parsing
- endpoint-level validation and structured errors
- functional index support for case-insensitive country-name lookup
