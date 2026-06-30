#!/bin/sh
set -e

# Apply Alembic migrations before starting — but only for the role that owns the
# schema (the API). The Celery worker sets RUN_MIGRATIONS=false so the two roles
# don't race to migrate on startup. The worker itself does no DB I/O.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] alembic upgrade head"
  alembic upgrade head
fi

exec "$@"
