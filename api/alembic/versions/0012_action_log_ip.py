"""Журнал действий: IP сотрудника и индексы для админки (сводка, тревоги, журнал).

Revision ID: 0012
Revises: 0011
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0012'
down_revision: Union[str, None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('action_log', schema=None) as batch_op:
        batch_op.add_column(sa.Column('ip', sa.String(length=64), nullable=True))
        batch_op.create_index('ix_action_log_created_at', ['created_at'], unique=False)
        batch_op.create_index('ix_action_log_entity_action', ['entity', 'action'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('action_log', schema=None) as batch_op:
        batch_op.drop_index('ix_action_log_entity_action')
        batch_op.drop_index('ix_action_log_created_at')
        batch_op.drop_column('ip')
