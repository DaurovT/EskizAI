# Выкладка Eskiz Oyna

Общий VPS (тот же, что Eskiz Mebel и Temir), свой compose-проект `oyna`, своя база. Адрес API — `https://api.oyna.eskizai.uz`.

1. DNS: A-запись `api.oyna.eskizai.uz` → IP сервера (панель webname.uz).
2. Код: `git archive HEAD | ssh … 'mkdir -p /opt/oyna && tar -x -C /opt/oyna'`.
3. Секреты: `/opt/oyna/deploy/.env` (chmod 600): `POSTGRES_PASSWORD`, `OYNA_JWT_SECRET` (≥ 32 символа), `OYNA_ADMIN_TOKEN`, `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` (как у Mebel).
4. `cd /opt/oyna && sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build` — первый запуск сам создаёт таблицы и загружает справочники.
5. Caddy: блок `deploy/oyna.caddy` добавляет сессия Eskiz Mebel в `/opt/mebel/deploy/Caddyfile`, затем `docker restart mebel-caddy-1`.
6. Копии: `/etc/cron.d/oyna-backup` → `deploy/backup.sh` (ночью).

Проверка: `curl https://api.oyna.eskizai.uz/health`.
