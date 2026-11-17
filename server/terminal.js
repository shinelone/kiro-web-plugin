'use strict';

/**
 * 命令执行：实现 ACP 的 terminal/* 方法。
 *
 * 声明 terminal 能力后，kiro-cli 不再自己运行命令，而是把命令交给后端：
 *   terminal/create        → 在沙箱里启动命令，返回 terminalId
 *   terminal/output        → 返回已有输出和退出状态
 *   terminal/wait_for_exit → 等命令结束
 *   terminal/kill          → 结束命令（连同子进程）
 *   terminal/release       → 释放
 *
 * 每条命令：
 *  - 用 shellpolicy 再判一次（防止绕过 request_permission 这一步），禁止类直接拒绝；
 *  - 尽量用 macOS 的 sandbox-exec 包起来，限制可写目录、禁读敏感文件、按设置决定是否联网；
 *  - 固定工作目录、清理敏感环境变量、超时后杀进程组、输出超限截断；
 *  - 写审计日志。
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const shellpolicy = require('./shellpolicy');
const shellconfig = require('./shellconfig');

const MAX_OUTPUT = 1 << 20; // 单条命令输出上限 1MB
let SANDBOX_OK = null; // 是否能用 sandbox-exec（首次使用时探测并缓存）

const HOME = os.homedir();
// 沙箱里禁止读取的敏感目录 / 文件
const SECRET_PATHS = [
  '.ssh', '.aws', '.gnupg', '.netrc', '.config/gcloud', '.docker/config.json',
  '.kiro', '.config/kiro', 'Library/Keychains', 'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox', 'Library/Cookies',
];

function detectSandbox() {
  if (SANDBOX_OK != null) return SANDBOX_OK;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    SANDBOX_OK = true;
  } catch {
    SANDBOX_OK = false;
  }
  return SANDBOX_OK;
}

function quote(p) {
  return '"' + String(p).replace(/(["\\])/g, '\\$1') + '"';
}

/** 生成 sandbox-exec 规则：默认放行，但收紧写入、敏感读取、按需断网 */
function buildProfile(cwd, writeDirs, allowNetwork) {
  const writable = [cwd, '/private/tmp', '/private/var/folders', os.tmpdir(), ...writeDirs];
  const lines = [
    '(version 1)',
    '(allow default)',
    // 写入：只允许工作目录、临时目录和额外放行目录；其它位置拒绝
    '(deny file-write*)',
    '(allow file-write*',
    ...writable.map((d) => '  (subpath ' + quote(fs.realpathSync(d)) + ')'),
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")',
    '  (regex #"^/dev/fd/")',
    ')',
    // 敏感文件：禁止读取
    '(deny file-read*',
    ...SECRET_PATHS.map((rel) => '  (subpath ' + quote(path.join(HOME, rel)) + ')'),
    ')',
  ];
  if (!allowNetwork) lines.push('(deny network*)');
  return lines.join('\n');
}

/** 清理环境变量：去掉密钥类，保留运行所需的基础变量 */
function safeEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL', 'PWD', 'NODE_ENV'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  // 显式补几个常用路径，避免 PATH 太窄找不到 node/git/brew
  env.PATH = [env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
  env.KIRO_PLUGIN = '1';
  return env;
}

class TerminalManager {
  constructor({ cwd, log = () => {} }) {
    this.baseCwd = cwd; // 默认工作目录（server/workspace）
    this.log = log;
    this.terms = new Map(); // terminalId -> { proc, out, truncated, exit, waiters, release }
    this.seq = 0;
  }

  /** 决定命令的工作目录：只允许 baseCwd 或设置里放行的可写目录，其它一律回落到 baseCwd */
  _resolveCwd(wanted) {
    if (!wanted) return this.baseCwd;
    let p;
    try {
      p = fs.realpathSync(path.resolve(wanted));
    } catch {
      return this.baseCwd;
    }
    const allow = [this.baseCwd, ...shellconfig.get().shellWriteDirs];
    for (const d of allow) {
      try {
        const r = fs.realpathSync(d);
        if (p === r || p.startsWith(r + path.sep)) return p;
      } catch {
        /* 跳过 */
      }
    }
    return this.baseCwd;
  }

