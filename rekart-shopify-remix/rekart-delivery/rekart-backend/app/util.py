"""Small shared helpers."""

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Current UTC time as a tz-naive ``datetime``.

    Replaces the deprecated ``datetime.utcnow``. Returns a naive value on
    purpose so it matches the plain ``DateTime`` (tz-naive) columns used across
    the models; changing those to ``DateTime(timezone=True)`` would require a
    migration.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
