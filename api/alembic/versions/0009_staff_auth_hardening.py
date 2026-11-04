"""Вход сотрудников: атомарные счётчики попыток (почта+IP, IP, 2FA), одноразовый mfa_token,
версия 2FA для атомарного списания резервных кодов.

Безопасно на живой базе: две новые таблицы и колонка с server_default.

Revision ID: 0009
Revises: 0008
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0009'
down_revision: Union[str, None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DT = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table('auth_throttle',
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('staff_id', sa.Uuid(), nullable=True),
    sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
    sa.Column('window_start', DT, nullable=False),
    sa.Column('locked_until', DT, nullable=True),
    sa.Column('updated_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('key'),
    )
    op.create_index('ix_auth_throttle_staff_id', 'auth_throttle', ['staff_id'], unique=False)
    op.create_index('ix_auth_throttle_updated_at', 'auth_throttle', ['updated_at'], unique=False)

    op.create_table('staff_mfa_challenges',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('staff_id', sa.Uuid(), nullable=False),
    sa.Column('expires_at', DT, nullable=False),
    sa.Column('used_at', DT, nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_staff_mfa_challenges_staff_id', 'staff_mfa_challenges', ['staff_id'], unique=False)

    op.add_column('staff_mfa', sa.Column('version', sa.Integer(), server_default='0', nullable=False))


def downgrade() -> None:
    op.drop_column('staff_mfa', 'version')
    op.drop_index('ix_staff_mfa_challenges_staff_id', table_name='staff_mfa_challenges')
    op.drop_table('staff_mfa_challenges')
    op.drop_index('ix_auth_throttle_updated_at', table_name='auth_throttle')
    op.drop_index('ix_auth_throttle_staff_id', table_name='auth_throttle')
    op.drop_table('auth_throttle')
