# Deployment Handover — Rekart Shopify Connector

**Audience:** Ashok (deployment/DevOps)
**Scope:** Deploying the Remix app (`rekart-delivery/`) — the embedded Shopify app
that receives Rekart → Shopify fulfillment pushes and serves the embedded admin UI.
The in-repo FastAPI service (`rekart-backend/`) is a reference backend; the Remix
app talks to the real Rekart (Laravel) backend via `REKART_BACKEND_URL`.

## Prerequisites

- **Node** ≥ 20.19 (`<22 || >=22.12`), or Docker.
- **PostgreSQL 16** (existing WhatsApp-server instance). Production is PostgreSQL — **not** SQLite.
  (SQLite is local-dev only; see "Schema provider" below.)
- A public **HTTPS** URL for the embedded app (`SHOPIFY_APP_URL`), registered in the
  Shopify Partner Dashboard. Embedded OAuth will not complete over plain HTTP.
- Secrets (regenerate per environment — never reuse dev values):
  - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (Partner Dashboard)
  - `ENCRYPTION_KEY` — 32-byte hex (`openssl rand -hex 32`); the app throws on
    connect if missing (encrypts the Rekart token at rest)
  - `REKART_STATIC_API_KEY` — shared `X-API-Key` with the Rekart backend
  - `DATABASE_URL` — `postgresql://user:password@host:5432/rekart_shopify`

## Schema provider (read this first)

The repo has **two** Prisma schemas because Prisma forbids `env()` in the datasource
`provider`:

- `prisma/schema.prisma` — **canonical, PostgreSQL** (String -> TEXT, no `@db.Text`
  needed), migrations in `prisma/migrations/`. **This is what production/Docker use.**
- `prisma/schema.sqlite.prisma` — local-dev mirror (sqlite).

Production must run migrations against PostgreSQL: `npx prisma migrate deploy` (uses
the default canonical schema). Never point the production/Docker app at a `file:` URL.

---

## Option A — Traditional / PM2 deployment

For a VM or bare host with Node installed and an external PostgreSQL (the existing
WhatsApp-server instance).

```bash
# 1. Install deps (production)
npm ci

# 2. Configure env — copy .env.example to .env and fill in the real values,
#    with a PostgreSQL DATABASE_URL:
#    DATABASE_URL=postgresql://user:password@host:5432/rekart_shopify

# 3. Apply DB migrations (canonical PostgreSQL schema) + generate client
npx prisma generate
npx prisma migrate deploy

# 4. Build
npm run build

# 5. Start (long-lived). Either `npm run start` directly, or under PM2:
pm2 start "npm run start" --name rekart-delivery
pm2 save
```

- The server listens on `PORT` (default 3000). Put Nginx (TLS termination) in front
  and proxy to `http://127.0.0.1:3000`.
- `npm run start` = `react-router-serve ./build/server/index.js`.
- Set `SHOPIFY_APP_URL` to the public HTTPS domain and match it in the Partner
  Dashboard app URLs / allowed redirect URLs.

## Option B — Docker deployment (recommended if Docker is available on the server)

Brings up the whole stack (app + PostgreSQL + Redis + FastAPI reference backend + Celery
worker) from `docker-compose.yml`. See `docs/DOCKER.md` for the full reference.

```bash
# 1. Configure env
cp .env.docker.example .env          # then fill in SHOPIFY_API_KEY / SHOPIFY_API_SECRET
                                     # and regenerate all shared secrets for prod

# 2. Build + start everything (detached)
docker compose up --build -d

# 3. Point Nginx (TLS) at the app container on port 3000
#    proxy_pass http://127.0.0.1:3000;
```

All services (PostgreSQL, Redis, app) start automatically. **Migrations run on boot:**
the `app` container runs `prisma generate && prisma migrate deploy` (via
`npm run docker-start`) once PostgreSQL is healthy; the `backend` runs Alembic. The
`app` container uses the canonical PostgreSQL schema — there is no provider switch.

- Data persists in the `postgres_data` / `redis_data` volumes; `docker compose down -v`
  wipes them.
- Set `APP_ENV=production` for any non-local deploy (the default `development`
  exposes the backend's `/docs` and opens CORS).
- Override host ports via `APP_PORT` / `POSTGRES_PORT` / `REDIS_PORT` / `BACKEND_PORT`
  if they clash with existing services.

## Post-deploy checklist

- [ ] `DATABASE_URL` points at PostgreSQL (not `file:`), and `prisma migrate deploy` ran clean.
- [ ] `SHOPIFY_APP_URL` is the public HTTPS domain; Partner Dashboard URLs updated.
- [ ] All secrets regenerated for this environment (no dev key reuse).
- [ ] `ENCRYPTION_KEY` set (app throws on Rekart connect without it).
- [ ] `REKART_STATIC_API_KEY` matches the value on the Rekart backend side.
- [ ] `APP_ENV=production` (Docker/backend).
- [ ] App reachable behind Nginx over TLS; embedded install/OAuth completes.
