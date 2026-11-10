#!/usr/bin/env bash
# ReadFlow 一键部署（在你的 Mac 上、项目根目录运行）
#
# 先复制配置：cp deploy/deploy.conf.example deploy/deploy.conf，填上服务器地址。
#
#   bash deploy/deploy.sh setup         # 首次：初始化服务器（装 Node / Nginx / 服务 / 备份）
#   bash deploy/deploy.sh init-data     # 首次：上传词典 + 本机数据库快照（服务器已有数据库时拒绝覆盖）
#   bash deploy/deploy.sh               # 发布：把当前提交的代码部署上去（= release）
#   bash deploy/deploy.sh status        # 服务状态
#   bash deploy/deploy.sh logs          # 跟踪服务日志（Ctrl+C 退出）
#   bash deploy/deploy.sh rollback      # 回滚到上一个版本
#   bash deploy/deploy.sh backup        # 立刻备份一次，并把最新备份下载到 backups/
#
# 发布的是 git 里**已提交**的代码（git archive HEAD），未提交的改动不会带上去。
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
DOMAIN="${DOMAIN:-}"
# 额外的 ssh 参数（可选），例如 SSH_OPTS="-o ConnectTimeout=10"
read -r -a EXTRA_OPTS <<< "${SSH_OPTS:-}"
[ -n "${SSH_KEY:-}" ] && EXTRA_OPTS+=(-i "$SSH_KEY")
SSH=(ssh -p "$SSH_PORT" -o ServerAliveInterval=30 ${EXTRA_OPTS[@]+"${EXTRA_OPTS[@]}"} "$SERVER")
RSYNC_SSH="ssh -p $SSH_PORT ${SSH_OPTS:-}${SSH_KEY:+ -i $SSH_KEY}"

cmd="${1:-release}"

case "$cmd" in
  setup)
    info "上传初始化脚本到 $SERVER …"
    rsync -az -e "$RSYNC_SSH" "$ROOT/deploy/" "$SERVER:/root/readflow-deploy/"
    "${SSH[@]}" "bash /root/readflow-deploy/server-setup.sh $DOMAIN"
    ;;

  init-data)
    # 词典：94MB，服务器上没有才传
    [ -f "$ROOT/data/dict/ecdict.db" ] || die "本机没有 data/dict/ecdict.db，先运行 npm run import:ecdict"
    if "${SSH[@]}" "test -f /var/lib/readflow/data/dict/ecdict.db"; then
      ok "服务器已有词典，跳过"
    else
      info "上传词典（约 94MB）…"
      rsync -az --progress -e "$RSYNC_SSH" "$ROOT/data/dict/ecdict.db" "$SERVER:/var/lib/readflow/data/dict/ecdict.db"
    fi
    # 数据库：服务器上已有就绝不覆盖（那上面可能已经有别人的新数据）
    if "${SSH[@]}" "test -f /var/lib/readflow/data/readflow.db"; then
      warn "服务器已有数据库，不覆盖。真要用本机数据替换，请先在服务器上手动备份并删除它"
    elif [ -f "$ROOT/data/readflow.db" ]; then
      snap="$(mktemp -t readflow-snapshot).db"
      sqlite3 "$ROOT/data/readflow.db" ".backup '$snap'"   # 在线快照：本机服务开着也安全
      info "上传数据库快照（$(du -h "$snap" | cut -f1)）…"
      rsync -az -e "$RSYNC_SSH" "$snap" "$SERVER:/var/lib/readflow/data/readflow.db"
      rm -f "$snap"
    else
      warn "本机没有数据库，服务器上首次打开网站时会走 /setup 建号"
    fi
    "${SSH[@]}" "chown -R readflow:readflow /var/lib/readflow/data"
    ok "数据就绪"
    ;;

  release)
    cd "$ROOT"
    if [ -n "$(git status --porcelain)" ]; then
      warn "有未提交的改动，它们不会被部署（发布的是 HEAD：$(git log -1 --format='%h %s')）"
    fi
    REL="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
    info "上传代码 $REL …"
    git archive --format=tar.gz HEAD \
      | "${SSH[@]}" "mkdir -p /opt/readflow/releases/$REL && tar -xzf - -C /opt/readflow/releases/$REL"
    "${SSH[@]}" "bash /opt/readflow/releases/$REL/deploy/remote-release.sh $REL"
    ;;

  status)
    "${SSH[@]}" "systemctl --no-pager status readflow | head -15; echo; echo 当前版本: \$(basename \$(readlink -f /opt/readflow/current)); ls -1t /var/lib/readflow/backups/*.gz 2>/dev/null | head -1 | sed 's/^/最近备份: /'"
    ;;

  logs)
    "${SSH[@]}" "journalctl -u readflow -f -n 50"
    ;;

  rollback)
    "${SSH[@]}" 'set -e
      cur=$(readlink -f /opt/readflow/current)
      prev=$(ls -1dt /opt/readflow/releases/*/ | sed "s:/\$::" | grep -vx "$cur" | head -1)
      [ -n "$prev" ] || { echo "没有可回滚的版本"; exit 1; }
      ln -sfn "$prev" /opt/readflow/current.tmp && mv -T /opt/readflow/current.tmp /opt/readflow/current
      systemctl restart readflow
      echo "已回滚到 $(basename "$prev")"'
    ;;

  backup)
    "${SSH[@]}" "runuser -u readflow -- /usr/local/bin/readflow-backup"
    latest="$("${SSH[@]}" "ls -1t /var/lib/readflow/backups/readflow-*.db.gz | head -1")"
    mkdir -p "$ROOT/backups"
    rsync -az -e "$RSYNC_SSH" "$SERVER:$latest" "$ROOT/backups/"
    ok "已下载到 backups/$(basename "$latest")"
    ;;

  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
