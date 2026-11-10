#!/usr/bin/env bash
# 服务器端发布步骤（deploy.sh 上传代码后通过 ssh 调用；不要手动运行）
#   bash /opt/readflow/releases/<版本>/deploy/remote-release.sh <版本>
#
# 安装依赖 → 构建 → 切换 current → 重启 → 健康检查；
# 任何一步失败都不碰正在运行的旧版本，健康检查失败则自动回滚。
set -euo pipefail

REL="${1:?缺少版本号}"
APP_DIR="/opt/readflow"
DATA_DIR="/var/lib/readflow"
NEW="$APP_DIR/releases/$REL"
PORT="$(sed -n 's/^PORT=//p' /etc/readflow/readflow.env 2>/dev/null | tail -1)"
PORT="${PORT:-3000}"
KEEP=3

info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
as_app() { runuser -u readflow -- env HOME=/home/readflow PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
has_systemd() { [ -d /run/systemd/system ]; }

[ -d "$NEW" ] || die "找不到 $NEW"
cd "$NEW"
# data/ 软链接要等构建完再建：Turbopack 不允许项目里有指向项目外的软链接
rm -rf data
chown -R readflow:readflow "$NEW"

PREV="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"
[ "$PREV" = "$NEW" ] && PREV=""

# ---- 依赖：package-lock 没变就直接复用上个版本的 node_modules（省几分钟）----
if [ -n "$PREV" ] && [ -d "$PREV/node_modules" ] && cmp -s "$PREV/package-lock.json" package-lock.json; then
  info "依赖未变，复用上个版本的 node_modules"
  cp -a "$PREV/node_modules" ./node_modules
else
  info "安装依赖（npm ci，首次约需几分钟）…"
  as_app npm ci --no-audit --no-fund --loglevel=error
fi

# ---- 构建：用数据库快照，不碰线上库 ----
# next build 收集页面数据时会打开数据库；直接用线上库会和运行中的服务抢锁。
BUILD_DB="$NEW/.build.db"
if [ -f "$DATA_DIR/data/readflow.db" ]; then
  sqlite3 "$DATA_DIR/data/readflow.db" ".backup '$BUILD_DB'"
  chown readflow:readflow "$BUILD_DB"
fi
info "构建（2G 内存的机器约需几分钟）…"
as_app env DB_PATH="$BUILD_DB" NODE_OPTIONS=--max-old-space-size=1536 NEXT_TELEMETRY_DISABLED=1 npm run build
rm -f "$BUILD_DB" "$BUILD_DB-wal" "$BUILD_DB-shm"
ok "构建完成"

# 所有运行时数据（数据库 / 词典 / 图片缓存）都在 data/ 下：指向共享数据目录，升级不动数据
rm -rf data
ln -sfn "$DATA_DIR/data" data
chown -h readflow:readflow data

# ---- 切换并重启 ----
ln -sfn "$NEW" "$APP_DIR/current.tmp" && mv -T "$APP_DIR/current.tmp" "$APP_DIR/current"
restart() {
  if has_systemd; then
    systemctl restart readflow
  else
    # 容器 / 无 systemd 环境（只用于测试）：直接拉起进程
    pkill -f 'next/dist/bin/next start' 2>/dev/null || true
    sleep 1
    (cd "$APP_DIR/current" && set -a && . /etc/readflow/readflow.env && set +a \
      && runuser -u readflow -- env PATH=/usr/local/bin:/usr/bin:/bin DB_PATH="$DB_PATH" PORT="$PORT" TRUST_PROXY="$TRUST_PROXY" NODE_ENV=production \
        nohup node node_modules/next/dist/bin/next start -p "$PORT" -H "$READFLOW_HOST" >/tmp/readflow.log 2>&1 &)
  fi
}
restart

healthy() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/auth/status" && return 0
    sleep 1
  done
  return 1
}
if healthy; then
  ok "新版本已上线：$REL"
else
  if [ -n "$PREV" ]; then
    ln -sfn "$PREV" "$APP_DIR/current.tmp" && mv -T "$APP_DIR/current.tmp" "$APP_DIR/current"
    restart
    die "新版本 60 秒内没起来，已回滚到 $(basename "$PREV")。看日志：journalctl -u readflow -n 100"
  fi
  die "服务没起来。看日志：journalctl -u readflow -n 100"
fi

# ---- 只保留最近几个版本 ----
CUR="$(readlink -f "$APP_DIR/current")"
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | sed 's:/$::' | while read -r d; do
  [ "$d" = "$CUR" ] && continue
  echo "$d"
done | tail -n +"$KEEP" | xargs -r rm -rf
