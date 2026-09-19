#!/usr/bin/env bash
# Authorized one-time rebuild: only the PointJoy application/database is reset.
set -euo pipefail
umask 077
[[ $(id -un) == root ]] || { echo 'Run using ubuntu + sudo'; exit 1; }
[[ ${POINTJOY_RESET_CONFIRMATION:-} == 'pointjoy-family-v1-empty-database' ]] || { echo 'Explicit reset confirmation missing'; exit 1; }
[[ -f /etc/pointjoy/api.env && -d /opt/pointjoy/runtime && -f /tmp/pointjoy-v1-stage/api/dist/main.js ]] || exit 1
export PATH=/opt/pointjoy/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Prepare dependencies before downtime and never execute migration against another DB.
cd /tmp/pointjoy-v1-stage/api
npm ci --omit=dev --no-fund --ignore-scripts
node -e "require('sharp');require('pg');require('fastify');console.log('Runtime dependency check passed')"
install -d -m 700 /etc/pointjoy
install -m 600 /tmp/pointjoy-v1-secrets/backup.key /etc/pointjoy/backup.key
install -m 600 /tmp/pointjoy-v1-secrets/backup.env /etc/pointjoy/backup.env
install -d -m 700 /var/backups/pointjoy-rebuild
systemctl stop pointjoy-backup.timer
systemctl stop pointjoy-backup.service
exec 9>/run/lock/pointjoy-backup.lock
flock -x 9
systemctl stop pointjoy.service
systemctl stop pointjoy-worker.service 2>/dev/null || true
runuser -u postgres -- pg_dump -Fc pointjoy | node /tmp/pointjoy-v1-stage/ops/backup-crypto.mjs encrypt /etc/pointjoy/backup.key - /var/backups/pointjoy-rebuild/before-v1.dump.enc
runuser -u postgres -- psql -v ON_ERROR_STOP=1 < /tmp/pointjoy-v1-secrets/roles.sql >/dev/null
# Remove old implementation, old file media and reset exactly the pointjoy schema.
rm -rf /opt/pointjoy/api /opt/pointjoy/site /var/lib/pointjoy/avatars /var/backups/pointjoy
rm -f /usr/local/bin/pointjoy-backup
runuser -u postgres -- psql -v ON_ERROR_STOP=1 pointjoy <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION pointjoy_migrate;
GRANT ALL ON SCHEMA public TO pointjoy_migrate;
SQL
mv /tmp/pointjoy-v1-stage/api /opt/pointjoy/api
mv /tmp/pointjoy-v1-stage/site /opt/pointjoy/site
rm -rf /opt/pointjoy/ops
mv /tmp/pointjoy-v1-stage/ops /opt/pointjoy/ops
install -d -o pointjoy -g pointjoy -m 700 /var/lib/pointjoy/media /var/lib/pointjoy/exports /var/lib/pointjoy-recovery
for item in api worker migrate; do install -m 600 /tmp/pointjoy-v1-secrets/$item.env /etc/pointjoy/$item.env; done
install -m 600 /opt/pointjoy/ops/privacy-maintenance.example.json /etc/pointjoy/privacy-maintenance.json
cd /opt/pointjoy/api
set -a
source /etc/pointjoy/migrate.env
set +a
node dist/migrate.js
runuser -u postgres -- psql -v ON_ERROR_STOP=1 pointjoy -f /opt/pointjoy/ops/grants.sql >/dev/null
chown -R root:root /opt/pointjoy/api /opt/pointjoy/site /opt/pointjoy/ops
chmod -R go-w /opt/pointjoy/api /opt/pointjoy/site /opt/pointjoy/ops
chmod -R go+rX /opt/pointjoy/api /opt/pointjoy/site /opt/pointjoy/ops
install -m 644 /opt/pointjoy/ops/systemd/pointjoy.service /etc/systemd/system/pointjoy.service
install -m 644 /opt/pointjoy/ops/systemd/pointjoy-worker.service /etc/systemd/system/pointjoy-worker.service
install -m 644 /opt/pointjoy/ops/systemd/pointjoy-backup.service /etc/systemd/system/pointjoy-backup.service
install -m 644 /opt/pointjoy/ops/systemd/pointjoy-backup.timer /etc/systemd/system/pointjoy-backup.timer
install -m 644 /opt/pointjoy/ops/pointjoy.nginx.conf /etc/nginx/conf.d/pointjoy.conf
nginx -t
systemctl daemon-reload
systemctl enable --now pointjoy.service pointjoy-worker.service pointjoy-backup.timer
systemctl reload nginx
rm -rf /tmp/pointjoy-v1-secrets /tmp/pointjoy-v1-stage
for attempt in $(seq 1 20); do if curl -fsS http://127.0.0.1:4100/api/v1/health >/dev/null; then echo 'PointJoy v1 API ready'; exit 0; fi; sleep 1; done
systemctl --no-pager status pointjoy.service pointjoy-worker.service
exit 1
