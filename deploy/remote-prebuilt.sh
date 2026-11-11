#!/usr/bin/env bash
# 服务器端：安装「Mac 上已构建好的 .next」产物，服务器上不跑 next build。
# 由 deploy/release-local.sh 通过 ssh 调用，不要手动运行。
#
# 为什么不跑 build：这台机器只有 1 GiB 内存，且 next/font/google 构建时要连
# Google Fonts（国内服务器基本连不上）。两件事都在 Mac 上解决，服务器只负责运行。
set -euo pipefail

REL="${1:?缺少版本号}"
APP_DIR="/opt/readflow"
DATA_DIR="/var/lib/readflow"
ENV_FILE="/etc/readflow/readflow.env"
NEW="$APP_DIR/releases/$REL"
KEEP=3

info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$NEW" ] || die "找不到 $NEW"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE：先在 Mac 上运行 bash deploy/deploy.sh setup"
cd "$NEW"
# 产物是 root 解压的，npm ci 以 readflow 身份跑：先把目录交给 readflow，否则建 node_modules 会 EACCES
chown -R readflow:readflow "$NEW"

PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
PORT="${PORT:-3000}"

PREV="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"
[ "$PREV" = "$NEW" ] && PREV=""

# ---- 1. 依赖 ----
# --omit=dev 不能省：devDependencies 里的 playwright 会在 postinstall 下载浏览器，
# 国内服务器上又慢又容易失败，而运行时根本用不到它。
if [ -n "$PREV" ] && [ -d "$PREV/node_modules" ] && cmp -s "$PREV/package-lock.json" package-lock.json; then
  info "依赖未变，复用上个版本的 node_modules"
  cp -a "$PREV/node_modules" ./node_modules
else
  info "安装生产依赖（npm ci --omit=dev）…"
  runuser -u readflow -- env HOME=/home/readflow PATH=/usr/local/bin:/usr/bin:/bin \
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
fi
ok "依赖就绪"

# ---- 2. 数据目录 ----
# 运行时数据（db / 词典 / 图片缓存）都在共享目录，升级和回滚都不碰它
rm -rf data
ln -sfn "$DATA_DIR/data" data
chown -h readflow:readflow data
chown -R readflow:readflow "$NEW"

# ---- 3. 切换版本并重启 ----
ln -sfn "$NEW" "$APP_DIR/current.tmp" && mv -T "$APP_DIR/current.tmp" "$APP_DIR/current"
restart() {
  if [ -d /run/systemd/system ]; then
    systemctl restart readflow
  else
    pkill -f 'next/dist/bin/next start' 2>/dev/null || true
    sleep 1
    (cd "$APP_DIR/current" && set -a && . "$ENV_FILE" && set +a \
      && runuser -u readflow -- env PATH=/usr/local/bin:/usr/bin:/bin \
           nohup node node_modules/next/dist/bin/next start -p "$PORT" -H "$READFLOW_HOST" >/tmp/readflow.log 2>&1 &)
  fi
}
restart

# ---- 4. 健康检查（/api/auth/status 免登录，middleware 放行）----
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
    die "60 秒内没起来，已回滚到 $(basename "$PREV")。看日志：journalctl -u readflow -n 100"
  fi
  die "服务没起来。看日志：journalctl -u readflow -n 100"
fi

# ---- 5. 只保留最近几个版本 ----
CUR="$(readlink -f "$APP_DIR/current")"
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | sed 's:/$::' | while read -r d; do
  [ "$d" = "$CUR" ] && continue
  echo "$d"
done | tail -n +"$KEEP" | xargs -r rm -rf

echo
ok "访问 http://$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo 你的公网IP) 即可打开"
