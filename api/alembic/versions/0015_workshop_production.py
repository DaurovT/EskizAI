"""Настройки производства цеха (SCR-56): крепёж корпуса, глубина конфирмата, марка петель, сетка 32.

Revision ID: 0015
Revises: 0014
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0015'
down_revision: Union[str, None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Без batch: в SQLite batch пересоздаёт таблицу, а на workshops ссылаются внешние ключи (DROP TABLE падает)
    op.add_column('workshops', sa.Column('production', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('workshops', 'production')  # SQLite ≥ 3.35 — ALTER TABLE DROP COLUMN, без пересоздания
