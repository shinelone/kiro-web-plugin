'use strict';

// 与本地 Native Messaging 启动器（server/native-host）通信，用于启动/停止后端。
// 侧边栏与设置页共用。

const NATIVE_HOST = 'com.kiro.web_plugin';

/**
 * 发送一条命令给启动器。
 * action: 'start' | 'stop' | 'restart' | 'status'
 * 返回 { ok, running, pid, output, error }；未安装启动器时 ok=false 且 notInstalled=true。
 */
function callNativeHost(action, port) {
  return new Promise((resolve) => {
    if (!chrome.runtime.sendNativeMessage) {
      // manifest 已加权限但 Chrome 还没重新加载插件时会走到这里
      resolve({
        ok: false,
        needsReload: true,
        error: '插件还没获得 nativeMessaging 权限，请在 chrome://extensions 重新加载本插件',
      });
      return;
    }
    const msg = { action };
    if (Number.isInteger(port)) msg.port = port;
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const m = err.message || String(err);
          resolve({
            ok: false,
            notInstalled: /not found|not allowed|forbidden/i.test(m),
            error: m,
          });
          return;
        }
        resolve(resp || { ok: false, error: '启动器无响应' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
  });
}

/** 从后端地址中解析端口（仅本机地址才有意义） */
function endpointPort(endpoint) {
  try {
    const u = new URL(endpoint);
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return null;
    return u.port ? Number(u.port) : 80;
  } catch {
    return null;
  }
}

/** 后端地址是否是本机（只有本机后端才能由启动器拉起） */
function isLocalEndpoint(endpoint) {
  return endpointPort(endpoint) != null;
}

/** 生成安装启动器的终端命令 */
function nativeInstallCommand() {
  return 'cd server/native-host && ./install.sh ' + chrome.runtime.id;
}
