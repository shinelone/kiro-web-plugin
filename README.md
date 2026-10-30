# Kiro 页面问答 · Chrome 插件

> 在浏览器侧边栏里，用本机的 [Kiro CLI](https://kiro.dev) 对**当前网页 / 在线 PDF** 进行流式问答，回答逐字返回，支持多轮追问与长页面分块阅读。

<p>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%3E%3D18-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="Dependencies" src="https://img.shields.io/badge/server%20deps-0-brightgreen">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

一个 Chrome 浏览器插件（Manifest V3 · 侧边栏界面），通过一个**零依赖的本地 Node 后端**调用本机的 `kiro-cli`，在浏览器里对 Kiro 进行流式问答。页面正文、在线 PDF 文本会被自动抓取并喂给 Kiro，让你可以直接「问这一页」。

---

## ✨ 功能亮点

| 功能 | 说明 |
| --- | --- |
| 🌊 **流式回答** | 基于 SSE，回答逐字显示，无需等待整段生成。 |
| 💬 **多轮上下文记忆** | 同一会话内连续追问，Kiro 记得之前聊过的内容（基于 `kiro-cli --resume-id`）。 |
| 📄 **网页正文抓取** | 自动提取当前页面正文（上限约 20 万字）并作为上下文注入。 |
| 📚 **长页面分块阅读** | 超长正文按段落切块逐块喂给 Kiro，侧边栏显示阅读进度。 |
| 🧾 **在线 PDF 支持** | 内置 pdf.js，离线可用，`.pdf` 链接也能走同样的问答流程。 |
| 🖱️ **右键解释选中内容** | 选中文字右键「用 Kiro 解释选中内容」，自动打开侧边栏提问。 |
| 🗂️ **会话按标签页隔离** | 每个标签页独立对话，切走切回不丢失，关闭标签页自动清空。 |
| 🎨 **Markdown 渲染** | 代码块、列表、表格等完整渲染，代码块支持一键复制。 |

---

## 🧱 架构

```
┌─────────────────────────┐
│  Chrome 插件 (side panel) │
│  · 抓取页面正文 / PDF 文本 │
│  · fetch + ReadableStream │  POST /ask (SSE 流式)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  本地 Node 后端           │
│  (server/server.js)      │  spawn
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  kiro-cli chat           │
│  --output-format         │
│      stream-json         │
└─────────────────────────┘
```

- 插件用 `fetch` + `ReadableStream` 手动解析 SSE（`EventSource` 不支持 POST）。
- 后端把 `kiro-cli` 的 `stream-json` 输出里 `agent_message_chunk` 的文本增量转成 SSE `chunk` 事件推给插件。
- 后端**零第三方依赖**，仅使用 Node 内置模块。

---

## 📋 前置条件

- **已安装并登录的 [`kiro-cli`](https://kiro.dev)** —— 验证：`kiro-cli --version`，再试 `kiro-cli chat "你好"` 确认可正常对话。
- **Node.js ≥ 18**
- **Chrome / 基于 Chromium 的浏览器**（支持 Manifest V3 与 Side Panel）

---

## 🚀 快速开始

### 1. 启动本地后端

```bash
cd server
./start.sh          # 推荐：后台运行，进程名显示为 kiro-qa-server，方便定位
```

看到 `后端已在后台启动。PID …` 即成功。验证：

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"kiroBin":"kiro-cli"}
```

其它启动方式：

```bash
./stop.sh                     # 停止后台服务
npm start                     # 同 ./start.sh（后台）
FOREGROUND=1 ./start.sh       # 前台运行（调试用）
node server.js                # 前台，进程名显示为 node
```

> `./start.sh` 以后台方式常驻，脱离终端；日志写入 `server.log`，进程号写入 `server.pid`，重复执行不会重复启动。进程名默认 `kiro-qa-server`，在「活动监视器」/ `ps` / `top` 里一眼可辨。

### 2. 加载 Chrome 插件

1. 打开 `chrome://extensions`
2. 右上角开启「**开发者模式**」
3. 点「**加载已解压的扩展程序**」，选择本仓库的 `extension/` 目录
4. 点击工具栏上的插件图标，打开侧边栏

### 3. 开始提问

- 在输入框提问，`Enter` 发送，`Shift+Enter` 换行
- 回答逐字流式显示，支持 Markdown
- 右上角 ⚙ 进入设置页，可配置后端地址 / 模型 / agent
- 状态圆点：🟢 后端在线 · 🔴 后端离线（点它可重新检测）
- 「停止」按钮可中止当前回答

---

## ⚙️ 配置

### 后端环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `8787` |
| `KIRO_BIN` | kiro-cli 可执行文件路径 | `kiro-cli` |
| `ALLOW_ORIGIN` | CORS 允许来源 | `*` |
| `PROC_NAME` | 进程名（活动监视器显示） | `kiro-qa-server` |

示例：

```bash
PORT=9000 KIRO_BIN=/Users/you/.local/bin/kiro-cli ./start.sh
```

### 插件设置页（⚙）

- **后端地址**：默认 `http://127.0.0.1:8787`，与后端端口保持一致
- **model**：对应 `kiro-cli --model`，可用 `kiro-cli chat --list-models` 查看
- **agent**：对应 `kiro-cli --agent`

---

## 🔌 后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查，返回 `{ ok, kiroBin }` |
| `POST` | `/ask` | 流式问答，返回 SSE 流 |

`POST /ask` 请求体：

```jsonc
{
  "prompt": "这篇文章讲了什么？",  // 必填
  "model": "可选",
  "agent": "可选",
  "sessionId": "sess_..."          // 可选：续聊已有会话
}
```

- 不带 `sessionId`：开启新会话，后端通过 SSE `event: session` 回传本次 `sessionId`
- 带合法 `sessionId`（`sess_...`）：用 `kiro-cli --resume-id` 续聊，带着历史记忆回答

SSE 事件：`start` · `session` · `chunk`（文本增量）· `done` · `error` · `end`

---

## 🧠 工作原理细节

### 多轮上下文记忆

- 同一会话内 Kiro 记得之前聊过的内容（基于 `kiro-cli --resume-id`）。
- **页面全文只在该会话首次涉及某页面时注入一次**，之后的追问不再重复塞全文（省 token、避免撑爆上下文）。
- 同一标签页内导航到其它网址时对话保留；需要重来时点右上角清空按钮手动开启新会话。
- 会话内容按标签页隔离并持久化（`chrome.storage.session`），切走切回不丢失；关闭标签页或浏览器时清空。

### 长页面分块处理

- 抓取正文上限约 20 万字。
- 正文 ≤ 约 1.2 万字：一次性注入全文。
- 正文较长：自动按段落边界切块（每块约 9000 字，最多 12 块），首次注入时逐块喂给 Kiro，最后再发用户问题。侧边栏显示「正在阅读长页面…（N/总块数）」进度。

### PDF 支持

- 在线 PDF（URL 以 `.pdf` 结尾）用内置 pdf.js 提取文字，走和网页一样的分块问答。
- 限制：
  - **扫描版 / 图片型 PDF** 无文字层，提取不到内容（需 OCR，暂不支持）。
  - **本地 `file:///` PDF** 需在扩展详情页开启「允许访问文件网址」。
  - 超大 PDF 默认最多解析前 300 页。

---

## 📁 目录结构

```
kiro-web-plugin/
├── README.md
├── server/                      # 本地后端（零依赖）
│   ├── server.js                # HTTP + SSE，spawn kiro-cli
│   ├── start.sh / stop.sh       # 后台启动 / 停止脚本
│   └── package.json
└── extension/                   # Chrome 插件（Manifest V3）
    ├── manifest.json
    ├── background.js            # 侧边栏开启行为 + 右键菜单
    ├── sidepanel.html/.css/.js  # 主界面 + SSE 流式解析 + Markdown 渲染
    ├── markdown.js              # 轻量安全的 Markdown 渲染器
    ├── extract.js               # 注入页面抓取正文
    ├── pdf-extract.js           # PDF 文本提取（pdf.js）
    ├── options.html/.js         # 设置页
    ├── vendor/pdfjs/            # 打包的 pdf.js
    └── icons/                   # 图标
```

---

## ❓ 常见问题

- **状态点红色 / 请求失败**：确认后端已启动，且设置页里的地址与端口一致。
- **回答为空或报错**：在终端直接运行 `kiro-cli chat "你好"`，确认 CLI 可用且已登录。
- **想换模型**：在设置页填 `model`，或先用 `kiro-cli chat --list-models` 查看可用模型。
- **本地 PDF 读不到**：在 `chrome://extensions` → 本扩展详情 → 开启「允许访问文件网址」。

---

## 🤝 贡献

欢迎 Issue 和 PR。开发时：

- 后端改动后 `./stop.sh && ./start.sh` 重启，`curl /health` 验证。
- 插件改动后在 `chrome://extensions` 点刷新重新加载。

---

## 📄 许可证

[MIT](LICENSE)
