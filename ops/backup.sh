#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/lock/pointjoy-backup.lock
flock -n 9 || exit 0
source /etc/pointjoy/backup.env
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=/var/backups/pointjoy-v1
mkdir -p "$backup_dir"
partial="$backup_dir/$stamp.tgz.enc.partial"
staging=$(mktemp -d /var/backups/pointjoy-stage.XXXXXX)
trap 'rm -rf "$staging"' EXIT
runuser -u postgres -- pg_dump -Fc pointjoy > "$staging/database.dump"
tar -C /var/lib/pointjoy -czf "$staging/private-media.tgz" media exports
# The recovery protection journal is preserved independently and must be replayed,
# never overwritten by restoring database/private-media backups.
(cd "$staging" && sha256sum database.dump private-media.tgz > checksums.txt)
tar -C "$staging" -czf - . | /opt/pointjoy/runtime/bin/node /opt/pointjoy/ops/backup-crypto.mjs encrypt /etc/pointjoy/backup.key - "$partial"
mv "$partial" "$backup_dir/$stamp.tgz.enc"
find /var/backups/pointjoy-rebuild -type f -name '*.enc' -mmin +50400 -delete
find "$backup_dir" -type f -name '*.tgz.enc' -mmin +50400 -delete
rm -rf "$staging"
trap - EXIT
set -a
source /etc/pointjoy/worker.env
set +a
export POINTJOY_BACKUP_LOCK_FD=9
/opt/pointjoy/runtime/bin/node /opt/pointjoy/api/dist/privacy/maintenance.js backup-confirm --config /etc/pointjoy/privacy-maintenance.json --operator pointjoy-backup-service
