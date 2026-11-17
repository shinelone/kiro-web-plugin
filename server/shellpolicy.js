'use strict';

/**
 * 命令分级：把 Kiro 想运行的命令判成 禁止 / 只读（自动放行）/ 需确认。
 *
 * 复合命令（;、&&、||、|、子命令）按最高风险的一段算。解析不是完整的 shell 语法，
 * 只做够用的切分 + 关键词匹配；拿不准时一律归到「需确认」，不会悄悄放行。
 *
 * 清单可在设置页编辑，保存在 shellconfig.js（.plugin-config.json）。
 */

// 只读命令（第一个词命中且没有危险操作符时自动放行）
const READONLY = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'echo', 'printf', 'date', 'cal', 'whoami', 'id', 'hostname', 'uname', 'sw_vers', 'arch',
  'env', 'printenv', 'which', 'type', 'basename', 'dirname', 'realpath', 'readlink',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'tree', 'sort', 'uniq', 'cut', 'tr', 'column', 'diff', 'comm',
  'ps', 'top', 'uptime', 'vm_stat', 'sysctl', 'ioreg', 'system_profiler',
]);

// 解释器 / 包管理器：会跑任意代码，默认需确认，只有版本 / 帮助 / 查询类子命令才自动放行
const INTERP = new Set(['node', 'python', 'python3', 'ruby', 'php', 'go', 'java', 'rustc', 'deno', 'bun', 'perl', 'osascript']);
const PKG_READONLY_SUB = {
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'ping', 'whoami', 'root', 'prefix', 'config', 'help']),
  pnpm: new Set(['ls', 'list', 'view', 'outdated', 'why', 'root', 'help']),
  yarn: new Set(['list', 'info', 'why', 'help']),
  pip: new Set(['list', 'show', 'freeze', 'check']),
  pip3: new Set(['list', 'show', 'freeze', 'check']),
  brew: new Set(['list', 'info', 'search', 'outdated', 'deps', 'doctor', 'config', '--version', 'help']),
  go: new Set(['version', 'env', 'list']),
};
const PKG = new Set(Object.keys(PKG_READONLY_SUB));
// 带版本 / 帮助参数的解释器默认当只读（node -v、python --version）
const VERSION_FLAGS = new Set(['-v', '--version', '-V', 'version', '--help', '-h', 'help']);

// git 的只读子命令
const GIT_READONLY = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'stash']);

// 永远禁止（命中即拒绝）
const BANNED_CMDS = new Set([
  'sudo', 'su', 'doas',
  'mkfs', 'fdisk', 'diskutil', 'newfs',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'launchctl', 'crontab', 'at',
  'csrutil', 'spctl', 'kextload', 'kextunload',
  'passwd', 'dscl', 'sysadminctl', 'createhomedir',
  'osascript', 'automator', // AppleScript 可绕过沙箱与很多限制
]);
// 系统查询 / 配置类：不自动放行、也不硬禁止，一律弹卡片让用户决定。
// 它们多有只读子命令（pmset -g、scutil --get、networksetup -getinfo），敏感读取另由 BANNED_PATTERNS 拦截。

// 命中这些片段直接禁止（正则，针对整条命令）
const BANNED_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, why: '递归强制删除（rm -rf）风险太高' },
  { re: /\b(rm|rmdir)\b[^|;&]*\s(~|\/|\$HOME|\/Users\/[^/\s]+)(\s|$)/, why: '删除家目录或根目录' },
  { re: /\bdd\b[^|;&]*\bof=/, why: 'dd 写入设备风险太高' },
  { re: /[>|]\s*\/dev\/(disk|rdisk|sd|null)?[a-z0-9]/i, why: '直接写磁盘设备' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|ruby|perl)\b/, why: '把下载内容直接管道给解释器执行' },
  { re: /\b(\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.gnupg|\.netrc|Keychains|login\.keychain)\b/i, why: '访问密钥、凭据或钥匙串' },
  { re: /\bdump-keychain\b|\bfind-(generic|internet)-password\b/, why: '读取钥匙串密码' },
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: /\bchflags\b|\bchattr\b/, why: '修改文件系统标志' },
];

