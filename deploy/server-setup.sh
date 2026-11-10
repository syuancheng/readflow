#!/usr/bin/env bash
# ReadFlow 服务器初始化（在云服务器上以 root 运行一次；重复运行安全）
#
#   bash server-setup.sh                 # 先用 IP 访问（备案下来之前）
#   bash server-setup.sh read.example.com   # 已有域名（备案通过后）
#
# 适用：Ubuntu 22.04 / 24.04（阿里云、腾讯云购买时选 Ubuntu 镜像）。
# 做的事：
#   1. 装 Node（与本机同版本，走国内镜像）、Nginx、SQLite、编译工具
#   2. 2G 内存的机器加 2G 交换空间（next build 需要）
#   3. 建 readflow 系统用户与目录：
#        /opt/readflow/releases/<版本>   每次发布一份代码
#        /opt/readflow/current          → 当前版本（软链接）
#        /var/lib/readflow/data         数据库、词典、图片缓存（升级不动它）
#        /var/lib/readflow/backups      每日自动备份
#        /etc/readflow/readflow.env     环境变量（密钥可写这里，权限 640）
#   4. 装 systemd 服务（开机自启、崩溃自动重启）、Nginx 反代、每日备份定时任务
set -euo pipefail

DOMAIN="${1:-}"
NODE_VERSION="${NODE_VERSION:-24.14.1}"
APP_USER="readflow"
APP_DIR="/opt/readflow"
DATA_DIR="/var/lib/readflow"
ENV_DIR="/etc/readflow"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（或 sudo bash $0）"
command -v apt-get >/dev/null || die "目前只支持 Ubuntu（apt）。购买服务器时请选 Ubuntu 22.04 / 24.04 镜像"
for f in readflow.service nginx.conf.template backup.sh; do
  [ -f "$HERE/$f" ] || die "缺少 $HERE/$f：请把整个 deploy/ 目录上传到服务器再运行"
done

# ---------- 1. 系统依赖 ----------
info "安装系统依赖（nginx / sqlite3 / 编译工具）…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx sqlite3 build-essential python3 curl xz-utils rsync cron ca-certificates >/dev/null
ok "系统依赖就绪"

# ---------- 2. Node.js（国内镜像，与开发机同版本）----------
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) die "不支持的 CPU 架构：$(uname -m)" ;;
esac
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  info "安装 Node v$NODE_VERSION（$NODE_ARCH）…"
  tarball="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL "https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION/$tarball" -o "$tmp/$tarball" \
    || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$tmp/$tarball" \
    || die "Node 下载失败"
  rm -rf "/usr/local/lib/nodejs"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$tarball" -C /usr/local/lib/nodejs --strip-components=1
  rm -rf "$tmp"
  for b in node npm npx; do ln -sfn "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done
fi
ok "Node $(/usr/local/bin/node -v)"

# ---------- 3. 交换空间（2G 内存跑 next build 容易被 OOM 杀掉）----------
if [ "$(swapon --noheadings 2>/dev/null | wc -l)" -eq 0 ]; then
  if [ -f /swapfile ] || fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; then
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null && swapon /swapfile 2>/dev/null \
      && { grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; ok "已加 2G 交换空间"; } \
      || warn "交换空间启用失败（容器环境里正常；云服务器上请检查）"
  fi
else
  ok "已有交换空间"
fi

# ---------- 4. 用户与目录 ----------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR/releases" "$DATA_DIR/data/dict" "$DATA_DIR/data/img-cache" "$DATA_DIR/backups" "$ENV_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# npm 走国内镜像；better-sqlite3 的预编译包也走镜像（拿不到时用上面装的编译工具现场编）
cat > "/home/$APP_USER/.npmrc" <<'NPMRC'
registry=https://registry.npmmirror.com
better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3
fund=false
audit=false
NPMRC
chown "$APP_USER:$APP_USER" "/home/$APP_USER/.npmrc"
ok "用户与目录就绪（数据在 $DATA_DIR/data）"

# ---------- 5. 环境变量（已存在就不覆盖，免得冲掉你手动填的密钥）----------
if [ ! -f "$ENV_DIR/readflow.env" ]; then
  cat > "$ENV_DIR/readflow.env" <<ENV
# ReadFlow 运行时环境变量（改完执行 systemctl restart readflow 生效）
NODE_ENV=production
PORT=3000
# 只监听本机，外部访问一律经过 Nginx
READFLOW_HOST=127.0.0.1
DB_PATH=$DATA_DIR/data/readflow.db
# 前面有 Nginx：按 X-Forwarded-For 区分访客做登录限速（Nginx 已改写成真实 IP，客户端伪造无效）
TRUST_PROXY=1
# 模型 Key 与墨墨 Token 推荐在网站「设置」里填；也可以写在这里兜底
# DEEPSEEK_API_KEY=
# MARKJI_TOKEN=
ENV
fi
chown root:"$APP_USER" "$ENV_DIR/readflow.env"
chmod 640 "$ENV_DIR/readflow.env"
ok "环境变量：$ENV_DIR/readflow.env"

# ---------- 6. systemd 服务 ----------
install -m 644 "$HERE/readflow.service" /etc/systemd/system/readflow.service
if pidof systemd >/dev/null 2>&1 || [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable readflow >/dev/null 2>&1
  ok "systemd 服务已安装（首次发布后自动启动）"
else
  warn "当前环境没有 systemd（容器里正常），跳过服务注册"
fi

# ---------- 7. Nginx ----------
server_name="${DOMAIN:-_}"
sed "s/__SERVER_NAME__/$server_name/g" "$HERE/nginx.conf.template" > /etc/nginx/conf.d/readflow.conf
# Ubuntu 自带的 default 站点占着 80 端口的默认 server，删掉（只是软链接）
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
if pidof systemd >/dev/null 2>&1 || [ -d /run/systemd/system ]; then
  systemctl enable --now nginx >/dev/null 2>&1
  systemctl reload nginx
else
  (pgrep -x nginx >/dev/null && nginx -s reload) || nginx
fi
ok "Nginx 反代：${DOMAIN:-任意域名 / IP} :80 → 127.0.0.1:3000"

# ---------- 8. 每日备份 ----------
install -m 755 "$HERE/backup.sh" /usr/local/bin/readflow-backup
cat > /etc/cron.d/readflow-backup <<CRON
# 每天 03:30 备份数据库，保留最近 14 份（/var/lib/readflow/backups）
30 3 * * * $APP_USER /usr/local/bin/readflow-backup >> $DATA_DIR/backups/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/readflow-backup
ok "每日 03:30 自动备份数据库"

echo
ok "服务器初始化完成。接下来在你的 Mac 上运行："
echo "    bash deploy/deploy.sh init-data   # 首次：上传词典 + 当前数据库"
echo "    bash deploy/deploy.sh             # 发布代码并启动"
echo
warn "别忘了在云服务器控制台的「安全组 / 防火墙」里放行 80、443 端口"
