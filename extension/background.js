// 点击扩展图标时，在当前标签页打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error('设置侧边栏行为失败:', err));
  }
  createContextMenus();
});

// service worker 冷启动时也确保菜单存在
chrome.runtime.onStartup.addListener(createContextMenus);

const MENU_EXPLAIN = 'kiro-explain-selection';

function createContextMenus() {
  if (!chrome.contextMenus) return;
  // 先移除旧的，避免重复注册报错
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
    if (!selection) return;

    // 关键：open() 必须在用户手势的同步栈里调用
    if (tab && tab.windowId != null && chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }

    // 把「待处理的解释请求」暂存到 session 存储，侧边栏读取后发起提问。
    // 带时间戳确保每次点击都触发 storage 变化（即便文字相同）。
    chrome.storage.session
      .set({
        pendingAction: {
          type: 'explain',
          text: selection,
          url: (tab && tab.url) || '',
          ts: Date.now(),
        },
      })
      .catch((err) => console.error('暂存右键请求失败:', err));
  });
