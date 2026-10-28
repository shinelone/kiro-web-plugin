#!/bin/bash
# 后台启动 Kiro 问答后端，并把进程名设为易识别的名字，
# 方便在 Mac 活动监视器 / ps / top 里一眼定位。
#
# 用法：
#   ./start.sh              # 后台启动，默认端口 8787
#   PORT=9000 ./start.sh    # 自定义端口
#   FOREGROUND=1 ./start.sh # 前台运行（调试用）
#
# 进程名可用 PROC_NAME 覆盖（默认 kiro-qa-server）。
# 日志写入 server.log，进程号写入 server.pid（供 stop.sh 使用）。

cd "$(dirname "$0")" || exit 1

PROC_NAME="${PROC_NAME:-kiro-qa-server}"
export PROC_NAME

LOG_FILE="$PWD/server.log"
PID_FILE="$PWD/server.pid"

# 若已在运行则不重复启动
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "后端已在运行 (PID $(cat "$PID_FILE"))。如需重启，请先执行 ./stop.sh"
  exit 0
fi

# 前台模式（调试）
if [ -n "$FOREGROUND" ]; then
  exec -a "$PROC_NAME" node server.js
fi

# 后台模式：nohup 脱离终端，输出重定向到日志，记录 PID
nohup bash -c 'exec -a "$0" node server.js' "$PROC_NAME" >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

# 简单等待并确认启动成功
sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "后端已在后台启动。"
  echo "  PID:    $PID"
  echo "  进程名: $PROC_NAME"
  echo "  日志:   $LOG_FILE"
  echo "  停止:   ./stop.sh"
else
  echo "启动失败，请查看日志：$LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
