# Insighta Labs+

Insighta Labs+ is a TypeScript + Express backend for profile intelligence with:
- GitHub OAuth (PKCE)
- role-based API access (`admin`, `analyst`)
- opaque access/refresh tokens with server-side hashing
- deterministic natural-language profile search
- structured request logging
- route-scoped rate limiting

---

## System Architecture

### Runtime Structure

- **Bootstrap**: `src/server.ts`
  - loads environment (`dotenv/config`)
  - initializes schema + seed state (`initializeDatabase()`)
  - starts Express app (`createApp()`)

- **App wiring**: `src/app.ts`
  - JSON body parsing
  - global request logger
  - CORS/OPTIONS handling
  - route-scoped throttling
  - auth/authorization middleware chain

- **Controllers**:
  - `src/controllers/authController.ts` (OAuth + token lifecycle)
  - `src/controllers/profileController.ts` (CRUD, filter/sort/paginate, export, NL query)

- **Middleware**:
  - `requestLogger` (`src/middleware/requestLogger.ts`)
  - `authRateLimit` and `userRateLimit` (`src/middleware/rateLimit.ts`)
  - `authenticateAccessToken` + `authorizeRoles` (`src/middleware/auth.ts`)
  - `requireApiVersion` (`src/middleware/apiVersion.ts`)

- **Data layer**:
  - PostgreSQL via `pg` (`src/db.ts`)
  - schema bootstrapped at startup
  - seed ingestion from `seed_profiles.json` when needed

### Request Pipeline (Current)

1. `express.json()`
2. `requestLogger` (captures finish events for every response, including 429s)
3. CORS handler (`OPTIONS -> 204`)
4. Routes:
   - `GET /health` -> `userRateLimit`
   - `/auth/*` -> `authRateLimit`
   - `/api/*` -> `authenticateAccessToken` -> `userRateLimit`
   - `/api/profiles/*` -> `requireApiVersion` + RBAC route guards

---

## Authentication Flow

### 1) Start OAuth
`GET /auth/github`

- validates GitHub env config
- creates:
  - random `state`
  - PKCE `code_verifier`
  - PKCE `code_challenge`
- stores state/verifier with expiration in `oauth_pkce_states`
- redirects user to GitHub authorization URL

### 2) OAuth callback
`GET /auth/github/callback?code=...&state=...`

- validates query parameters
- verifies unexpired PKCE state (and consumes it)
- exchanges code with GitHub for access token
- fetches GitHub user profile (+ fallback email lookup)
- upserts local user by `github_id`
- issues app access + refresh token pair

### 3) Access protected APIs
Use:

`Authorization: Bearer <access_token>`

for `/api/*` endpoints.

### 4) Refresh session
`POST /auth/refresh`

```json
{ "refresh_token": "..." }
```

- validates refresh token (exists, unrevoked, unexpired)
- rejects inactive users
- issues new access + refresh pair
- revokes old refresh token and stores replacement hash

### 5) Logout
`POST /auth/logout`

```json
{ "refresh_token": "..." }
```

- revokes refresh token server-side

---

## Token Handling Approach

- Access and refresh tokens are opaque random strings.
- Raw tokens are never stored in DB.
- Tokens are SHA-256 hashed before persistence.
- Defaults from `src/config.ts`:
  - access token TTL: `3 minutes`
  - refresh token TTL: `5 minutes`
  - PKCE state TTL: `10 minutes`
- Refresh rotation is single-use: successful refresh revokes the previous refresh token immediately.

---

## Role Enforcement Logic

### Identity enforcement

- All `/api/*` routes require valid bearer token via `authenticateAccessToken`.
- Inactive users are blocked with `403`.

### Role checks

`authorizeRoles(...)` is applied per route in `src/routes/profileRoutes.ts`.

- **admin + analyst**
  - `GET /api/profiles`
  - `GET /api/profiles/:id`
  - `GET /api/profiles/search`
  - `GET /api/profiles/export`

- **admin only**
  - `POST /api/profiles`
  - `DELETE /api/profiles/:id`

### Version gate

All `/api/profiles/*` routes require:

`X-API-Version: 1`

