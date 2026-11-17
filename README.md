# Kiro 页面问答 · Chrome 插件

> 在浏览器侧边栏里，用本机的 [Kiro CLI](https://kiro.dev) 对**当前网页 / 在线 PDF** 进行流式问答，回答逐字返回，支持多轮追问与长页面按需阅读。

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
| 💬 **多轮上下文记忆** | 同一会话内连续追问，Kiro 记得之前聊过的内容。会话保留在常驻的 kiro-cli 进程里，追问约 1～2 秒开始输出。 |
| 📄 **网页正文抓取** | 自动提取当前页面正文（上限约 20 万字）并作为上下文注入。 |
| 📚 **长页面按需阅读** | 正文转成 Markdown（保留标题、列表、表格、代码块、链接）。长页面存成文件，Kiro 用读文件和 grep 按需读取相关段落。 |
| 🧾 **在线 PDF 支持** | 内置 pdf.js，离线可用，`.pdf` 链接也能走同样的问答流程。 |
| 🧵 **追问与关系图** | 在 Kiro 的回答里选中一段文字，点浮出的「追问」（或右键「追问这段内容」），带着引用继续问；被追问的原文会高亮，点高亮能跳到追问。顶栏的关系图按钮打开「追问关系」：每次提问和它引出的追问画成一棵树，分支可折叠，当前正在看的那一轮会高亮，点节点跳到对应消息。侧边栏里是右侧抽屉，全屏页里是常驻右栏。 |
| 🖱 **右键追问网页内容** | 网页上选中文字后右键「用 Kiro 追问选中内容」，打开侧边栏并把这段文字放进引用条，输入问题即可。 |
| 🖼 **图片提问** | 在输入框里粘贴图片、把图片拖进侧边栏，或点输入框下方的图片按钮选择文件；侧边栏里还能一键截取当前网页的可见区域。每次最多 4 张，自动压缩到长边 2048px 以内，和文字、页面内容一起发给 Kiro，之后的追问也能继续问这些图。对话记录里只保存缩略图。 |
| 🗂️ **会话按标签页隔离** | 每个标签页独立对话，切走切回不丢失，关闭标签页自动清空。 |
| 🎨 **Markdown 渲染** | 代码块、列表、表格等完整渲染，代码块支持一键复制。 |
| 🔀 **模型切换** | 输入框下方的下拉框直接切换模型，列表来自 `kiro-cli chat --list-models`，显示 credits 倍率。 |
| 🧑‍💼 **自定义 Agent** | 在设置页编辑 agent 的描述、模型、提示词和工具；问答时在输入框下方选择 agent。预置网页阅读专用的 `web-reader`。 |
| 🖥️ **全屏模式** | 侧边栏右上角一键展开到新标签页，正文居中加宽；全屏页里还可以切到浏览器全屏。对话与侧边栏实时同步。 |
| 🧠 **思考与工具调用可见** | 回答上方实时显示模型的思考过程和每次工具调用（名称、目标、状态、输入输出），并显示计时，等待时不再是空白。 |
| ⚡ **自动启动后端** | 后端离线时，插件通过 Native Messaging 启动器自动执行 `start.sh`；也可在设置页一键启动/停止/重启。 |

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
│  (server/server.js)      │  stdin/stdout JSON-RPC
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  kiro-cli acp（常驻）      │
│  多个会话共用一个进程       │
└─────────────────────────┘
```

- 插件用 `fetch` + `ReadableStream` 手动解析 SSE（`EventSource` 不支持 POST）。
- 后端启动时拉起一个常驻的 `kiro-cli acp` 进程（Agent Client Protocol），并预热一个空会话。提问不再每次启动 kiro-cli：追问约 1～2 秒开始输出，以前每次要多花约 5 秒启动、1.5 秒退出。
- 后端把 ACP 的 `session/update` 转成 SSE 事件推给插件：`agent_message_chunk` 转成 `chunk`（回答文本），`agent_thought_chunk` 转成 `thought`（思考过程），`tool_call` / `tool_call_update` 转成 `tool`（工具调用）。
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

### 2.5（可选）安装本地启动器，让插件自动启动后端

浏览器扩展无法直接执行本地命令，需要注册一个 Native Messaging 启动器。扩展 ID 在设置页「本地启动器」一栏可直接复制完整命令：

```bash
cd server/native-host
./install.sh <扩展ID>              # 为本机已安装的 Chrome / Chromium / Edge / Brave 注册
./install.sh <扩展ID> --uninstall  # 卸载
```

安装后：

- 打开侧边栏时如果后端离线，插件会自动执行 `server/start.sh` 并等待就绪（设置页可关闭「后端离线时自动启动」）
- 提问时若后端中途掉线，会先自动拉起再重试一次
- 设置页可以一键启动 / 停止 / 重启后端，并查看脚本输出

> 启动器只接受 `start` / `stop` / `restart` / `status` 四个固定动作，不会执行消息里的任意命令；只有清单里登记的扩展 ID 能调用它。`install.sh` 会把当前 `node` 和 `kiro-cli` 的绝对路径写进 `run.sh`，因为浏览器拉起启动器时 PATH 很精简。换了 node 版本或扩展 ID 后需要重新执行。

### 3. 开始提问

- 在输入框提问，`Enter` 发送，`Shift+Enter` 换行
- 回答逐字流式显示，支持 Markdown
- 右上角 ⚙ 进入设置页，可配置后端地址 / 模型 / agent / 自动启动，并管理 agent
- 输入框下方可切换 agent 和模型。切换模型从下一次提问起生效；切换 agent 会开启新会话
- 右上角 ⤢ 把当前对话展开到新标签页（全屏页）：
  - 全屏页始终针对打开它的那个标签页，切换标签页不影响它
  - 与侧边栏共用同一份对话，一边提问另一边会同步显示
  - 全屏页右上角 ⛶ 切换浏览器全屏，`Esc` 退出
  - 源标签页关闭后，全屏页还能继续聊，但不再带页面内容，关掉全屏页对话就没了
- 状态圆点：🟢 后端在线 · 🟠 启动中 · 🔴 后端离线（离线时点它会尝试启动）
- 「停止」按钮可中止当前回答

---

## ⚙️ 配置

### 后端环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `8787` |
| `KIRO_BIN` | kiro-cli 可执行文件路径 | `kiro-cli` |
| `ALLOW_ORIGIN` | 只允许这个来源访问，例如 `chrome-extension://<扩展ID>`。不设时允许任意浏览器扩展，拒绝普通网页 | 空 |
| `PROC_NAME` | 进程名（活动监视器显示） | `kiro-qa-server` |

示例：

```bash
PORT=9000 KIRO_BIN=/Users/you/.local/bin/kiro-cli ./start.sh
```

### 插件设置页（⚙）

- **后端地址**：默认 `http://127.0.0.1:8787`，与后端端口保持一致
- **模型**：下拉选择，列表从后端 `/models` 获取；与侧边栏的下拉框同步。选「跟随 Agent」时不传 `--model`，使用 agent 自己配置的模型
- **默认 Agent**：问答时使用的 agent，与侧边栏的下拉框同步
- **后端离线时自动启动**：默认开启，需先安装本地启动器
- **Agent 管理**：新建、编辑、删除插件自己的 agent（见下文）
- **本地启动器**：显示安装状态和安装命令，可一键启动 / 停止 / 重启后端

### 自定义 Agent

插件的 agent 保存在 `server/workspace/.kiro/agents/<名字>.json`。后端以 `server/workspace/` 为工作目录启动 kiro-cli，所以这些 agent 只对插件生效，不会影响你在终端里用的 agent。全局（`~/.kiro/agents/`）和内置 agent（`plan`、`spec` 等）也能在问答时选用，但只读。

设置页可编辑的字段：

| 字段 | 说明 |
| --- | --- |
| 名字 | 小写字母、数字和 `-`，创建后不能改 |
| 描述 | 一句话说明 |
| 模型 | 这个 agent 的默认模型；侧边栏明确选了模型时以侧边栏为准 |
| 提示词 | 系统提示词 |
| 工具 | `web`（联网搜索、抓取网页）、`read`（读文件）、`write`（写文件）、`shell`（执行命令） |

- 首次启动时会预置 `web-reader`：中文网页阅读提示词，开启 `web` 工具。
- 保存前后端会用 `kiro-cli agent validate` 校验，失败不会覆盖原文件。手动加在 JSON 里的其它字段（如 `mcpServers`）保存时会保留。
- 保存、删除 agent 后，后端会重启常驻的 kiro-cli 进程让改动生效（有回答进行中时等它结束）。之后的第一个问题要多等几秒，已有对话会自动恢复。
- kiro-cli V3 引擎会读取 agent 的 `tools` 和 `model`，但不会使用 `prompt`。插件 agent 的提示词由后端加在新会话第一条消息的前面。全局 agent 的提示词不会生效。
- 工具调用由后端自动同意，不会询问确认（与以前的 `--trust-all-tools` 一样）。`write` 和 `shell` 风险较高：网页内容里的指令可能诱导模型去执行，设置页勾选时会给出提示。
- 会话与 agent 绑定。切换 agent 会开启新会话；在别的标签页换了 agent，回到旧对话再提问时也会自动开启新会话。

---

## 🔌 后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查，返回 `{ ok, kiroBin }` |
| `GET` | `/models` | 模型列表 `{ models: [{ id, name, description, rate, contextWindow }], defaultModel }`，缓存 5 分钟，`?refresh=1` 强制刷新 |
| `GET` | `/agents` | agent 列表 `{ agents: [{ name, description, prompt, tools, model, source, editable }], tools }`，`source` 为 `plugin` / `global` / `builtin` |
| `POST` | `/agents` | 新建插件 agent，请求体 `{ name, description, prompt, model, tools }` |
| `PUT` | `/agents/:name` | 修改插件 agent |
| `DELETE` | `/agents/:name` | 删除插件 agent |
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
- 带合法 `sessionId`（`sess_...`）：续聊该会话。会话不在常驻进程里时（后端重启过、空闲超过 30 分钟被关闭）用 ACP 的 `session/load` 从磁盘恢复

SSE 事件：

| 事件 | 数据 | 说明 |
| --- | --- | --- |
| `start` | `{ engine }` | kiro-cli 已启动 |
| `session` | `{ sessionId }` | 本次会话 id |
| `status` | `{ phase: "turn_start" }` | 模型开始处理 |
| `thought` | `{ text }` | 思考过程增量 |
| `tool` | `{ id, status, title, kind, summary, input, output }` | 工具调用，同一 `id` 会多次发送；`status` 为 `pending` / `in_progress` / `completed` / `failed`。`input` 截断到 600 字，`output` 截断到 2000 字 |
| `chunk` | `{ text }` | 回答文本增量 |
| `done` | `{ status, stopReason, finalText }` | 回答完成 |
| `error` | `{ message, stderr }` | 出错 |
| `end` | `{}` | 流结束 |

---

## 🧠 工作原理细节

### 多轮上下文记忆

- 同一会话内 Kiro 记得之前聊过的内容。会话保留在常驻的 kiro-cli 进程里，追问约 1～2 秒开始输出。
- **页面全文只在该会话首次涉及某页面时注入一次**，之后的追问不再重复塞全文（省 token、避免撑爆上下文）。
- 同一标签页内导航到其它网址时对话保留；需要重来时点右上角清空按钮手动开启新会话。
- 会话内容按标签页隔离并持久化（`chrome.storage.session`），切走切回不丢失；关闭标签页或浏览器时清空。

### 页面抓取与长页面

- 抓取在页面的真实 DOM 上进行，输出 Markdown：保留标题层级、列表、表格、代码块（含语言）、引用、链接地址和 KaTeX/MathML 公式源码；跳过隐藏元素、导航、侧栏、页脚、固定定位的横幅。会进入 open shadow root 和同源 iframe；未选中的标签页（tab）和折叠的 `<details>` 内容也会保留。
- 正文容器按文字量挑选：在 `article`、`main` 等候选里选包含全页一半以上非链接文字、且最贴近正文的那一层；没有语义标签时按段落打分。
- 同站链接写成 `/路径`，链接密集的导航区只保留文字和外站链接；图片只保留 alt 文字。这些都是为了省 token。
- **飞书 / Lark 云文档**（新版文档，含知识库里的文档）只渲染屏幕附近的内容，单独处理：打开侧边栏时只读屏幕附近的块（不打扰阅读）；第一次提问或打开预览时自动从头滚到尾，逐屏收集文档块，再按层级拼成 Markdown（标题、列表、表格、代码块、引用、高亮块、链接），滚完恢复原来的位置。长文档需要十几秒，期间页面会自动滚动。内嵌的电子表格、多维表格、画板读不到内容，只标注占位。
- 抓取正文上限约 20 万字。
- 正文 ≤ 3 万字：一次性注入全文。
- 正文更长：后端把 Markdown 写到 `server/workspace/pages/<hash>.md`，消息里只放标题、网址、带行号的目录和开头摘录，Kiro 用读文件和 grep 工具按需读取。追问时 Kiro 也能回去重读原文。页面文件保留 3 天。
- 读文件通过 ACP 的 `fs/read_text_file` 交给后端执行，范围在设置页的「文件读取权限」里选：**只读页面文件**（默认，`server/workspace/pages/`）、**页面文件和指定目录**、**本机所有文件**。对所有 agent 生效，配置保存在 `server/workspace/.plugin-config.json`。放宽后网页里的提示注入可能诱导 Kiro 读取本机文件，用完建议改回默认。列目录和搜索由 kiro-cli 自己执行，不受这里限制。
- 插件 agent 没有勾选「读文件」工具时，长页面退回内联，最多附上前 12 万字。预置的 `web-reader` 默认带「读文件」工具。

### 思考过程与工具调用

- 发出问题后立刻显示状态行和计时：等待 Kiro 响应 → 思考中 → 正在调用某工具 → 正在回答。
- 思考过程实时展开显示；开始调用工具或开始回答后自动收起，点开可再看。
- 每次工具调用一行：工具名、目标（URL / 路径 / 命令）、状态。点开可看输入和输出。
- 回答结束后，角色行显示用时和工具调用次数。思考和工具记录随对话一起保存，切换标签页、打开全屏页都能看到。
- 回答文本按帧合并渲染（每帧最多重渲染一次 Markdown），长回答流式输出时不卡。

### PDF 支持

- 在线 PDF（URL 以 `.pdf` 结尾）用内置 pdf.js 提取文字，走和网页一样的问答流程。
- 每页开头有「[第 N 页]」标记，回答可以引用页码；长 PDF 的消息里附带页码到行号的对照。
- 按坐标还原阅读顺序，识别双栏排版；字号明显大于正文的行、以及「3.1 xxx」「第二章」「Abstract」这类短行识别为标题；去掉每页重复的页眉页脚和页码。
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
