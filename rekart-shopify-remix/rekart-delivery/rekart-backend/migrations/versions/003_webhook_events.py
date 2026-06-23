"""create shopify_webhook_events table

Revision ID: 003_webhook_events
Revises: 002_order_sync_customer_id
Create Date: 2026-06-11
"""

from alembic import op
import sqlalchemy as sa

revision = '003_webhook_events'
down_revision = '002_order_sync_customer_id'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'shopify_webhook_events',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('webhook_id', sa.String(100), nullable=False),
        sa.Column('topic', sa.String(100), nullable=False),
        sa.Column('received_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    # webhook_id is unique=True + index=True on the model -> a single unique index.
    op.create_index(
        'ix_shopify_webhook_events_webhook_id',
        'shopify_webhook_events',
        ['webhook_id'],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index('ix_shopify_webhook_events_webhook_id', table_name='shopify_webhook_events')
    op.drop_table('shopify_webhook_events')