# Insighta Labs+ Backend

Insighta Labs+ is a TypeScript + Express backend for profile intelligence with:

- GitHub OAuth with PKCE support for browser and CLI flows
- role-based API access (`admin`, `analyst`)
- opaque access/refresh tokens stored as hashes
- deterministic natural-language profile search
- structured request logging
- route-scoped rate limiting

## Project Links

Use this table to jump between full docs across repos.

| Project | Purpose | Docs |
| --- | --- | --- |
| Insighta+ Labs Backend (this repo) | Auth, profile APIs, parser, RBAC, rate limits | This README |
| Insighta CLI | Terminal client for auth/profile workflows | [CLI README](https://github.com/JohnUghiovhe/Insighta-CLI#readme) |
| Insighta Web Frontend | Browser-based experience for the same APIs | [Frontend README](https://github.com/JohnUghiovhe/insighta-web#readme) |

## Live URLs

| Surface | URL | Status |
| --- | --- | --- |
| Frontend | https://insighta-web-pied.vercel.app/ | Live |
| Backend Base | https://intelligence-query-engine-production.up.railway.app/ | Live |
| Backend Health | https://intelligence-query-engine-production.up.railway.app/health | Live |

## System Expectations

The backend is the shared source of truth for the entire Insighta platform.

- CLI and Web both authenticate against the same backend user and token model.
- Profile data, search results, and authorization decisions must stay consistent across interfaces.
- Authentication is enforced globally on protected routes rather than being trusted at the client layer.
- Access control must remain predictable so the same role always receives the same API outcome.

## Key Engineering Challenges

These are the cross-interface concerns this backend is designed to handle:

- OAuth with PKCE across both CLI and browser flows
- coordination between CLI, browser, and backend callback/exchange steps
- token lifecycle management for access and refresh tokens
- role-based authorization design for admin and analyst paths
- multi-interface consistency for search, profiles, and account state
- failure handling for expired tokens, failed auth exchanges, and callback timeouts

## What Was Updated

This README now reflects the current implementation:

- documents CLI OAuth handshake endpoints (`/auth/github/init` and `/auth/github/exchange`)
- includes protected `GET /auth/me`
- clarifies parser behavior and examples used by `insighta profiles search`
- documents CSV ingestion at `POST /api/profiles/upload`
- links the Postman workspace for manual API testing
- captures list pagination behavior, including cursor mode for `created_at`
- documents the in-memory query cache and mutation-driven cache invalidation
- adds cross-repo docs table and frontend placeholder

## System Architecture

| Layer | Key Files | Responsibilities |
| --- | --- | --- |
| Bootstrap | `src/server.ts` | Loads env, initializes DB, starts Express |
| App Wiring | `src/app.ts` | JSON parsing, logger, CORS, routing/middleware chain |
| Auth Controller | `src/controllers/authController.ts` | OAuth flows, token issue/refresh/logout, me endpoint |
| Profile Controller | `src/controllers/profileController.ts` | CRUD, filters, pagination, export, NL parser search |
| Middleware | `src/middleware/*` | request logging, auth, RBAC, API version, rate limits |
| Data Layer | `src/db.ts` | Postgres connection, schema bootstrap and seed handling |

### Request Pipeline

1. `express.json()`
2. request logger captures completed responses
3. CORS and `OPTIONS` handling
4. route scopes:
   - `/health` -> user limiter
   - `/auth/*` -> auth limiter
   - `/api/*` -> bearer auth + user limiter
   - `/api/profiles/*` -> API version header + RBAC checks

## Authentication Flow

### Browser OAuth

Uses browser OAuth app env values (`GITHUB_BROWSER_*`) with fallback to legacy `GITHUB_*` values.

1. `GET /auth/github` creates PKCE state+verifier and redirects to GitHub.
2. `GET /auth/github/callback` validates callback state, exchanges code, upserts user, and returns token pair.

### CLI OAuth

Uses CLI OAuth app env values (`GITHUB_CLI_*`) with fallback to legacy `GITHUB_*` values.

1. CLI requests `GET /auth/github/init` to fetch client metadata.
2. CLI opens GitHub authorize URL with its own local callback URL and PKCE values.
3. CLI sends `POST /auth/github/exchange` with:
   - `code`
   - `code_verifier`
   - `redirect_uri`
4. Backend exchanges code and returns token pair plus user payload.

If `GITHUB_CLI_REDIRECT_URI` is set, backend enforces an exact match for `redirect_uri` in CLI exchange.

### Session Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/auth/me` | `GET` | Returns authenticated user profile |
| `/auth/refresh` | `POST` | Rotates refresh token and returns new pair |
| `/auth/logout` | `POST` | Revokes refresh token |

## CLI Usage

The backend is consumed directly by the CLI repo.

```bash
insighta login
insighta whoami
insighta profiles list --limit 3
insighta profiles search "young males from nigeria"
insighta profiles export --format csv
```

CLI repository: https://github.com/JohnUghiovhe/Insighta-CLI

## Token Handling Approach

- access and refresh tokens are opaque random strings
- raw tokens are never persisted
- SHA-256 token hashes are stored in DB
- default TTLs:
  - access token: 3 minutes
  - refresh token: 5 minutes
  - PKCE state: 10 minutes
- refresh token rotation is single-use and revokes previous token immediately

## Role Enforcement Logic

All `/api/*` routes require bearer authentication. Inactive users are denied.

All `/api/profiles/*` routes require:

- `Authorization: Bearer <access_token>`
- `X-API-Version: 1`

Role access:

| Route | Analyst | Admin |
| --- | --- | --- |
| `GET /api/profiles` | Yes | Yes |
| `GET /api/profiles/:id` | Yes | Yes |
| `GET /api/profiles/search` | Yes | Yes |
| `GET /api/profiles/export` | Yes | Yes |
| `POST /api/profiles` | No | Yes |
| `DELETE /api/profiles/:id` | No | Yes |

## Natural Language Parsing Approach

Natural-language search is deterministic and rule-based (non-LLM), implemented in the profile controller.

`GET /api/profiles/search?q=<text>` supports:

- gender terms: male/man/men and female/woman/women
- age group terms: child, teenager, adult, senior, elderly
- young shortcut: fixed range `16..24`
- numeric bounds:
  - above, over, older than, greater than `<n>` -> `min_age`
  - below, under, younger than, less than `<n>` -> `max_age`
- country extraction from `from <country>` with lookup against existing `profiles.country_name`

Parser failure cases return `400 Unable to interpret query`:

- no recognized filters
- conflicting bounds (`min_age > max_age`)
- unknown country text

### Parser Examples (Used By CLI Search)

| Query Text | Parsed Meaning |
| --- | --- |
| `young males from nigeria` | male, age 16-24, country NG |
| `women above 30` | female, min_age 30 |
| `teenage men from kenya` | male, age_group teenager, country KE |
| `seniors under 70` | age_group senior, max_age 70 |
| `adults from canada` | age_group adult, country CA |

## Profiles API Details

### List Profiles

`GET /api/profiles`

Supported query params include:

- filters: `gender`, `age_group`, `country_id`, `min_age`, `max_age`, `min_gender_probability`, `min_country_probability`
- sort: `sort_by` (`age`, `created_at`, `gender_probability`), `order` (`asc`, `desc`)
- pagination:
  - page mode: `page`, `limit`
  - cursor mode: `cursor`, `limit` (only when `sort_by=created_at` and no `page`)

List responses are served through a canonicalized query cache keyed on normalized filters, sort, paging, and cursor state. The cache is in-memory, capped at 250 entries, and uses a 30-second TTL.

### Export Profiles

`GET /api/profiles/export?format=csv` returns CSV with the same filter/sort semantics.

### Search Profiles

`GET /api/profiles/search?q=...` supports natural-language parser + page pagination (`page`, `limit`).

Search requests use the same normalized filter cache as list requests, so semantically equivalent queries reuse the same cached response.

### Upload Profiles

`POST /api/profiles/upload` accepts CSV payloads and is restricted to admin users.

Supported content types:

- `text/csv`
- `text/plain`
- `application/octet-stream`

Expected columns, in any order:

- `name`
- `gender`
- `age`
- `country_id`
- `country_name`
- `gender_probability`
- `country_probability`

Behavior:

- rows are streamed and processed incrementally
- valid rows are inserted in batches
- duplicate names are skipped
- malformed or invalid rows are counted in the response summary

Typical response shape:

```json
{
  "status": "success",
  "total_rows": 15,
  "inserted": 14,
  "skipped": 1,
  "reasons": {
    "duplicate_name": 1
  }
}
```

## Rate Limiting

Window is 60 seconds (in-memory counters):

- `/auth/*`: 10 requests/minute per IP
- all other endpoints: 60 requests/minute per authenticated user (fallback to IP if user id missing)

Exceeded limit returns `429 Too Many Requests`.

## Scaling Notes

The implementation is intentionally lightweight, but the core paths are designed to scale predictably:

- CSV ingestion uses streaming parsing instead of loading the full file into memory.
- Uploads are batched to reduce per-row insert overhead.
- Profile search and list endpoints normalize filters before building cache keys, so equivalent queries collapse to the same cache entry.
- The query cache is a 250-entry in-memory LRU with a 30-second TTL.
- Mutating profile routes clear the query cache so search and list results do not serve stale data.
- Cursor pagination is available for `created_at` ordering to avoid deep offset scans.
- OAuth token handling is stateless at the request layer; persistence is limited to hashed tokens and transient PKCE state.
- Rate limiting is in-memory today, which is enough for single-instance deployment but should move to a shared store if the service is horizontally scaled.

## Request Logging

Each completed response logs a structured JSON object with:

- `timestamp`
- `method`
- `path`
- `status`
- `duration_ms`
- `user_id` (or `null`)
- `ip`

## API Surface

| Area | Endpoints |
| --- | --- |
| Health | `GET /health` |
| Auth | `GET /auth/github`, `GET /auth/github/init`, `GET /auth/github/callback`, `POST /auth/github/exchange`, `GET /auth/me`, `POST /auth/refresh`, `POST /auth/logout` |
| Profiles | `GET /api/profiles`, `GET /api/profiles/:id`, `GET /api/profiles/search`, `GET /api/profiles/export`, `POST /api/profiles/upload`, `POST /api/profiles`, `DELETE /api/profiles/:id` |

## Environment Variables

```env
PORT=3021
DATABASE_URL=postgresql://...

# Browser OAuth app (recommended for production web sign-in)
GITHUB_BROWSER_CLIENT_ID=...
GITHUB_BROWSER_CLIENT_SECRET=...
GITHUB_BROWSER_REDIRECT_URI=https://insighta-web-pied.vercel.app/api/auth/callback

# CLI OAuth app (recommended for /auth/github/init and /auth/github/exchange)
GITHUB_CLI_CLIENT_ID=...
GITHUB_CLI_CLIENT_SECRET=...
GITHUB_CLI_REDIRECT_URI=http://localhost:8787/callback

# Backward-compatible legacy fallback variables
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=https://insighta-web-pied.vercel.app/api/auth/callback

GITHUB_SCOPE=read:user user:email

# Optional overrides
AUTH_RATE_LIMIT_MAX_REQUESTS=10
USER_RATE_LIMIT_MAX_REQUESTS=60
```

## Data Model (Core Tables)

- `profiles`: demographic profile intelligence records
- `users`: GitHub-linked users, role, active state
- `oauth_pkce_states`: transient PKCE state + verifier records
- `access_tokens`: hashed short-lived access tokens
- `refresh_tokens`: hashed refresh tokens with revocation and replacement metadata

## Branch And PR Policy

- Create focused branches from `main` with prefixes like `feat/`, `fix/`, `docs/`, or `chore/`.
- Submit PRs to `main` with one logical change per PR.
- Require CI success (`lint`, `test`, `build`) before merge.
- Use squash merge and conventional commit-style PR titles/messages.

## Frontend Placeholder

The frontend is the browser-facing client for the same backend APIs used by the CLI.

### Frontend Links

| Item | URL |
| --- | --- |
| Frontend Repo | https://github.com/JohnUghiovhe/insighta-web |
| Frontend Live App | https://insighta-web-pied.vercel.app/ |

### Frontend Responsibilities

- render the browser login, dashboard, profiles, search, and account views
- rely on backend sessions and API responses rather than local client-side auth state
- keep UI authorization aligned with backend role checks
- surface the same live profile intelligence that the CLI exposes in terminal workflows