// 联网类命令（会话读过网页时，这些需要确认，防止被页面诱导外传）
const NETWORK_CMDS = new Set(['curl', 'wget', 'nc', 'ncat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'http', 'https']);
const NETWORK_SUBCMD = { git: new Set(['push', 'pull', 'clone', 'fetch', 'remote']), npm: new Set(['publish']), pnpm: new Set(['publish']), yarn: new Set(['publish']) };

/** 粗切分：按 ; && || | 以及换行切成若干段，去掉 $( ) 和反引号里的内容单独判 */
function splitSegments(command) {
  const segs = [];
  // 提取子命令（$(...) 和 ``...``）单独作为一段，同时留下标记表示「含子命令」
  const subs = [];
  let s = command.replace(/\$\(([^()]*)\)/g, (_, c) => (subs.push(c), ' \u0000SUB\u0000 ')).replace(/`([^`]*)`/g, (_, c) => (subs.push(c), ' \u0000SUB\u0000 '));
  for (const part of s.split(/\n|;|&&|\|\||\||&/)) {
    const t = part.trim();
    if (t) segs.push(t);
  }
  for (const c of subs) for (const seg of splitSegments(c)) segs.push(seg);
  return segs;
}

/** 取一段命令的第一个实际命令词（跳过 env VAR=x 这类前缀和变量赋值） */
function firstWord(seg) {
  const tokens = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'env' || tokens[i] === 'command' || tokens[i] === 'exec' || tokens[i] === 'nohup' || tokens[i] === 'time')) i++;
  const cmd = tokens[i] || '';
  // 去掉路径前缀：/usr/bin/grep → grep
  const base = cmd.replace(/^.*\//, '');
  return { base, args: tokens.slice(i + 1), raw: cmd };
}

/**
 * 判定一条命令。
 * opts.readOnlyCmds / bannedCmds：设置页里追加的白名单 / 黑名单（命令名）。
 * opts.pageTainted：本会话注入过网页内容。
 * 返回 { level: 'ban'|'auto'|'confirm', why, net }
 */
function classify(command, opts = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { level: 'ban', why: '空命令' };
  if (cmd.length > 4000) return { level: 'confirm', why: '命令很长' };

  const extraBan = new Set(opts.bannedCmds || []);
  const extraAuto = new Set(opts.readOnlyCmds || []);

  for (const p of BANNED_PATTERNS) if (p.re.test(cmd)) return { level: 'ban', why: p.why };
  // find/xargs 带执行或删除动作不算只读
  const findMutates = /\bfind\b[^|;&]*\s(-delete|-exec|-execdir|-ok)\b/.test(cmd) || /\bxargs\b/.test(cmd);

  const segs = splitSegments(cmd);
  const hasRedirectWrite = /(^|[^0-9<>])>{1,2}(?![&])/.test(cmd.replace(/\u0000SUB\u0000/g, '')); // > 或 >>（排除 2>&1）
  const hasSub = cmd.includes('$(') || /`/.test(cmd);
  let worst = 'auto';
  let why = '';
  let net = false;
  const bump = (lvl, reason) => {
    const rank = { auto: 0, confirm: 1, ban: 2 };
    if (rank[lvl] > rank[worst]) {
      worst = lvl;
      why = reason;
    }
  };

  for (const seg of segs) {
    if (seg === '\u0000SUB\u0000') continue;
    const { base, args } = firstWord(seg);
    if (!base) continue;
    if (BANNED_CMDS.has(base) && !extraAuto.has(base)) return { level: 'ban', why: base + ' 命令被禁止' };
    if (extraBan.has(base)) return { level: 'ban', why: base + ' 在你的黑名单里' };

    // 联网判断
    const sub = args.find((a) => !a.startsWith('-')) || '';
    if (NETWORK_CMDS.has(base) || (NETWORK_SUBCMD[base] && NETWORK_SUBCMD[base].has(sub))) net = true;

    // 只读判断
    let readonly = false;
    if (extraAuto.has(base)) readonly = true;
    else if (base === 'git') readonly = GIT_READONLY.has(sub);
    else if (INTERP.has(base)) readonly = args.length > 0 && args.every((a) => VERSION_FLAGS.has(a));
    else if (PKG.has(base)) readonly = !sub || VERSION_FLAGS.has(sub) || PKG_READONLY_SUB[base].has(sub);
    else if (READONLY.has(base)) readonly = true;
    let reason = base + ' 可能修改文件或系统';
    if (INTERP.has(base) && !readonly) reason = base + ' 会执行代码';
    bump(readonly ? 'auto' : 'confirm', readonly ? '' : reason);
  }

  if (findMutates) bump('confirm', 'find/xargs 带执行或删除动作');
  if (hasRedirectWrite) bump('confirm', '包含输出重定向（会写文件）');
  if (hasSub) bump('confirm', '包含子命令（$() 或反引号）');
  // 会话读过网页：联网命令需确认，防止把本机内容外传
  if (net && opts.pageTainted) bump('confirm', '本会话读过网页内容，联网命令需确认，注意是否被页面诱导');

  return { level: worst, why, net };
}

module.exports = { classify, splitSegments, firstWord, READONLY, BANNED_CMDS };
