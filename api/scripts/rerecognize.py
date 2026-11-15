"""Заново распознать фото проекта (как кнопка «Распознать» в приложении) — по просьбе мастера, с сервера.

Нужен, когда правила распознавания или ядро изменились и мастер просит пересобрать эскиз: берёт исходные фото
проекта и его текст, запускает то же задание ИИ (`ai.design`), что и приложение. Новая версия становится текущей,
прежние версии остаются (в приложении — «Отменить»). Расход ИИ записывается на проект, как обычно.

    python scripts/rerecognize.py --share-token TOKEN      # проект по ссылке клиента
    python scripts/rerecognize.py --project-id UUID
"""

import argparse
import json
import uuid

from sqlalchemy import select

from mebel_api.config import Settings
from mebel_api.db import Database
from mebel_api.models import Project, ShareLink
from mebel_api.services.ai import AiRunner
from mebel_api.services.storage import make_storage


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--share-token")
    g.add_argument("--project-id")
    ap.add_argument("--user-id", default=None, help="от чьего имени (по умолчанию — автор ссылки клиента)")
    a = ap.parse_args()

    settings = Settings()
    if not settings.anthropic_api_key:
        raise SystemExit("ANTHROPIC_API_KEY не настроен")
    db = Database(settings.database_url)
    user_id = a.user_id
    with db.sessionmaker() as s:
        if a.share_token:
            link = s.scalar(select(ShareLink).where(ShareLink.token == a.share_token))
            if link is None:
                raise SystemExit("ссылка не найдена")
            project_id = link.project_id
            user_id = user_id or (str(link.created_by) if link.created_by else None)
        else:
            project_id = uuid.UUID(a.project_id)
        project = s.get(Project, project_id)
        if project is None:
            raise SystemExit("проект не найден")
        text = project.source_text or ""

    import anthropic
    from mebel_ai import LLM

    llm = LLM(client=anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=90.0, max_retries=2))
    runner = AiRunner(db, make_storage(settings), settings)
    out = runner.design({"project_id": str(project_id), "user_id": user_id, "text": text}, llm)
    print(json.dumps({"project_id": str(project_id), "status": out.get("status"), "version_id": out.get("version_id"),
                      "questions": len(out.get("questions") or []), "error": out.get("error")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