  /**
   * 启动一条命令。审批已在 request_permission 阶段做过，这里再判一次禁止类兜底。
   * 返回 { terminalId } 或抛错。
   */
  create(params, meta = {}) {
    const command = (params && params.command) || '';
    const cfg = shellconfig.get();
    if (cfg.shellMode === 'off') throw new Error('命令执行已在设置页关闭');

    const verdict = shellpolicy.classify(command, {
      readOnlyCmds: cfg.shellAllow,
      bannedCmds: cfg.shellDeny,
      pageTainted: meta.pageTainted,
    });
    if (verdict.level === 'ban') {
      shellconfig.log({ command, decision: 'ban', why: verdict.why });
      throw new Error('命令被拒绝：' + verdict.why);
    }

    const cwd = this._resolveCwd(params.cwd);
    const useSandbox = detectSandbox();
    const timeoutMs = cfg.shellTimeout * 1000;

    let file, argv;
    const inner = command;
    if (useSandbox) {
      const profile = buildProfile(cwd, cfg.shellWriteDirs, cfg.shellNetwork);
      file = '/usr/bin/sandbox-exec';
      argv = ['-p', profile, '/bin/zsh', '-c', inner];
    } else {
      file = '/bin/zsh';
      argv = ['-c', inner];
    }

    const proc = spawn(file, argv, {
      cwd,
      env: safeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 独立进程组，超时 / kill 时能连子进程一起结束
    });

    const id = 'term' + ++this.seq;
    const term = {
      proc,
      out: '',
      truncated: false,
      exit: null, // { exitCode, signal }
      waiters: [],
      command,
      cwd,
      sandbox: useSandbox,
      startedAt: Date.now(),
      net: verdict.net,
    };
    this.terms.set(id, term);

    const onData = (buf) => {
      if (term.out.length >= MAX_OUTPUT) {
        term.truncated = true;
        return;
      }
      term.out += buf.toString('utf8');
      if (term.out.length > MAX_OUTPUT) {
        term.out = term.out.slice(0, MAX_OUTPUT);
        term.truncated = true;
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    term.timer = setTimeout(() => {
      term.timedOut = true;
      this._killTree(term, 'SIGKILL');
    }, timeoutMs);
    term.timer.unref && term.timer.unref();

    const finish = (exitCode, signal) => {
      if (term.exit) return;
      clearTimeout(term.timer);
      if (term.timedOut) term.out += `\n[命令超过 ${cfg.shellTimeout} 秒被终止]`;
      term.exit = { exitCode: exitCode == null ? -1 : exitCode, signal: signal || null };
      shellconfig.log({
        command,
        decision: meta.decision || (verdict.level === 'auto' ? 'auto' : 'confirm'),
        sandbox: useSandbox,
        cwd,
        exitCode: term.exit.exitCode,
        ms: Date.now() - term.startedAt,
        timedOut: !!term.timedOut,
      });
      for (const w of term.waiters) w(term.exit);
      term.waiters = [];
    };
    proc.on('exit', (code, signal) => finish(code, signal));
    proc.on('error', (e) => {
      term.out += '\n[无法启动命令：' + e.message + ']';
      finish(-1, null);
    });

    this.log(`运行命令${useSandbox ? '（沙箱）' : ''}: ${command.slice(0, 200)}`);
    return { terminalId: id, _sandbox: useSandbox };
  }

  _get(id) {
    const t = this.terms.get(id);
    if (!t) throw new Error('terminal 不存在: ' + id);
    return t;
  }

  output(id) {
    const t = this._get(id);
    return {
      output: t.out,
      truncated: t.truncated,
      exitStatus: t.exit ? { exitCode: t.exit.exitCode, signal: t.exit.signal } : null,
    };
  }

  waitForExit(id) {
    const t = this._get(id);
    if (t.exit) return Promise.resolve({ exitCode: t.exit.exitCode, signal: t.exit.signal });
    return new Promise((resolve) => t.waiters.push(resolve));
  }

  _killTree(term, sig) {
    try {
      process.kill(-term.proc.pid, sig); // 负 pid：整个进程组
    } catch {
      try {
        term.proc.kill(sig);
      } catch {
        /* 已退出 */
      }
    }
  }

  kill(id) {
    const t = this._get(id);
    this._killTree(t, 'SIGKILL');
    return {};
  }

  release(id) {
    const t = this.terms.get(id);
    if (t) {
      clearTimeout(t.timer);
      if (!t.exit) this._killTree(t, 'SIGKILL');
      this.terms.delete(id);
    }
    return {};
  }

  /** 进程退出时结束所有命令 */
  stopAll() {
    for (const [, t] of this.terms) if (!t.exit) this._killTree(t, 'SIGKILL');
    this.terms.clear();
  }
}

module.exports = { TerminalManager, detectSandbox };
