#!/usr/bin/env bash
# ReadFlow 数据库备份（server-setup.sh 安装为 /usr/local/bin/readflow-backup，cron 每天 03:30 运行）
# 用 SQLite 的在线备份（.backup），服务运行中也能拿到一致的快照，不用停机。
#   readflow-backup            手动备份一次
#   KEEP=30 readflow-backup    保留份数（默认 14）
set -euo pipefail

DB="${DB_PATH:-/var/lib/readflow/data/readflow.db}"
OUT="${BACKUP_DIR:-/var/lib/readflow/backups}"
KEEP="${KEEP:-14}"

if [ ! -f "$DB" ]; then
  echo "$(date '+%F %T') 跳过：还没有数据库 $DB"
  exit 0
fi

mkdir -p "$OUT"
file="$OUT/readflow-$(date +%Y%m%d-%H%M%S).db"
sqlite3 "$DB" ".backup '$file'"
# 先校验再压缩：坏备份比没备份更危险
if [ "$(sqlite3 "$file" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "$(date '+%F %T') ✗ 备份校验失败：$file" >&2
  rm -f "$file"
  exit 1
fi
gzip -f "$file"

# 只保留最近 KEEP 份
ls -1t "$OUT"/readflow-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "$(date '+%F %T') ✓ $file.gz（$(du -h "$file.gz" | cut -f1)）"
