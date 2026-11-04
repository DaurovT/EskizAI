"""Источник названия проекта: auto (сервер ведёт по модели) | user (ввёл мастер).

Revision ID: 0007
Revises: 0006
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0007'
down_revision: Union[str, None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Существующие названия считаем введёнными мастером; «Новый проект 03.11.2026» переименует
    # scripts/retitle_projects.py (и сервер — при следующей версии модели)
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('title_source', sa.String(length=10), server_default='user', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('title_source')
