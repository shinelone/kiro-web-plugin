# Kiro 流式问答 Chrome 插件

一个 Chrome 浏览器插件（Manifest V3，侧边栏界面），通过一个本地 Node 后端调用本机的 `kiro-cli`，在浏览器里对 Kiro 进行**流式问答**（回答逐字显示）。

## 架构

```
Chrome 插件 (side panel)
   │  POST /ask   (SSE 流式)
   ▼
本地 Node 后端 (server/server.js)
   │  spawn
   ▼
kiro-cli chat --output-format stream-json
```

- 插件用 `fetch` + ReadableStream 手动解析 SSE（`EventSource` 不支持 POST）。
- 后端把 `kiro-cli` 的 `stream-json` 输出里 `agent_message_chunk` 的文本增量转成 SSE `chunk` 事件推给插件。

## 前置条件

- 已安装并可用的 `kiro-cli`（本机已登录）。验证：`kiro-cli --version`
- Node.js >= 18

## 一、启动本地后端

```bash
cd server
./start.sh          # 推荐：后台运行，进程名显示为 kiro-qa-server，方便在活动监视器里定位
./stop.sh           # 停止后台服务
# 或： npm start                 # 同 ./start.sh（后台）
# 或： FOREGROUND=1 ./start.sh   # 前台运行（调试用）
# 或： node server.js            # 前台，进程名显示为 node
```

看到 `后端已在后台启动。PID …` 即成功；启动后可用 `curl http://127.0.0.1:8787/health` 验证。

> - `./start.sh` 以**后台**方式运行，脱离终端常驻；日志写入 `server.log`，进程号写入 `server.pid`。重复执行不会重复启动。
> - 进程名会被设为 `kiro-qa-server`，在 Mac「活动监视器」/ `ps` / `top` 里一眼可辨。可用环境变量 `PROC_NAME` 自定义。
> - 停止用 `./stop.sh`。

可用环境变量：

| 变量         | 说明                              | 默认           |
| ------------ | --------------------------------- | -------------- |
| `PORT`       | 监听端口                          | `8787`         |
| `KIRO_BIN`   | kiro-cli 可执行文件路径            | `kiro-cli`     |
| `ALLOW_ORIGIN` | CORS 允许来源                   | `*`            |
| `PROC_NAME`  | 进程名（活动监视器显示）            | `kiro-qa-server` |

示例：

```bash
PORT=9000 KIRO_BIN=/Users/shinelon/.local/bin/kiro-cli ./start.sh
```

接口：

- `GET  /health` — 健康检查
- `POST /ask` — 请求体 `{ "prompt": "...", "model": "可选", "agent": "可选", "sessionId": "可选" }`，返回 SSE 流
  - 不带 `sessionId`：开启新会话；后端会通过 SSE `event: session` 回传本次的 `sessionId`
  - 带合法 `sessionId`（`sess_...`）：用 `kiro-cli --resume-id` 续聊，Kiro 带着历史记忆回答

## 二、加载 Chrome 插件

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 点击工具栏上的插件图标，打开侧边栏

## 三、使用

- 在侧边栏输入框提问，Enter 发送，Shift+Enter 换行
- 回答会逐字流式显示（支持 Markdown：代码块、列表、表格等）
- 右上角 ⚙ 进入设置页，可配置后端地址 / 模型 / agent
- 状态圆点：绿色=后端在线，红色=后端离线（点它可重新检测）
- 「停止」按钮可中止当前回答

### 多轮上下文记忆

- 回答支持**连续追问**：同一会话内，Kiro 记得之前聊过的内容（基于 `kiro-cli --resume-id`）。
- **页面全文只在该会话首次涉及某页面时注入一次**，之后的追问不再重复塞全文（省 token、避免撑爆上下文）。
- 同一标签页内导航到其它网址时**对话保留**（不自动清空）；需要重来时点右上角清空按钮**手动开启新会话**。
- 会话内容**按标签页隔离并持久化**：每个标签页有自己独立的对话，切走切回**不丢失**；关闭该标签页时对话自动清空（存于 `chrome.storage.session`，浏览器关闭也会清空）。
- 侧边栏**按标签页控制显示**：新标签页默认不显示；只有在某个标签页**手动点击扩展图标**（或用右键菜单「解释选中内容」）才在该标签页打开。切回曾经打开过的标签页会自动显示它的对话，切到没打开过的标签页则不显示。

### 长页面分块处理

- 抓取正文上限提高到约 20 万字（原来截断到 1.2 万字会丢信息）。
- 正文不超过约 1.2 万字时：一次性注入全文（快）。
- 正文较长时：自动按段落边界切成多块（每块约 9000 字，最多 12 块），在首次注入时**逐块喂给 Kiro 阅读**，最后再发用户问题，Kiro 基于全文作答。
  - 喂块期间侧边栏显示「正在阅读长页面…（N/总块数）」进度。
  - 之后的追问无需重复喂块（页面已在会话记忆里）。

### PDF 支持

- 打开**在线 PDF**（URL 以 `.pdf` 结尾）时，插件用内置的 pdf.js（已打包进扩展，离线可用）提取文字，走和网页一样的分块问答。
- PDF 预览里会显示页数、已解析页数、字数等信息。
- 限制：
  - **扫描版 / 图片型 PDF** 没有文字层，提取不到内容（需要 OCR，暂不支持），会给出提示。
  - **本地 `file:///` 的 PDF** 需要在扩展详情页开启「允许访问文件网址」后才能读取。
  - 超大 PDF 默认最多解析前 300 页。

## 目录结构

```
kiro-web-plugin/
├── README.md
├── server/
│   ├── server.js        # 本地后端（零依赖）
│   └── package.json
└── extension/
    ├── manifest.json
    ├── background.js    # 侧边栏开启行为 + 右键菜单
    ├── sidepanel.html / .css / .js   # 主界面 + SSE 流式解析 + Markdown 渲染
    ├── markdown.js      # 轻量安全的 Markdown 渲染器
    ├── extract.js       # 注入页面抓取正文
    ├── options.html / .js            # 设置页
    └── icons/           # logo 图标
```

## 右键菜单

在任意网页**选中文字后右键**，选择「用 Kiro 解释选中内容」，会自动打开侧边栏并让 Kiro 解释这段内容（沿用当前会话，可结合已聊的页面上下文）。

## 常见问题

- **状态点红色 / 请求失败**：确认后端已启动，且设置页里的地址与端口一致。
- **回答为空或报错**：在终端直接运行 `kiro-cli chat "你好"` 确认 CLI 本身可用、已登录。
- **想换模型**：在设置页填 `model`（对应 `kiro-cli --model`），或先用 `kiro-cli chat --list-models` 查看可用模型。
```
