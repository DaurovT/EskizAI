"""push, nonstandard, price requests, order number and payment link, estimated pointers and price cache

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-02 20:18:39.326676
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0003'
down_revision: Union[str, None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Уведомления (раздел 19), заявки «нестандарт» (ADM-09), позиции «под запрос» (ADM-07);
    # «оценка» и кэш цены в версии модели; номер заказа, ссылка на оплату EMAN, «оплата не прошла»
    op.create_table('notifications',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('body', sa.String(length=500), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('dedupe_key', sa.String(length=200), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('error', sa.String(length=500), nullable=True),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.create_index('ix_notifications_dedupe', ['user_id', 'dedupe_key'], unique=False)
        batch_op.create_index(batch_op.f('ix_notifications_user_id'), ['user_id'], unique=False)

    op.create_table('price_requests',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('line_key', sa.String(length=120), nullable=False),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('unit', sa.String(length=20), nullable=False),
    sa.Column('qty', sa.Double(), nullable=False),
    sa.Column('estimate_price', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('price', sa.Integer(), nullable=True),
    sa.Column('lead_days', sa.Integer(), nullable=True),
    sa.Column('supplier_name', sa.String(length=200), nullable=True),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('catalog_item_id', sa.Uuid(), nullable=True),
    sa.Column('priced_by', sa.String(length=64), nullable=True),
    sa.Column('priced_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['catalog_item_id'], ['catalog_items.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id', 'line_key')
    )
    with op.batch_alter_table('price_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_price_requests_line_key'), ['line_key'], unique=False)
        batch_op.create_index(batch_op.f('ix_price_requests_project_id'), ['project_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_price_requests_workshop_id'), ['workshop_id'], unique=False)

    op.create_table('nonstandard_requests',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('number', sa.Integer(), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('author_id', sa.Uuid(), nullable=True),
    sa.Column('version_id', sa.Uuid(), nullable=True),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('photo_ids', sa.JSON(), nullable=False),
    sa.Column('differences', sa.JSON(), nullable=False),
    sa.Column('path', sa.String(length=20), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('assignee', sa.String(length=200), nullable=True),
    sa.Column('price', sa.Integer(), nullable=True),
    sa.Column('lead_days', sa.Integer(), nullable=True),
    sa.Column('manager_note', sa.Text(), nullable=True),
    sa.Column('files', sa.JSON(), nullable=False),
    sa.Column('estimated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('done_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['version_id'], ['model_versions.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('nonstandard_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_nonstandard_requests_project_id'), ['project_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_nonstandard_requests_workshop_id'), ['workshop_id'], unique=False)

    with op.batch_alter_table('model_versions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('estimated', sa.JSON(), server_default='[]', nullable=False))
        batch_op.add_column(sa.Column('price_cache', sa.JSON(), nullable=True))

    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.add_column(sa.Column('number', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('payment_url', sa.String(length=1000), nullable=True))
        batch_op.add_column(sa.Column('payment_failed_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index(batch_op.f('ix_orders_number'), ['number'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_orders_number'))
        batch_op.drop_column('payment_failed_at')
        batch_op.drop_column('payment_url')
        batch_op.drop_column('number')

    with op.batch_alter_table('model_versions', schema=None) as batch_op:
        batch_op.drop_column('price_cache')
        batch_op.drop_column('estimated')

    with op.batch_alter_table('nonstandard_requests', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_nonstandard_requests_workshop_id'))
        batch_op.drop_index(batch_op.f('ix_nonstandard_requests_project_id'))

    op.drop_table('nonstandard_requests')
    with op.batch_alter_table('price_requests', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_price_requests_workshop_id'))
        batch_op.drop_index(batch_op.f('ix_price_requests_project_id'))
        batch_op.drop_index(batch_op.f('ix_price_requests_line_key'))

    op.drop_table('price_requests')
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_notifications_user_id'))
        batch_op.drop_index('ix_notifications_dedupe')

    op.drop_table('notifications')
