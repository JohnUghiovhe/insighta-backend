# Insighta Labs+

Insighta Labs+ is a TypeScript + Express backend that provides profile intelligence with secure GitHub login, role-based access control, short-lived token sessions, API versioning, CSV export, rate limiting, and request logging.

Core profile intelligence behavior from the existing engine is preserved:
- profile creation with upstream demographic APIs
- filtering, sorting, and pagination
- natural language search

## System Architecture

- API Layer: Express routes and middleware in `src/server.ts`
- Auth Layer:
  - GitHub OAuth + PKCE (`/auth/github`, `/auth/github/callback`)
  - access/refresh token issuance and rotation (`/auth/refresh`, `/auth/logout`)
- Access Control Layer:
  - authentication middleware on all `/api/*`
  - centralized RBAC middleware for route permissions
  - inactive-user check returns `403`
- Data Layer: PostgreSQL (Supabase) via `pg`
- Operational Layer:
  - in-memory IP rate limiting
  - structured request logging for every request

## Tech Stack

- Runtime: Node.js
- Language: TypeScript
- Framework: Express 5
- Database: PostgreSQL (Supabase)
- DB Client: `pg`
- Build/Dev: `tsc`, `tsx`

## Environment Variables

Create/update `.env`:

```env
PORT=3021
DATABASE_URL=postgresql://...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=http://localhost:3021/auth/github/callback
GITHUB_SCOPE=read:user user:email
RATE_LIMIT_MAX_REQUESTS=120
```

## Database Schema

### `profiles`
- `id` UUID (UUID v7 generated in app)
- `name` TEXT
- `gender` TEXT
- `gender_probability` DOUBLE PRECISION
- `age` INTEGER
- `age_group` TEXT
- `country_id` TEXT
- `country_name` TEXT
- `country_probability` DOUBLE PRECISION
- `created_at` TIMESTAMPTZ

### `users`
- `id` UUID (UUID v7)
- `github_id` VARCHAR UNIQUE
- `username` VARCHAR
- `email` VARCHAR
- `avatar_url` TEXT
- `role` VARCHAR (`admin` | `analyst`, default `analyst`)
- `is_active` BOOLEAN (default `true`)
- `last_login_at` TIMESTAMPTZ
- `created_at` TIMESTAMPTZ

### `oauth_pkce_states`
Stores transient PKCE state and verifier until callback exchange.

### `access_tokens`
Stores hashed access tokens and expiry (`3 minutes`).

### `refresh_tokens`
Stores hashed refresh tokens, expiry (`5 minutes`), and rotation metadata.

## Authentication Flow

### 1. Start OAuth
`GET /auth/github`
- server creates PKCE verifier/challenge + random state
- state/verifier persisted server-side with expiration
- user is redirected to GitHub authorize URL

### 2. OAuth Callback
`GET /auth/github/callback`
- validates state and expiration
- exchanges code using client credentials + `code_verifier`
- fetches GitHub user identity
- upserts app user (`github_id` unique)
- issues access + refresh tokens

### 3. Access Protected APIs
All `/api/*` require `Authorization: Bearer <access_token>`.

### 4. Refresh Session
`POST /auth/refresh`
```json
{ "refresh_token": "string" }
```
- validates refresh token (not revoked, not expired)
- rotates token pair
- old refresh token is immediately revoked

### 5. Logout
`POST /auth/logout`
```json
{ "refresh_token": "string" }
```
- revokes refresh token server-side

## Token Handling Approach

- Access tokens are opaque random values.
- Refresh tokens are opaque random values.
- Only SHA-256 hashes are persisted in the database.
- Expiration windows:
  - access token: `3 minutes`
  - refresh token: `5 minutes`
- Refresh token rotation is strict:
  - valid refresh token can be used once
  - old token becomes invalid immediately after refresh

## Role Enforcement Logic

All `/api/*` endpoints are protected by middleware in this order:
1. Authentication middleware validates access token.
2. Inactive-user guard blocks requests with `403`.
3. RBAC middleware checks route role requirements.

Roles:
- `admin`: create, delete, read, query, export
- `analyst`: read, query, export only

Route rules:
- `POST /api/profiles` -> `admin`
- `DELETE /api/profiles/:id` -> `admin`
- `GET /api/profiles`, `GET /api/profiles/:id`, `GET /api/profiles/search`, `GET /api/profiles/export` -> `admin` or `analyst`

## API Versioning

All profile endpoints require:
- `X-API-Version: 1`

If missing or incorrect:
- status: `400`
- body:
```json
{ "status": "error", "message": "API version header required" }
```

## Pagination Response Shape

Paginated endpoints:
- `GET /api/profiles`
- `GET /api/profiles/search`

Response shape:

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "total_pages": 203,
  "links": {
    "self": "/api/profiles?page=1&limit=10",
    "next": "/api/profiles?page=2&limit=10",
    "prev": null
  },
  "data": []
}
```

## Profile Endpoints

### Health
`GET /health`

### Create Profile (admin)
`POST /api/profiles`

Request:
```json
{ "name": "Harriet Tubman" }
```

Behavior:
- checks for existing profile (case-insensitive)
- fetches from `genderize`, `agify`, `nationalize` when needed
- transforms and persists profile in PostgreSQL

### List Profiles
`GET /api/profiles`

Supported filters:
- `gender`
- `age_group`
- `country_id`
- `min_age`
- `max_age`
- `min_gender_probability`
- `min_country_probability`

Supported sort:
- `sort_by`: `age` | `created_at` | `gender_probability`
- `order`: `asc` | `desc`

Pagination:
- `page` (default `1`)
- `limit` (default `10`, max `50`)

### Search Profiles (Natural Language)
`GET /api/profiles/search?q=<query>&page=<n>&limit=<n>`

### Get One Profile
`GET /api/profiles/:id`

### Delete Profile (admin)
`DELETE /api/profiles/:id`

### Export CSV
`GET /api/profiles/export?format=csv`

- uses the same filters/sorting as `GET /api/profiles`
- response headers:
  - `Content-Type: text/csv`
  - `Content-Disposition: attachment; filename="profiles_<timestamp>.csv"`

CSV column order:
- `id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at`

## Natural Language Parsing Approach

The parser is deterministic and rule-based (non-LLM):
1. normalize input to lowercase and collapse spaces
2. detect gender terms (`male`, `female`, etc.)
3. detect age group terms (`child`, `teenager`, `adult`, `senior`)
4. detect age constraints (`above`, `below`, `over`, `under`, etc.)
5. map `young` to fixed range (`16..24`)
6. resolve `from <country>` by matching existing `country_name` in DB
7. if no valid filters are inferred, return `Unable to interpret query`

## Rate Limiting and Request Logging

- Rate limit: in-memory, per IP, sliding window of 60s.
- Max requests per window configurable via `RATE_LIMIT_MAX_REQUESTS` (default `120`).
- Every request is logged with:
  - timestamp
  - method
  - path
  - status
  - latency
  - user id (if authenticated)
  - client IP

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

Run built server:

```bash
npm start
```

Manual seeding:

```bash
npm run seed
```