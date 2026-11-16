"""Входящий чертёж → проект (POST /inbox/drawings/{id}/project): ссылка на созданный проект.

Revision ID: 0014
Revises: 0013
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0014'
down_revision: Union[str, None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('inbox_drawings', schema=None) as batch_op:
        batch_op.add_column(sa.Column('project_id', sa.Uuid(), nullable=True))
        batch_op.create_index(batch_op.f('ix_inbox_drawings_project_id'), ['project_id'], unique=False)
        batch_op.create_foreign_key('fk_inbox_drawings_project_id', 'projects', ['project_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    with op.batch_alter_table('inbox_drawings', schema=None) as batch_op:
        batch_op.drop_constraint('fk_inbox_drawings_project_id', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_inbox_drawings_project_id'))
        batch_op.drop_column('project_id')
