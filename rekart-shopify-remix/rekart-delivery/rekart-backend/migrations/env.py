"""Alembic migration environment — async (AsyncEngine) pattern.

The database URL is taken from the application settings (app.config.Settings),
which loads DATABASE_URL from the environment / .env. This guarantees migrations
and the running app always target the same database.
"""

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

from app.config import get_settings

# Importing the models module registers every table on Base.metadata, which is
# what `alembic revision --autogenerate` diffs against.
from app.models.shop import Base  # noqa: F401

# Alembic Config object, provides access to values in alembic.ini.
config = context.config

# Override sqlalchemy.url from app settings (reads DATABASE_URL via .env/env).
# Escape '%' so configparser interpolation does not treat URL-encoded characters
# (e.g. in a password) as interpolation tokens.
_db_url = get_settings().database_url
config.set_main_option("sqlalchemy.url", _db_url.replace("%", "%%"))

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode — emits SQL without a DBAPI connection."""
    context.configure(
        url=_db_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Create an AsyncEngine and run migrations through a sync-wrapped connection."""
    configuration = config.get_section(config.config_ini_section, {})
    # Use the raw (un-escaped) URL for the actual engine connection.
    configuration["sqlalchemy.url"] = _db_url
    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()