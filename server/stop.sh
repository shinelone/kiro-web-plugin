#!/bin/bash
# 停止后台运行的 Kiro 问答后端（由 start.sh 启动）。

cd "$(dirname "$0")" || exit 1

PID_FILE="$PWD/server.pid"
PROC_NAME="${PROC_NAME:-kiro-qa-server}"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "已停止后端 (PID $PID)"
  else
    echo "PID 文件存在但进程未运行，清理 PID 文件"
  fi
  rm -f "$PID_FILE"
else
  # 没有 PID 文件时，按进程名兜底查找
  PIDS="$(pgrep -f "$PROC_NAME")"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill
    echo "已按进程名停止：$PIDS"
  else
    echo "未找到正在运行的后端"
  fi
fi
