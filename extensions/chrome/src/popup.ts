interface Status {
  wsStatus: 'connected' | 'connecting' | 'waiting';
  currentTabId: number | null;
  port: number;
}

const mcpDot = document.getElementById('mcpDot')!;
const mcpDesc = document.getElementById('mcpDesc')!;
const tabTitle = document.getElementById('tabTitle')!;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const focusBtn = document.getElementById('focusBtn') as HTMLButtonElement;
const gearBtn = document.getElementById('gearBtn')!;
const settingsPanel = document.getElementById('settingsPanel')!;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const savePortBtn = document.getElementById('savePortBtn')!;

let currentStatus: Status | null = null;
let activeTabId: number | null = null;
let isEditingPort = false;

async function refresh() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = activeTab?.id ?? null;

  const status = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as Status;
  currentStatus = status;

  if (!isEditingPort) {
    portInput.value = String(status.port);
  }

  // MCP server status
  if (status.wsStatus === 'connected') {
    mcpDot.className = 'dot connected';
    mcpDesc.textContent = `Connected · ws://localhost:${status.port}`;
    mcpDesc.style.color = '#16a34a';
  } else if (status.wsStatus === 'connecting') {
    mcpDot.className = 'dot waiting';
    mcpDesc.textContent = `Connecting to MCP server on :${status.port}`;
    mcpDesc.style.color = '#2563eb';
  } else {
    mcpDot.className = 'dot waiting';
    mcpDesc.textContent = `Waiting for MCP server on :${status.port}`;
    mcpDesc.style.color = '#d97706';
  }

  // Tab connection
  const { currentTabId } = status;

  if (!currentTabId) {
    const title = activeTab?.title ? `"${activeTab.title.substring(0, 38)}"` : 'Current tab';
    tabTitle.textContent = title;
    tabTitle.className = 'tab-title';
    connectBtn.textContent = 'Connect This Tab';
    connectBtn.className = 'btn btn-primary';
    focusBtn.style.display = 'none';
  } else if (currentTabId === activeTabId) {
    tabTitle.textContent = 'This tab is connected';
    tabTitle.className = 'tab-title active';
    connectBtn.textContent = 'Disconnect';
    connectBtn.className = 'btn btn-danger';
    focusBtn.style.display = 'none';
  } else {
    const connectedTab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
      chrome.tabs.get(currentTabId, (tab) => {
        resolve(chrome.runtime.lastError ? null : tab);
      });
    });
    const name = connectedTab?.title
      ? `Connected: "${connectedTab.title.substring(0, 32)}"`
      : 'Connected to another tab';
    tabTitle.textContent = name;
    tabTitle.className = 'tab-title';
    connectBtn.textContent = 'Connect This Tab';
    connectBtn.className = 'btn btn-primary';
    focusBtn.style.display = 'block';
  }
}

connectBtn.addEventListener('click', async () => {
  if (!currentStatus) return;
  if (currentStatus.currentTabId === activeTabId) {
    await chrome.runtime.sendMessage({ type: 'CONNECT_TAB', tabId: null });
  } else {
    await chrome.runtime.sendMessage({ type: 'CONNECT_TAB', tabId: activeTabId });
  }
  await refresh();
});

focusBtn.addEventListener('click', async () => {
  if (currentStatus?.currentTabId) {
    await chrome.tabs.update(currentStatus.currentTabId, { active: true });
    window.close();
  }
});

gearBtn.addEventListener('click', () => {
  settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
});

portInput.addEventListener('focus', () => {
  isEditingPort = true;
});

portInput.addEventListener('blur', () => {
  isEditingPort = false;
});

savePortBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value);
  if (port >= 1024 && port <= 65535) {
    isEditingPort = false;
    await chrome.runtime.sendMessage({ type: 'SET_PORT', port });
    settingsPanel.style.display = 'none';
    await refresh();
  }
});

refresh();
setInterval(refresh, 2000);
