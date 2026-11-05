#!/bin/bash
# 双击我：把 ReadFlow 装成常驻服务（登录后自动启动、崩溃自动重启）
# 只需要装一次；之后开机关机都不用手动启动。

cd "$(dirname "$0")" || exit 1

echo "== 安装 ReadFlow 常驻服务 =="
echo

bash scripts/service.sh install
status=$?

echo
if [ $status -eq 0 ]; then
  echo "完成。以后直接访问 http://localhost:3000"
  echo "查看状态：bash scripts/service.sh status    看日志：bash scripts/service.sh logs"
else
  echo "安装未完成，请把上面的报错发给开发者。"
fi
echo
printf '按回车关闭此窗口…'
read -r _
exit $status
