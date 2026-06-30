# Running the stack with Docker

A single `docker compose up` brings up the whole system: the Remix app, the
FastAPI reference backend, a Celery worker, PostgreSQL (two databases), and Redis.

## Services

| Service   | Image / build              | Host port | Purpose |
|-----------|----------------------------|-----------|---------|
| `app`     | root `Dockerfile`          | 3000      | Remix embedded Shopify app (UI, lifecycle/GDPR, fulfillment-push receiver) |
| `backend` | `rekart-backend/Dockerfile`| 8000      | FastAPI reference backend (webhooks + sync API); runs Alembic migrations on boot |
| `worker`  | `rekart-backend/Dockerfile`| –         | Celery worker (`sync_order`, `sync_customer`, `backfill_shop`) |
| `db`      | `postgres:16-alpine`       | 5432      | Two DBs: `rekart_shopify` (Remix/Prisma) + `rekart_db` (backend/Alembic) |
| `redis`   | `redis:7-alpine`           | 6380      | Celery broker + result backend |

> The Remix app and the FastAPI backend are **independent** (see
> `docs/ARCHITECTURE.md`). The Remix app's `REKART_BACKEND_URL` points at the real
> Rekart (Laravel) backend; the in-repo FastAPI service is the portable reference
> implementation and is exercised on its own at `:8000`.

## Quick start

```bash
cp .env.docker.example .env          # then fill SHOPIFY_API_KEY / SHOPIFY_API_SECRET
docker compose up --build            # build + start everything
```

- App:      http://localhost:3000
- Backend:  http://localhost:8000  (health: http://localhost:8000/health, docs: `/docs` in dev)

A ready-to-run `.env` with generated dev secrets (`ENCRYPTION_KEY`,
`REKART_STATIC_API_KEY`, `REKART_INTERNAL_API_KEY`) is already present; you only
need to add your Shopify credentials. **Regenerate every secret for any shared or
production environment** (`openssl rand -hex 32`).

## Common commands

```bash
docker compose up -d --build         # start detached
docker compose logs -f app backend   # tail logs
docker compose ps                    # status + health
docker compose down                  # stop (keeps data volumes)
docker compose down -v               # stop + wipe PostgreSQL/Redis data
docker compose build --no-cache app  # force a clean rebuild of one image
```

## How startup works

- **Migrations run automatically.**
  - `app` runs `prisma migrate deploy` (via `npm run docker-start`) once PostgreSQL is
    healthy, applying the committed PostgreSQL migrations in `prisma/migrations/`.
  - `backend` runs `alembic upgrade head` (via `docker-entrypoint.sh`, gated on
    `RUN_MIGRATIONS=true`) before `uvicorn`. The `worker` sets
    `RUN_MIGRATIONS=false` so the two roles never race to migrate.
- **Ordering** is enforced with healthchecks: `app` waits for `db`; `backend`
  waits for `db` + `redis`.
- **Two databases on one PostgreSQL server**: `POSTGRES_DB` creates `rekart_shopify`;
  `docker/postgres/init.sql` creates `rekart_db` (owned by the same user).

## Schema provider: PostgreSQL (Docker) vs SQLite (local dev)

The repo keeps **two** Prisma schema files because Prisma forbids `env()` in the
datasource `provider` (error P1012) — so a single file cannot serve both
databases:

| File | Provider | Used by |
|------|----------|---------|
| `prisma/schema.prisma` (canonical) | `postgresql`, migrations in `prisma/migrations/` | Docker image + production (`prisma migrate deploy`) |
| `prisma/schema.sqlite.prisma` (mirror) | `sqlite` | Local non-Docker dev only (`npm run setup:local`, `db push`) |

The Prisma schema uses two files to switch between sqlite (local dev) and
postgresql (Docker/production). **The Docker `app` container always uses the
canonical `prisma/schema.prisma` (PostgreSQL)** — its `docker-start` runs
`prisma generate && prisma migrate deploy` against the `db` (PostgreSQL) service.
Local non-Docker development sets `DATABASE_URL=file:./dev.db` in `.env` and runs
`npm run setup:local` (which targets `prisma/schema.sqlite.prisma`); `npm run dev`
auto-regenerates the sqlite client via the `predev` hook. **Never run
`docker compose up` expecting it to use sqlite** — the image is PostgreSQL-only,
and pointing it at a `file:` URL will fail at `prisma migrate deploy`.

> ‼️ The two schema files must be kept in sync: any model change in
> `prisma/schema.prisma` must be mirrored into `prisma/schema.sqlite.prisma`
> (identical except the `provider` line).

No `@db.Text` annotations are needed: PostgreSQL maps Prisma `String` to unbounded
`TEXT` by default (and sqlite `String` is already unbounded TEXT), so the long
fields (`rekartAccessToken`, `GdprRequest.payload`, etc.) need no per-field type
override. The `20260625000000_init_postgresql` baseline creates them as `TEXT`.

## Configuration reference

All values are set in `.env` (compose interpolation). `DATABASE_URL` and
`REDIS_URL` are assembled inside `docker-compose.yml` from the PostgreSQL credentials —
you don't set them directly.

| Variable | Used by | Notes |
|----------|---------|-------|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | app, backend | From the Partner Dashboard |
| `SHOPIFY_APP_URL` | app, backend | Public app URL (tunnel/prod); `http://localhost:3000` for local |
| `SCOPES` | app, backend | Mapped to `SHOPIFY_SCOPES` for the backend |
| `ENCRYPTION_KEY` | app | 32-byte hex; encrypts the Rekart token at rest |
| `REKART_STATIC_API_KEY` | app, backend | Shared `X-API-Key`; must match on both sides |
| `REKART_INTERNAL_API_KEY` | backend, worker | Key for backend → Rekart ingest/upsert |
| `REKART_BACKEND_URL` / `REKART_LOGIN_URL` | app | Rekart (Laravel) host; default `https://dev3.rekart.io` |
| `APP_ENV` | backend, worker | `development` enables `/docs` + dev CORS |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | db | Credentials + assembled URLs |
| `APP_PORT` / `BACKEND_PORT` / `POSTGRES_PORT` / `REDIS_PORT` | host | Change if they clash with local services |

## Notes & caveats

- The Remix app is an **embedded Shopify app**; running the container serves it,
  but a real install/OAuth still needs a public HTTPS URL (Shopify CLI tunnel or a
  deployed domain) set in `SHOPIFY_APP_URL` and the Partner Dashboard.
- `APP_ENV=development` exposes the backend's `/docs` and opens CORS; set it to
  `production` for any non-local deploy.
- Data persists in the `postgres_data` / `redis_data` named volumes across restarts;
  `docker compose down -v` wipes them for a clean slate.
