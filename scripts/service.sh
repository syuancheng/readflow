#!/bin/bash
# ReadFlow 本地常驻服务（macOS launchd LaunchAgent）
#
#   bash scripts/service.sh install     # 构建检查 + 安装并启动（登录后自动运行、崩溃自动重启）
#   bash scripts/service.sh restart     # 重启
#   bash scripts/service.sh status      # 查看状态
#   bash scripts/service.sh logs        # 跟踪日志
#   bash scripts/service.sh uninstall   # 卸载（不会删除任何数据）
#   bash scripts/service.sh build       # 只做生产构建
#
# 数据始终在 data/readflow.db，升级/重装/卸载都不会动它。

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.readflow.server"
PORT="${READFLOW_PORT:-3000}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

# launchd 不加载 shell 配置，必须用绝对路径的 node。优先系统 node，其次 PATH 里的。
pick_node() {
  if [ -n "${READFLOW_NODE:-}" ] && [ -x "$READFLOW_NODE" ]; then echo "$READFLOW_NODE"; return; fi
  for c in /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node 2>/dev/null)"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
}

NODE_BIN="$(pick_node)"

info()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

port_pids() { lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null; }

cmd_build() {
  [ -n "$NODE_BIN" ] || die "找不到 node，可用 READFLOW_NODE=/path/to/node 指定"
  info "生产构建（node $("$NODE_BIN" -v)）…"
  ( cd "$PROJECT_DIR" && npm run build ) || die "构建失败，请查看上面的报错"
  ok "构建完成：$PROJECT_DIR/.next"
}

cmd_install() {
  [ -n "$NODE_BIN" ] || die "找不到 node，可用 READFLOW_NODE=/path/to/node 指定"
  [ -f "$PROJECT_DIR/.next/BUILD_ID" ] || die "还没有生产构建，先执行：bash scripts/service.sh build"
  [ -f "$PROJECT_DIR/node_modules/next/dist/bin/next" ] || die "缺少依赖，先在项目里执行 npm install"

  local busy pid cwd
  busy="$(port_pids)"
  if [ -n "$busy" ]; then
    for pid in $busy; do
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
      if [ "$cwd" = "$PROJECT_DIR" ]; then
        info "停止本项目的手动实例（PID $pid）"
        kill "$pid" 2>/dev/null
      else
        die "端口 $PORT 被其他程序占用（PID $pid${cwd:+，目录 $cwd}），请先关掉它再安装"
      fi
    done
    local n
    for n in $(seq 1 20); do
      [ -z "$(port_pids)" ] && break
      sleep 0.3
    done
    [ -z "$(port_pids)" ] || die "端口 $PORT 仍未释放，请手动检查"
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/node_modules/next/dist/bin/next</string>
    <string>start</string>
    <string>-p</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/readflow.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/readflow.err.log</string>
</dict>
</plist>
EOF

  loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl 加载失败：$PLIST"
  ok "已安装：$PLIST"

  local i
  for i in $(seq 1 40); do
    if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
      ok "服务已就绪：http://localhost:$PORT"
      echo "  开机登录后自动启动，崩溃会自动重启。卸载：bash scripts/service.sh uninstall"
      return 0
    fi
    sleep 0.5
  done
  warn "服务已加载但 20 秒内没响应，看日志：bash scripts/service.sh logs"
  return 1
}

cmd_uninstall() {
  if loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; fi
  rm -f "$PLIST"
  ok "已卸载（data/readflow.db 保持不变）"
}

cmd_restart() {
  loaded || die "服务未安装，先执行：bash scripts/service.sh install"
  launchctl kickstart -k "$DOMAIN/$LABEL" || die "重启失败"
  local i
  for i in $(seq 1 40); do
    curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null && { ok "已重启：http://localhost:$PORT"; return 0; }
    sleep 0.5
  done
  warn "重启后未响应，看日志：bash scripts/service.sh logs"
  return 1
}

cmd_status() {
  if loaded; then
    ok "已安装并加载"
    launchctl print "$DOMAIN/$LABEL" | grep -E "state = |pid = |last exit code|program = " | sed 's/^[[:space:]]*/  /'
    local pid; pid="$(port_pids)"
    [ -n "$pid" ] && ok "端口 $PORT 监听中（PID: $(echo "$pid" | tr '\n' ' ')）" || warn "端口 $PORT 没有监听"
    curl -fsS -o /dev/null -w "  HTTP %{http_code}  %{time_total}s\n" "http://localhost:$PORT/" || warn "HTTP 无响应"
  else
    warn "未安装服务"
    [ -n "$(port_pids)" ] && info "但端口 $PORT 上有进程在跑（手动启动的？）"
  fi
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_DIR/readflow.out.log" "$LOG_DIR/readflow.err.log"
  info "日志：$LOG_DIR（Ctrl-C 退出）"
  tail -n 50 -f "$LOG_DIR/readflow.out.log" "$LOG_DIR/readflow.err.log"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  build)     cmd_build ;;
  *)         sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