Otherwise: `400 API version header required`.

---

## Natural Language Parsing Approach

Natural-language search is deterministic and rule-based (non-LLM), implemented in
`parseNaturalLanguageQuery()` inside `src/controllers/profileController.ts`.

Pipeline:

1. normalize query (lowercase, trim, collapse spaces)
2. infer gender keywords:
   - male/man/men
   - female/woman/women
3. infer age-group keywords:
   - child, teenager, adult, senior/elderly
4. map `"young"` to fixed age range `16..24`
5. infer numeric age bounds:
   - `above|over|older than|greater than <n>` -> `min_age`
   - `below|under|younger than|less than <n>` -> `max_age`
6. resolve `from <country>` to `country_id` by querying existing `profiles.country_name`
7. reject if:
   - no interpretable filters
   - conflicting bounds (`min_age > max_age`)
   - unknown country reference

When parsing fails: `400 Unable to interpret query`.

---

## Rate Limiting

Window: `60s` in-memory counter.

- `/auth/*`:
  - **10 requests/minute** (IP-scoped)
- all other API surface:
  - **60 requests/minute per user**
  - keyed by authenticated `authUser.id`
  - fallback to IP when user id is unavailable (e.g. `/health`)

Exceeded requests return:

- `429 Too many requests`

Config keys (`src/config.ts`):

```env
AUTH_RATE_LIMIT_MAX_REQUESTS=10
USER_RATE_LIMIT_MAX_REQUESTS=60
```

---

## Request Logging

`requestLogger` logs one structured JSON event per completed response:

- `timestamp`
- `method`
- `path`
- `status`
- `duration_ms`
- `user_id` (or `null`)
- `ip`

Because logger is mounted before route handlers, throttled responses (`429`) are logged too.

---

## API Surface

### Health

- `GET /health`

### Auth

- `GET /auth/github`
- `GET /auth/github/callback`
- `POST /auth/refresh`
- `POST /auth/logout`

### Profiles (all require bearer auth + `X-API-Version: 1`)

- `GET /api/profiles`
- `GET /api/profiles/:id`
- `GET /api/profiles/search?q=...`
- `GET /api/profiles/export?format=csv`
- `POST /api/profiles`
- `DELETE /api/profiles/:id`

---

## CLI Usage

The CLI is expected to be installed globally and usable from any directory.

```bash
npm install -g insighta-cli
```

After global installation, this must work from any path:

```bash
insighta login
```

### Authentication Commands

```bash
insighta login
insighta logout
insighta whoami
```

### Profile Commands

```bash
insighta profiles list
insighta profiles list --gender male
insighta profiles list --country NG --age-group adult
insighta profiles list --min-age 25 --max-age 40
insighta profiles list --sort-by age --order desc
insighta profiles list --page 2 --limit 20

insighta profiles get <id>

insighta profiles search "young males from nigeria"

insighta profiles create --name "Harriet Tubman"

insighta profiles export --format csv
insighta profiles export --format csv --gender male --country NG
```

### CLI Runtime Expectations

- Uses auth tokens on every API request.
- Stores credentials at `~/.insighta/credentials.json`.
- Handles access-token expiry:
  - auto-refreshes when refresh token is still valid
  - prompts user to re-login when refresh is not possible
- Shows a loader during network operations.
- Displays fetched results in a structured table.
- Provides clear operation feedback and error messages.
- Saves exported CSV files to the current working directory.

---

## Environment Variables

```env
PORT=3021
DATABASE_URL=postgresql://...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=http://localhost:3021/auth/github/callback
GITHUB_SCOPE=read:user user:email

# Optional overrides
AUTH_RATE_LIMIT_MAX_REQUESTS=10
USER_RATE_LIMIT_MAX_REQUESTS=60
```

---

## Data Model (Core Tables)

- `profiles`
  - demographic profile intelligence records
- `users`
  - GitHub-linked application users + role + active state
- `oauth_pkce_states`
  - transient state/verifier for OAuth PKCE
- `access_tokens`
  - hashed short-lived access tokens
- `refresh_tokens`
  - hashed refresh tokens, revocation + replacement metadata