interface ServerStatus {
  port: number;
  name?: string;
  wsStatus: 'connected' | 'connecting' | 'waiting';
}

interface Status {
  servers: ServerStatus[];
  currentTabId: number | null;
}

const serversSection = document.getElementById('serversSection')!;
const serverList = document.getElementById('serverList')!;
const gearBtn = document.getElementById('gearBtn')!;
const settingsPanel = document.getElementById('settingsPanel')!;
const newPortInput = document.getElementById('newPort') as HTMLInputElement;
const newNameInput = document.getElementById('newName') as HTMLInputElement;
const addServerBtn = document.getElementById('addServerBtn')!;
const tabTitle = document.getElementById('tabTitle')!;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const focusBtn = document.getElementById('focusBtn') as HTMLButtonElement;

let currentStatus: Status | null = null;
let activeTabId: number | null = null;

function renderServers(servers: ServerStatus[]) {
  if (servers.length === 0) {
    serversSection.innerHTML = '<div class="empty-hint">No servers configured. Add one in settings.</div>';
    return;
  }
  serversSection.innerHTML = servers.map((srv) => {
    const label = srv.name || `Port ${srv.port}`;
    const dotClass = srv.wsStatus === 'connected' ? 'connected' : 'waiting';
    let descText: string;
    let descColor: string;
    if (srv.wsStatus === 'connected') {
      descText = `Connected · ws://localhost:${srv.port}`;
      descColor = '#16a34a';
    } else if (srv.wsStatus === 'connecting') {
      descText = `Connecting · ws://localhost:${srv.port}`;
      descColor = '#2563eb';
    } else {
      descText = `Waiting · ws://localhost:${srv.port}`;
      descColor = '#d97706';
    }
    return `
      <div class="status-row">
        <div class="dot ${dotClass}"></div>
        <div>
          <div class="status-label">${label}</div>
          <div class="status-desc" style="color:${descColor}">${descText}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderSettingsList(servers: ServerStatus[]) {
  if (servers.length === 0) {
    serverList.innerHTML = '';
    return;
  }
  serverList.innerHTML = servers.map((srv) => {
    const label = srv.name ? `${srv.name} · :${srv.port}` : `:${srv.port}`;
    return `
      <div class="server-entry">
        <span class="server-entry-label">${label}</span>
        <button class="remove-btn" data-port="${srv.port}" title="Remove">×</button>
      </div>
    `;
  }).join('');

  serverList.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const port = parseInt((btn as HTMLElement).dataset.port!);
      if (!currentStatus) return;
      const newServers = currentStatus.servers
        .filter((s) => s.port !== port)
        .map((s) => ({ port: s.port, name: s.name }));
      await chrome.runtime.sendMessage({ type: 'SET_SERVERS', servers: newServers });
      await refresh();
    });
  });
}

async function refresh() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = activeTab?.id ?? null;

  const status = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as Status;
  currentStatus = status;

  renderServers(status.servers);
  renderSettingsList(status.servers);

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

addServerBtn.addEventListener('click', async () => {
  const port = parseInt(newPortInput.value);
  if (!port || port < 1024 || port > 65535) return;
  if (!currentStatus) return;
  if (currentStatus.servers.some((s) => s.port === port)) return;

  const name = newNameInput.value.trim() || undefined;
  const newServers = [
    ...currentStatus.servers.map((s) => ({ port: s.port, name: s.name })),
    { port, name },
  ];
  await chrome.runtime.sendMessage({ type: 'SET_SERVERS', servers: newServers });
  newPortInput.value = '';
  newNameInput.value = '';
  await refresh();
});

newPortInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addServerBtn.click();
});

refresh();
setInterval(refresh, 2000);
