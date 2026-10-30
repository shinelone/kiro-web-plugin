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

# ----- 颜色（终端支持时才上色）-----
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; RESET=''
fi

# ----- 前置检查：Node.js -----
if ! command -v node >/dev/null 2>&1; then
  echo "${RED}✗ 未检测到 Node.js。${RESET}"
  echo "  本后端需要 Node.js >= 18。"
  echo "  安装指引：${BOLD}https://nodejs.org/${RESET}  （macOS 也可用 Homebrew：brew install node）"
  exit 1
fi

# ----- 前置检查：kiro-cli -----
# 允许通过 KIRO_BIN 指定自定义路径；默认用 PATH 里的 kiro-cli。
KIRO_BIN="${KIRO_BIN:-kiro-cli}"
if ! command -v "$KIRO_BIN" >/dev/null 2>&1; then
  echo "${RED}✗ 未检测到 kiro-cli（期望命令：${BOLD}$KIRO_BIN${RESET}${RED}）。${RESET}"
  echo
  echo "  本后端依赖本机已安装并登录的 kiro-cli。请先完成："
  echo "    1. 安装 Kiro CLI：     ${BOLD}https://kiro.dev${RESET}"
  echo "    2. 登录并验证可用：    ${BOLD}kiro-cli --version${RESET}  然后  ${BOLD}kiro-cli chat \"你好\"${RESET}"
  echo
  echo "  若已安装但不在 PATH 中，可指定可执行文件路径后再启动，例如："
  echo "    ${BOLD}KIRO_BIN=/path/to/kiro-cli ./start.sh${RESET}"
  exit 1
fi
export KIRO_BIN

PROC_NAME="${PROC_NAME:-kiro-qa-server}"
export PROC_NAME

LOG_FILE="$PWD/server.log"
PID_FILE="$PWD/server.pid"

# 若已在运行则不重复启动
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "${YELLOW}后端已在运行 (PID $(cat "$PID_FILE"))。${RESET}如需重启，请先执行 ./stop.sh"
  exit 0
fi

# 前台模式（调试）
if [ -n "$FOREGROUND" ]; then
  echo "${GREEN}✓ 环境检查通过${RESET}（node $(node -v)，kiro-cli: $KIRO_BIN）"
  exec -a "$PROC_NAME" node server.js
fi

# 后台模式：nohup 脱离终端，输出重定向到日志，记录 PID
nohup bash -c 'exec -a "$0" node server.js' "$PROC_NAME" >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

# 简单等待并确认启动成功
sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "${GREEN}✓ 后端已在后台启动。${RESET}"
  echo "  PID:      $PID"
  echo "  进程名:   $PROC_NAME"
  echo "  kiro-cli: $KIRO_BIN"
  echo "  日志:     $LOG_FILE"
  echo "  健康检查: curl http://127.0.0.1:${PORT:-8787}/health"
  echo "  停止:     ./stop.sh"
else
  echo "${RED}✗ 启动失败，请查看日志：$LOG_FILE${RESET}"
  rm -f "$PID_FILE"
  exit 1
fi
