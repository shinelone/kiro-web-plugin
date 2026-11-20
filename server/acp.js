'use strict';

/**
 * 常驻 kiro-cli（ACP 模式）管理。
 *
 * 以前每次提问都 spawn 一个 `kiro-cli chat --no-interactive`，光启动就要约 5 秒，
 * 回答完还要约 1.5 秒才退出。这里改成常驻一个 `kiro-cli acp` 进程，
 * 通过 stdin/stdout 上的 JSON-RPC（Agent Client Protocol）收发消息，多个会话共用这一个进程。
 *
 * 实测得出的几个注意点（kiro-cli 3.3.0）：
 *  - 进程只在启动时读取 agent 文件：agent 增删改后必须重启进程（见 markStale）。
 *  - 切到不存在的 agent（mode）时接口也返回成功，实际静默用默认 agent，所以设置后要核对当前值。
 *  - 切换 agent 后模型可能残留上次的值，所以每次都显式设置模型。
 *  - session/load 恢复会话时会重放历史消息，这些更新不能转发给前端。
 *  - V3 引擎下 --trust-all-tools 不生效，工具授权通过 session/request_permission 由这里自动同意。
 *  - V3 引擎会读取 agent 的 tools 和 model，但不使用 prompt（chat --agent 也一样，V2 正常）。
 *    插件 agent 的提示词由 server.js 加在新会话的第一条消息前面。
 *  - 读文件工具不会请求授权，能读本机任意文件。这里声明 fs.readTextFile 能力后，
 *    kiro 会把读文件改成向客户端发 fs/read_text_file，由 canReadFile 决定允许读哪些路径。
 *    grep / glob 仍由 kiro 自己执行，只搜索工作目录（server/workspace）。
 */

const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

const DEFAULT_MODE = 'vibe'; // ACP 下的默认 agent
const SESSION_IDLE_MS = 30 * 60 * 1000; // 会话空闲多久后关闭以释放内存
const REQUEST_TIMEOUT_MS = 60 * 1000; // 非 prompt 请求的超时
const RESTART_BACKOFF_MS = [0, 1000, 3000, 10000]; // 连续崩溃时的重启间隔

class AcpError extends Error {}

class AcpManager {
  constructor({ kiroBin, cwd, canReadFile = () => false, denyMessage = null, terminal = null, approveCommand = null, log = () => {} }) {
    this.kiroBin = kiroBin;
    this.cwd = cwd;
    this.canReadFile = canReadFile;
    this.denyMessage = denyMessage;
    this.terminal = terminal; // TerminalManager，决定是否声明 terminal 能力
    this.approveCommand = approveCommand; // async (sessionId, command, verdict) => 'allow' | 'deny'
    this.log = log;
    this.proc = null;
    this.ready = null; // Promise<void>，进程启动并完成 initialize
    this.state = 'down'; // down | starting | ready
    this.nextId = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.sessions = new Map(); // sessionId -> { mode, model, busy, lastUsed, onUpdate }
    this.modes = []; // 最近一次 session/new 返回的可用 agent 列表
    this.spare = null; // 预热好的空闲会话 id，新对话直接用，省掉 session/new 的等待
    this.stale = false; // agent 文件有变化，需要在空闲时重启进程
    this.crashes = 0;
    this.stderrTail = '';
    this.gcTimer = setInterval(() => this.closeIdleSessions(), 60 * 1000);
    this.gcTimer.unref();
  }

  // ---------- 进程 ----------

  /** 确保进程已启动（并发调用共享同一个启动过程） */
  start() {
    if (this.ready) return this.ready;
    this.state = 'starting';
    this.ready = this._start().catch((e) => {
      this.state = 'down';
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  async _start() {
    const delay = RESTART_BACKOFF_MS[Math.min(this.crashes, RESTART_BACKOFF_MS.length - 1)];
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const proc = spawn(this.kiroBin, ['acp'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.stderrTail = '';

    proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    proc.on('error', (e) => this._onExit(proc, 'spawn error: ' + e.message));
    proc.on('exit', (code, sig) => this._onExit(proc, `exit code=${code} signal=${sig}`));
    proc.stdin.on('error', () => {}); // 进程退出后写入会 EPIPE，由 exit 处理

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));

    await this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: !!this.terminal },
    });
    this.state = 'ready';
    this.log(`kiro-cli acp 已启动 (pid ${proc.pid})`);
    // 预热一个会话：拿到 agent 列表，下一个新对话也不用再等 session/new
    this._prepareSpare();
  }

