#!/bin/bash
# 注册 Native Messaging 启动器，让插件可以一键/自动启动本地后端。
#
# 用法：
#   ./install.sh <扩展ID>            # 扩展 ID 在插件「设置」页或 chrome://extensions 中可见
#   ./install.sh <扩展ID> --uninstall
#
# 会为本机已安装的 Chrome / Chrome Beta / Chromium / Edge / Brave 写入宿主清单。

set -e
cd "$(dirname "$0")"
HOST_DIR="$PWD"
HOST_NAME="com.kiro.web_plugin"

EXT_ID="$1"
if [ -z "$EXT_ID" ] || ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "用法: ./install.sh <扩展ID> [--uninstall]"
  echo "  扩展 ID 是 32 位 a-p 小写字母，可在插件设置页或 chrome://extensions 中复制。"
  exit 1
fi

BASE="$HOME/Library/Application Support"
TARGETS=(
  "$BASE/Google/Chrome/NativeMessagingHosts"
  "$BASE/Google/Chrome Beta/NativeMessagingHosts"
  "$BASE/Chromium/NativeMessagingHosts"
  "$BASE/Microsoft Edge/NativeMessagingHosts"
  "$BASE/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)

if [ "$2" = "--uninstall" ]; then
  for t in "${TARGETS[@]}"; do
    rm -f "$t/$HOST_NAME.json" && true
  done
  rm -f "$HOST_DIR/run.sh"
  echo "已卸载 Native Messaging 启动器"
  exit 0
fi

# ----- 解析 node / kiro-cli 的绝对路径（Chrome 启动宿主时 PATH 很精简）-----
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ 未找到 node，请先安装 Node.js >= 18"
  exit 1
fi
KIRO_BIN_PATH="${KIRO_BIN:-$(command -v kiro-cli || true)}"
if [ -z "$KIRO_BIN_PATH" ]; then
  echo "✗ 未找到 kiro-cli，请先安装，或用 KIRO_BIN=/path/to/kiro-cli ./install.sh <扩展ID>"
  exit 1
fi

EXTRA_PATH="$(dirname "$NODE_BIN"):$(dirname "$KIRO_BIN_PATH")"

# ----- 生成包装脚本 run.sh -----
cat >"$HOST_DIR/run.sh" <<EOF
#!/bin/bash
# 由 install.sh 生成，请勿手动修改。
export PATH="$EXTRA_PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:\$PATH"
export KIRO_BIN="$KIRO_BIN_PATH"
exec "$NODE_BIN" "$HOST_DIR/host.js"
EOF
chmod +x "$HOST_DIR/run.sh" "$HOST_DIR/host.js" "$HOST_DIR/../start.sh" "$HOST_DIR/../stop.sh"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Kiro 页面问答：启动/停止本地后端",
  "path": "$HOST_DIR/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

INSTALLED=0
for t in "${TARGETS[@]}"; do
  # 只给已安装的浏览器写（其配置目录的上一级存在）
  if [ -d "$(dirname "$t")" ]; then
    mkdir -p "$t"
    printf '%s\n' "$MANIFEST" >"$t/$HOST_NAME.json"
    echo "✓ 已写入 $t/$HOST_NAME.json"
    INSTALLED=1
  fi
done

if [ "$INSTALLED" = 0 ]; then
  echo "✗ 未检测到受支持的浏览器配置目录"
  exit 1
fi

echo
echo "完成。node: $NODE_BIN   kiro-cli: $KIRO_BIN_PATH"
echo "回到插件侧边栏，点击状态胶囊即可检测/启动后端。"
