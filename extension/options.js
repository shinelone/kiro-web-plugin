'use strict';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

const endpointEl = document.getElementById('endpoint');
const modelEl = document.getElementById('model');
const agentEl = document.getElementById('agent');
const savedEl = document.getElementById('saved');

async function load() {
  const s = await chrome.storage.sync.get(['endpoint', 'model', 'agent']);
  endpointEl.value = s.endpoint || DEFAULT_ENDPOINT;
  modelEl.value = s.model || '';
  agentEl.value = s.agent || '';
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const endpoint = (endpointEl.value.trim() || DEFAULT_ENDPOINT).replace(/\/$/, '');
  await chrome.storage.sync.set({
    endpoint,
    model: modelEl.value.trim(),
    agent: agentEl.value.trim(),
  });
  savedEl.textContent = '已保存 ✓';
  setTimeout(() => (savedEl.textContent = ''), 2000);
});

load();