  _onExit(proc, reason) {
    if (proc !== this.proc) return; // 旧进程（已主动重启）
    const wasReady = this.state === 'ready';
    this.proc = null;
    this.ready = null;
    this.state = 'down';
    this.spare = null;
    this.crashes = this._restarting ? 0 : this.crashes + 1;
    this._restarting = false;
    const err = new AcpError('kiro-cli 进程已退出（' + reason + '）' + (this.stderrTail ? '\n' + this.stderrTail.slice(-1500) : ''));
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // 进程里的会话都失效了；正在进行的回答通知前端出错
    for (const [, s] of this.sessions) {
      if (s.onUpdate) s.onUpdate({ __error: err.message });
    }
    this.sessions.clear();
    if (wasReady) this.log('kiro-cli acp 退出: ' + reason);
  }

  /** 主动重启（agent 变化后）。有回答正在进行时等它们结束 */
  async restart() {
    if (!this.proc) return;
    this._restarting = true;
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    this.state = 'down';
    this.spare = null;
    this.sessions.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AcpError('kiro-cli 正在重启'));
    }
    this.pending.clear();
    proc.kill('SIGTERM');
    setTimeout(() => proc.exitCode == null && proc.kill('SIGKILL'), 3000).unref();
    this._restarting = false;
    this.crashes = 0;
    return this.start();
  }

  /** agent 文件变了：没有回答在进行就立即重启，否则等最后一个回答结束 */
  markStale() {
    this.stale = true;
    this._maybeRestartStale();
  }

  _maybeRestartStale() {
    if (!this.stale) return;
    if ([...this.sessions.values()].some((s) => s.busy)) return;
    this.stale = false;
    this.restart().catch((e) => this.log('重启 kiro-cli acp 失败: ' + e.message));
  }

  stop() {
    clearInterval(this.gcTimer);
    if (this.proc) this.proc.kill('SIGTERM');
  }

  // ---------- JSON-RPC ----------

  _send(obj) {
    if (!this.proc) throw new AcpError('kiro-cli 进程未运行');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  }

  _request(method, params, timeout = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new AcpError(method + ' 超时'));
          }, timeout)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    // 响应
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new AcpError(m.error.message || JSON.stringify(m.error)));
      else p.resolve(m.result);
      return;
    }
    // agent 发来的请求
    if (m.id != null && m.method) {
      this._onAgentRequest(m);
      return;
    }
    // 通知
    if (m.method === 'session/update' && m.params) {
      const s = this.sessions.get(m.params.sessionId);
      if (s && s.onUpdate) s.onUpdate(m.params.update || {});
    }
  }

  _onAgentRequest(m) {
    if (m.method === 'session/request_permission') {
      this._requestPermission(m);
      return;
    }
    if (m.method === 'fs/read_text_file') {
      this._readTextFile(m);
      return;
    }
    if (m.method === '_kiro/terminal/shell_type') {
      this._safeSend({ id: m.id, result: { shellType: 'zsh' } });
      return;
    }
    if (this.terminal && m.method.startsWith('terminal/')) {
      this._onTerminal(m);
      return;
    }
    // 其它请求一律回「不支持」
    this._safeSend({ id: m.id, error: { code: -32601, message: 'Method not supported: ' + m.method } });
  }

  /** 工具授权：读文件、非命令工具自动同意；命令按审批回调决定 */
  async _requestPermission(m) {
    const opts = (m.params && m.params.options) || [];
    const allow = opts.find((o) => o.kind === 'allow_once') || opts.find((o) => /allow/.test(o.kind || ''));
    const reject = opts.find((o) => o.kind === 'reject_once') || opts.find((o) => /reject|deny/.test(o.kind || ''));
    const pick = (opt) =>
      this._safeSend({
        id: m.id,
        result: opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } },
      });

    const meta = ((m.params || {}).toolCall && (m.params.toolCall._meta || {}).kiro) || ((m.params || {})._meta || {}).kiro || {};
    const km = (m.params && m.params._meta && m.params._meta.kiro) || {};
    const command = km.command || (km.consent && km.consent.resource) || (meta.consent && meta.consent.resource) || '';
    const isShell = km.toolId === 'run_command' || (km.consent && km.consent.capability === 'shell');

    // 命令的审批放在 terminal/create（每条命令必经那里）；这里一律放行，避免二次弹窗
    void isShell;
    void command;
    pick(allow);
  }

  async _onTerminal(m) {
    const method = m.method.slice('terminal/'.length);
    const sess = this.sessions.get(m.params && m.params.sessionId);
    try {
      if (method === 'create') {
        const command = (m.params && m.params.command) || '';
        let decision = 'deny';
        try {
          decision = this.approveCommand ? await this.approveCommand(m.params.sessionId, command, sess) : 'allow';
        } catch (e) {
          decision = 'deny';
        }
        if (decision === 'deny') {
          const why = (sess && sess._denyWhy) || '用户或策略拒绝了这条命令';
          this._safeSend({ id: m.id, error: { code: -32000, message: why } });
          return;
        }
        const r = this.terminal.create(m.params, { pageTainted: sess && sess.pageTainted, decision: sess && sess._lastDecision });
        this._safeSend({ id: m.id, result: { terminalId: r.terminalId } });
      } else if (method === 'output') {
        this._safeSend({ id: m.id, result: this.terminal.output(m.params.terminalId) });
      } else if (method === 'wait_for_exit') {
        const exit = await this.terminal.waitForExit(m.params.terminalId);
        this._safeSend({ id: m.id, result: { exitCode: exit.exitCode, signal: exit.signal } });
      } else if (method === 'kill') {
        this._safeSend({ id: m.id, result: this.terminal.kill(m.params.terminalId) });
      } else if (method === 'release') {
        this._safeSend({ id: m.id, result: this.terminal.release(m.params.terminalId) });
      } else {
        this._safeSend({ id: m.id, error: { code: -32601, message: 'Method not supported: ' + m.method } });
      }
    } catch (e) {
      this._safeSend({ id: m.id, error: { code: -32000, message: e.message } });
    }
  }

  /** fs/read_text_file：line 从 1 开始，limit 为行数；只允许 canReadFile 放行的路径 */
  _readTextFile(m) {
    const p = (m.params && m.params.path) || '';
    if (!this.canReadFile(p)) {
      this._safeSend({
        id: m.id,
        error: {
          code: -32000,
          message: this.denyMessage ? this.denyMessage() : '不允许读取该文件：本插件只允许读取页面文件（server/workspace/pages/ 下的 .md）',
        },
      });
      return;
    }
    fs.readFile(p, 'utf8', (err, text) => {
      if (err) {
        this._safeSend({ id: m.id, error: { code: -32000, message: '读取失败: ' + err.message } });
        return;
      }
      const line = Math.max(1, Number(m.params.line) || 1);
      const limit = Number(m.params.limit) > 0 ? Number(m.params.limit) : null;
      let content = text;
      if (line > 1 || limit) {
        const lines = text.split('\n');
        content = lines.slice(line - 1, limit ? line - 1 + limit : undefined).join('\n');
      }
      this._safeSend({ id: m.id, result: { content } });
    });
  }

  _safeSend(obj) {
    try {
      this._send(obj);
    } catch {
      /* 进程已退出 */
    }
  }

  // ---------- 会话 ----------

  async _prepareSpare() {
    try {
      const r = await this._request('session/new', { cwd: this.cwd, mcpServers: [] });
      this._rememberModes(r);
      this.spare = { id: r.sessionId, config: configOf(r) };
    } catch (e) {
      this.log('预热会话失败: ' + e.message);
    }
  }

  _rememberModes(r) {
    if (r && r.modes && Array.isArray(r.modes.availableModes)) {
      this.modes = r.modes.availableModes.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description || '',
        source: (m._meta && m._meta.kiro && m._meta.kiro.source) || 'bundled',
      }));
    }
  }

  /** 当前进程可用的 agent（ACP 里叫 mode）。进程没起来时先启动 */
  async listModes() {
    await this.start();
    if (!this.modes.length) {
      // 预热还没完成：等它一下
      for (let i = 0; i < 40 && !this.modes.length; i++) await new Promise((r) => setTimeout(r, 100));
    }
    return this.modes;
  }

  /**
   * 取得一个可以提问的会话，并切到指定的 agent / 模型。
   * sessionId 为空时新建；不在本进程里时用 session/load 恢复（历史重放不转发）。
   */
  async openSession(sessionId, mode, model) {
    await this.start();
    let s = sessionId ? this.sessions.get(sessionId) : null;
    let isNew = false;

    if (!s && sessionId) {
      const entry = { busy: false, lastUsed: Date.now(), onUpdate: null, config: {} };
      this.sessions.set(sessionId, entry); // 先占位，load 期间的重放更新会因为 onUpdate 为空被丢弃
      try {
        const r = await this._request('session/load', { sessionId, cwd: this.cwd, mcpServers: [] }, 120000);
        entry.config = configOf(r);
      } catch (e) {
        this.sessions.delete(sessionId);
        throw e;
      }
      s = entry;
    }

    if (!s) {
      isNew = true;
      let id;
      let config;
      if (this.spare) {
        ({ id, config } = this.spare);
        this.spare = null;
        this._prepareSpare(); // 补一个新的备用会话
      } else {
        const r = await this._request('session/new', { cwd: this.cwd, mcpServers: [] });
        this._rememberModes(r);
        id = r.sessionId;
        config = configOf(r);
      }
      sessionId = id;
      s = { busy: false, lastUsed: Date.now(), onUpdate: null, config };
      this.sessions.set(id, s);
    }

    if (s.busy) throw new AcpError('该会话正在回答上一个问题');

    const wantMode = mode || DEFAULT_MODE;
    if (s.config.mode !== wantMode) {
      const r = await this._request('session/set_config_option', { sessionId, configId: 'mode', value: wantMode });
      s.config = configOf(r, s.config);
      if (s.config.mode !== wantMode) {
        throw new AcpError('agent 不存在: ' + (mode || DEFAULT_MODE) + '（可能已被删除，请在侧边栏重新选择）');
      }
    }
    if (model && s.config.model !== model) {
      const r = await this._request('session/set_config_option', { sessionId, configId: 'model', value: model });
      s.config = configOf(r, s.config);
      if (s.config.model !== model) throw new AcpError('无法切换到模型: ' + model);
    }
    return { sessionId, isNew, model: s.config.model, mode: s.config.mode };
  }

  /**
   * 发起一轮问答。onUpdate 收到 ACP 的 session/update（与 stream-json 里的 update 结构相同）。
   * 返回 { stopReason }。
   */
  /**
   * images：[{ mimeType, data(base64) }]，放在文字前面一起发（kiro-cli 3.3 的 promptCapabilities.image 为 true）
   */
  /** 标记某会话已注入过网页内容（命令审批时据此提高联网命令风险） */
  markPageTainted(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.pageTainted = true;
  }

  async prompt(sessionId, text, onUpdate, images = []) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AcpError('会话不存在');
    if (s.busy) throw new AcpError('该会话正在回答上一个问题');
    s.busy = true;
    s.onUpdate = onUpdate;
    s.lastUsed = Date.now();
    try {
      const blocks = images.map((im) => ({ type: 'image', mimeType: im.mimeType, data: im.data }));
      blocks.push({ type: 'text', text });
      return await this._request('session/prompt', { sessionId, prompt: blocks }, 0);
    } finally {
      s.busy = false;
      s.onUpdate = null;
      s.lastUsed = Date.now();
      this._maybeRestartStale();
    }
  }

  cancel(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.busy) return;
    this._safeSend({ method: 'session/cancel', params: { sessionId } });
  }

  async closeIdleSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.busy || now - s.lastUsed < SESSION_IDLE_MS) continue;
      this.sessions.delete(id);
      try {
        await this._request('session/close', { sessionId: id });
      } catch {
        /* 关闭失败无所谓，进程重启时也会释放 */
      }
    }
  }

  status() {
    return {
      state: this.state,
      pid: this.proc ? this.proc.pid : null,
      sessions: this.sessions.size,
      busy: [...this.sessions.values()].filter((s) => s.busy).length,
    };
  }
}

/** 从 ACP 响应里取出当前的 mode / model */
function configOf(result, prev = {}) {
  const out = { ...prev };
  const opts = (result && result.configOptions) || [];
  for (const o of opts) {
    if (o.id === 'mode' || o.id === 'model') out[o.id] = o.currentValue;
  }
  return out;
}

module.exports = { AcpManager, AcpError, DEFAULT_MODE };
