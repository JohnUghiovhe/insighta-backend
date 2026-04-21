# Profiles API (Data Persistence)

TypeScript + Express + SQLite API for demographic profiles with:
- advanced filtering, sorting, and pagination
- rule-based natural language search
- UUID v7 profile IDs
- UTC ISO 8601 timestamps
- CORS enabled (`Access-Control-Allow-Origin: *`)

## Database Schema

The `profiles` table uses this structure:
- `id` (UUID v7, primary key)
- `name` (VARCHAR, unique)
- `gender` (`male` | `female`)
- `gender_probability` (float)
- `age` (int)
- `age_group` (`child` | `teenager` | `adult` | `senior`)
- `country_id` (ISO alpha-2)
- `country_name` (full name)
- `country_probability` (float)
- `created_at` (UTC ISO 8601 timestamp)

## Seeding

On startup, the server reads `seed_profiles.json` and inserts all 2026 records using `INSERT OR IGNORE` on unique `name`.  
This makes seeding idempotent: rerunning the seed does not create duplicates.

To explicitly seed/reseed from the JSON file at any time:

```bash
npm run seed
```

## API Base URL

`http://localhost:3021`

## Error Format

All errors use:

```json
{ "status": "error", "message": "<error message>" }
```

Status codes used:
- `400`: missing or empty parameter
- `422`: invalid parameter type or invalid query parameters
- `404`: profile not found
- `500` / `502`: server or upstream failure

## Endpoints

### `GET /api/profiles`

Supports combined filtering, sorting, and pagination.

Filters:
- `gender`
- `age_group`
- `country_id`
- `min_age`
- `max_age`
- `min_gender_probability`
- `min_country_probability`

Sort:
- `sort_by`: `age` | `created_at` | `gender_probability`
- `order`: `asc` | `desc`

Pagination:
- `page` default `1`
- `limit` default `10`, max `50`
- `cursor` (optional): keyset pagination token for large datasets

Cursor pagination notes:
- Use `cursor` with `limit` (and optional filters).
- `cursor` mode is supported with `sort_by=created_at` only.
- Do not send `page` and `cursor` together.
- Response includes `next_cursor` when more rows are available.

Example:

`/api/profiles?gender=male&country_id=NG&min_age=25&sort_by=age&order=desc&page=1&limit=10`

Cursor example:

`/api/profiles?gender=male&sort_by=created_at&order=desc&limit=10&cursor=<token>`

Success response:

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "data": [
    {
      "id": "019d91a4-7c3c-7fc9-b5d2-a82cc21b5811",
      "name": "emmanuel",
      "gender": "male",
      "gender_probability": 0.99,
      "age": 34,
      "age_group": "adult",
      "country_id": "NG",
      "country_name": "Nigeria",
      "country_probability": 0.85,
      "created_at": "2026-04-01T12:00:00.000Z"
    }
  ]
}
```

Invalid filter/sort/pagination inputs return:

```json
{ "status": "error", "message": "Invalid query parameters" }
```

### `GET /api/profiles/search`

Natural language search endpoint.

Request:
- `q` (required plain English query)
- `page` and `limit` (same pagination rules as `/api/profiles`)

Example:
- `/api/profiles/search?q=young males from nigeria`

If query cannot be interpreted:

```json
{ "status": "error", "message": "Unable to interpret query" }
```

## Natural Language Parsing Approach

The parser is rule-based (no AI/LLM) and works in these steps:

1. Normalize query to lowercase and collapse extra spaces.
2. Detect gender keywords:
   - `male`, `males`, `man`, `men` -> `gender=male`
   - `female`, `females`, `woman`, `women` -> `gender=female`
   - if both appear, gender filter is not set.
3. Detect age-group keywords:
   - `child` / `children` -> `age_group=child`
   - `teen`, `teenage`, `teenager`, `teenagers` -> `age_group=teenager`
   - `adult` / `adults` -> `age_group=adult`
   - `senior`, `seniors`, `elderly` -> `age_group=senior`
4. Detect numeric age constraints:
   - `above|over|older than|greater than <n>` -> `min_age=<n>`
   - `below|under|younger than|less than <n>` -> `max_age=<n>`
5. Special keyword:
   - `young` -> `min_age=16` and `max_age=24` (parsing-only rule, not a stored age group)
6. Detect country phrase:
   - `from <country name>` -> resolve `country_id` by matching `country_name` in DB.
7. If no valid rule produces filters, return `"Unable to interpret query"`.

### Supported Query Mappings

- `young males` -> `gender=male + min_age=16 + max_age=24`
- `females above 30` -> `gender=female + min_age=30`
- `people from angola` -> `country_id=AO`
- `adult males from kenya` -> `gender=male + age_group=adult + country_id=KE`
- `male and female teenagers above 17` -> `age_group=teenager + min_age=17`

## Parser Limitations

- It does not support complex grammar like negation (`not from nigeria`) or OR groups (`male or female from ghana or kenya`).
- It only recognizes explicit keyword patterns listed above.
- It does not infer misspellings (`nigerai`) or fuzzy country matches.
- It does not resolve multiple country phrases in one query.
- `young` is always fixed to `16-24`, regardless of context.

## Quick Start

```bash
npm install
npm run dev
```

Production:

```bash
npm run build
npm start
```
