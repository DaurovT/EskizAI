"""Настройки уведомлений, платежи платформе, логотип цеха, срок цены под запрос, комментарий конструктора.

Revision ID: 0006
Revises: 0005
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0006'
down_revision: Union[str, None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Платежи цеха платформе: пакет, Pro, файлы; возврат — статус (SCR-42)
    op.create_table('payments',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=True),
    sa.Column('amount', sa.Integer(), nullable=False),
    sa.Column('method', sa.String(length=20), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('receipt_url', sa.String(length=1000), nullable=True),
    sa.Column('reference', sa.String(length=200), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('paid_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('refunded_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('payments', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_payments_workshop_id'), ['workshop_id'], unique=False)

    # Настройки push по типам и тихие часы (FR-66)
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('notification_settings', sa.JSON(), nullable=True))

    # Ключ файла логотипа — чтобы удалять старый при замене
    with op.batch_alter_table('workshops', schema=None) as batch_op:
        batch_op.add_column(sa.Column('logo_key', sa.String(length=500), nullable=True))

    # «Действует до» у цены под запрос (SCR-30)
    with op.batch_alter_table('price_requests', schema=None) as batch_op:
        batch_op.add_column(sa.Column('valid_until', sa.DateTime(timezone=True), nullable=True))

    # Комментарий конструктора к оценке нестандарта (SCR-34)
    with op.batch_alter_table('nonstandard_requests', schema=None) as batch_op:
        batch_op.add_column(sa.Column('designer_comment', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('nonstandard_requests', schema=None) as batch_op:
        batch_op.drop_column('designer_comment')

    with op.batch_alter_table('price_requests', schema=None) as batch_op:
        batch_op.drop_column('valid_until')

    with op.batch_alter_table('workshops', schema=None) as batch_op:
        batch_op.drop_column('logo_key')

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('notification_settings')

    with op.batch_alter_table('payments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_payments_workshop_id'))

    op.drop_table('payments')
