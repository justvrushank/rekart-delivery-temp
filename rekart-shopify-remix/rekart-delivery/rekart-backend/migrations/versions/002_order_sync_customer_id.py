"""add shopify_customer_id to shopify_order_sync

Revision ID: 002_order_sync_customer_id
Revises: 001_shopify_tables
Create Date: 2026-06-11
"""

from alembic import op
import sqlalchemy as sa

revision = '002_order_sync_customer_id'
down_revision = '001_shopify_tables'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'shopify_order_sync',
        sa.Column('shopify_customer_id', sa.String(100), nullable=True),
    )
    op.create_index(
        'ix_order_sync_shopify_customer_id',
        'shopify_order_sync',
        ['shopify_customer_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_order_sync_shopify_customer_id', table_name='shopify_order_sync')
    op.drop_column('shopify_order_sync', 'shopify_customer_id')