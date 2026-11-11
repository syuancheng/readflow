#!/usr/bin/env bash
# 本机构建 → 上传产物 → 服务器只装依赖不构建（在 Mac、项目根目录运行）
#
#   bash deploy/release-local.sh
#
# 与 deploy/deploy.sh release 的区别：
#   deploy.sh release  在服务器上跑 npm ci + next build（适合 2G 内存、能连 Google Fonts 的机器）
#   本脚本             在 Mac 上构建，只把 .next 传上去（适合 1 GiB 试用机 / 国内网络）
#
# 前提：已经跑过 bash deploy/deploy.sh setup 和 init-data。
# 发布的是本地工作区当前代码（含未提交改动），不依赖 git archive。
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/deploy/deploy.conf"

info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$CONF" ] || die "缺少 deploy/deploy.conf：先执行 cp deploy/deploy.conf.example deploy/deploy.conf 并填写服务器地址"
# shellcheck source=/dev/null
. "$CONF"
: "${SERVER:?deploy.conf 里要填 SERVER，例如 root@1.2.3.4}"
SSH_PORT="${SSH_PORT:-22}"
read -r -a EXTRA_OPTS <<< "${SSH_OPTS:-}"
[ -n "${SSH_KEY:-}" ] && EXTRA_OPTS+=(-i "$SSH_KEY")
SSH=(ssh -p "$SSH_PORT" -o ServerAliveInterval=30 ${EXTRA_OPTS[@]+"${EXTRA_OPTS[@]}"} "$SERVER")
RSYNC_SSH="ssh -p $SSH_PORT ${SSH_OPTS:-}${SSH_KEY:+ -i $SSH_KEY}"

cd "$ROOT"
for cmd in node npm sqlite3 rsync ssh tar; do
  command -v "$cmd" >/dev/null || die "本机缺少 $cmd"
done

REL="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo local)-prebuilt"

# ---- 1. 本机构建 ----
# 用一份数据库快照给构建用，避免和本机正在跑的 3000 服务抢 SQLite 锁。
# 字体（next/font/google）也是在这一步下载并自托管进 .next/static/media 的，
# 所以服务器全程不需要访问 Google Fonts。
BUILD_DB=""
if [ -f "$ROOT/data/readflow.db" ]; then
  BUILD_DB="$(mktemp -t rf-build).db"
  sqlite3 "$ROOT/data/readflow.db" ".backup '$BUILD_DB'"
fi
info "在 Mac 上构建（约 10–30 秒）…"
if [ -n "$BUILD_DB" ]; then
  DB_PATH="$BUILD_DB" NEXT_TELEMETRY_DISABLED=1 npm run build
  rm -f "$BUILD_DB" "$BUILD_DB-wal" "$BUILD_DB-shm"
else
  NEXT_TELEMETRY_DISABLED=1 npm run build
fi
ok "构建完成"

# ---- 2. 打包（.next/cache 是 76MB 构建缓存，运行时不需要）----
TGZ="$(mktemp -t rf-prebuilt).tgz"
info "打包产物…"
# COPYFILE_DISABLE / --no-mac-metadata：不带 macOS 扩展属性，服务器解压时就不会刷 LIBARCHIVE.xattr 警告
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$TGZ" \
  --exclude '.next/cache' \
  --exclude '.next/trace' \
  .next package.json package-lock.json next.config.ts public src
ok "产物 $(du -h "$TGZ" | cut -f1)"

# ---- 3. 上传 ----
info "上传到 $SERVER …"
rsync -az --progress -e "$RSYNC_SSH" "$TGZ" "$SERVER:/tmp/readflow-prebuilt.tgz"
rsync -az -e "$RSYNC_SSH" "$ROOT/deploy/" "$SERVER:/root/readflow-deploy/"

# ---- 4. 远程安装 ----
"${SSH[@]}" "set -e
  mkdir -p /opt/readflow/releases/$REL
  tar --no-same-owner -xzf /tmp/readflow-prebuilt.tgz -C /opt/readflow/releases/$REL
  bash /root/readflow-deploy/remote-prebuilt.sh $REL
  rm -f /tmp/readflow-prebuilt.tgz"
rm -f "$TGZ"

echo
ok "发布完成：$REL"
echo "  查看状态：bash deploy/deploy.sh status"
echo "  查看日志：bash deploy/deploy.sh logs"
warn "改完代码后重新运行本脚本即可发布新版本（会保留 data/ 与最近 3 个版本）"
