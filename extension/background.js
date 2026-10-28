// 侧边栏「按标签页」控制：
// - 默认每个标签页都不显示侧边栏；
// - 用户点扩展图标，才在「当前标签页」启用并打开；
// - 切回曾经开过的标签页会自动显示，切到没开过的新标签页则不显示；
// - 标签页关闭后清除它的记录。
//
// 「开过侧边栏的标签页」集合存在 chrome.storage.session（浏览器关闭即清空）。

const ENABLED_TABS_KEY = 'enabledTabs';
const MENU_EXPLAIN = 'kiro-explain-selection';
const SIDE_PANEL_PATH = 'sidepanel.html';

// ---------- 启用集合读写 ----------
async function getEnabledTabs() {
  try {
    const got = await chrome.storage.session.get(ENABLED_TABS_KEY);
    return got[ENABLED_TABS_KEY] || {};
  } catch (e) {
    return {};
  }
}
async function markTabEnabled(tabId) {
  const set = await getEnabledTabs();
  set[tabId] = true;
  await chrome.storage.session.set({ [ENABLED_TABS_KEY]: set }).catch(() => {});
}
async function unmarkTab(tabId) {
  const set = await getEnabledTabs();
  if (set[tabId]) {
    delete set[tabId];
    await chrome.storage.session.set({ [ENABLED_TABS_KEY]: set }).catch(() => {});
  }
}

// 在指定标签页启用/禁用侧边栏显示
function setPanelEnabled(tabId, enabled) {
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return Promise.resolve();
  return chrome.sidePanel
    .setOptions({
      tabId,
      path: SIDE_PANEL_PATH,
      enabled: !!enabled,
    })
    .catch(() => {});
}

// ---------- 安装 / 启动 ----------
chrome.runtime.onInstalled.addListener(() => {
  // 关键：关闭「点图标即全局打开」，改为我们自己按标签页控制
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch(() => {});
  }
  // 全局默认禁用侧边栏（不指定 tabId），之后按标签页单独启用
  if (chrome.sidePanel && chrome.sidePanel.setOptions) {
    chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  }
  createContextMenus();
});
chrome.runtime.onStartup.addListener(createContextMenus);

// ---------- 点击扩展图标：在当前标签页启用并打开 ----------
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  // open() 必须在用户手势同步栈内调用，放在最前面
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
  // 启用并记录（异步，不影响上面的手势调用）
  setPanelEnabled(tab.id, true);
  markTabEnabled(tab.id);
});

// ---------- 切换标签页：开过的启用、没开过的禁用 ----------
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const set = await getEnabledTabs();
  setPanelEnabled(tabId, !!set[tabId]);
});

// ---------- 标签页关闭：清除记录 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  unmarkTab(tabId);
  // 对话内容由 sidepanel 侧的 conv_<tabId> 负责清理
});

// ---------- 右键菜单「用 Kiro 解释选中内容」----------
function createContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_EXPLAIN,
      title: '用 Kiro 解释选中内容',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus &&
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_EXPLAIN) return;
    const selection = (info.selectionText || '').trim();
    if (!selection || !tab || tab.id == null) return;

    // open() 必须在手势同步栈内调用
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }
    setPanelEnabled(tab.id, true);
    markTabEnabled(tab.id);

    chrome.storage.session
      .set({
        pendingAction: {
          type: 'explain',
          text: selection,
          url: (tab && tab.url) || '',
          ts: Date.now(),
        },
      })
      .catch(() => {});
  });
