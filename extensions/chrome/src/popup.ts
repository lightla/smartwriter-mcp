interface ServerStatus {
  port: number;
  name?: string;
  wsStatus: 'connected' | 'connecting' | 'waiting';
}

interface Status {
  servers: ServerStatus[];
  currentTabId: number | null;
  trackingActive: boolean;
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
const trackingBtn = document.getElementById('trackingBtn') as HTMLButtonElement;
const trackingHint = document.getElementById('trackingHint')!;

let currentStatus: Status | null = null;
let activeTabId: number | null = null;
let isEditingServer = false;

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
  if (isEditingServer) return;
  if (servers.length === 0) {
    serverList.innerHTML = '';
    return;
  }

  serverList.innerHTML = servers.map((srv) => `
    <div class="server-entry" data-port="${srv.port}" title="Double-click to edit">
      <input class="entry-port" type="number" value="${srv.port}" min="1024" max="65535" readonly tabindex="-1" />
      <input class="entry-name" type="text" value="${srv.name ?? ''}" placeholder="name (optional)" readonly tabindex="-1" />
      <button class="remove-btn" title="Remove">×</button>
    </div>
  `).join('');

  serverList.querySelectorAll<HTMLElement>('.server-entry').forEach((entry) => {
    const origPort = parseInt(entry.dataset.port!);
    const portInput = entry.querySelector<HTMLInputElement>('.entry-port')!;
    const nameInput = entry.querySelector<HTMLInputElement>('.entry-name')!;
    const origName = servers.find((s) => s.port === origPort)?.name ?? '';

    const startEdit = (focusTarget: HTMLInputElement) => {
      if (entry.classList.contains('editing')) return;
      isEditingServer = true;
      entry.classList.add('editing');
      portInput.removeAttribute('readonly');
      portInput.tabIndex = 0;
      nameInput.removeAttribute('readonly');
      nameInput.tabIndex = 0;
      focusTarget.focus();
      focusTarget.select();
    };

    const cancelEdit = () => {
      entry.classList.remove('editing');
      portInput.setAttribute('readonly', '');
      portInput.tabIndex = -1;
      nameInput.setAttribute('readonly', '');
      nameInput.tabIndex = -1;
      portInput.value = String(origPort);
      nameInput.value = origName;
      isEditingServer = false;
    };

    const applyEdit = async () => {
      entry.classList.remove('editing');
      portInput.setAttribute('readonly', '');
      portInput.tabIndex = -1;
      nameInput.setAttribute('readonly', '');
      nameInput.tabIndex = -1;
      isEditingServer = false;

      const newPort = parseInt(portInput.value);
      const newName = nameInput.value.trim() || undefined;

      if (!currentStatus || !newPort || newPort < 1024 || newPort > 65535) {
        portInput.value = String(origPort);
        nameInput.value = origName;
        return;
      }
      if (newPort !== origPort && currentStatus.servers.some((s) => s.port === newPort)) {
        portInput.value = String(origPort);
        return;
      }
      const unchanged = newPort === origPort && (newName ?? '') === origName;
      if (unchanged) return;

      const newServers = currentStatus.servers.map((s) =>
        s.port === origPort ? { port: newPort, name: newName } : { port: s.port, name: s.name }
      );
      await chrome.runtime.sendMessage({ type: 'SET_SERVERS', servers: newServers });
      await refresh();
    };

    entry.addEventListener('dblclick', (e) => {
      const clicked = e.target as HTMLElement;
      startEdit(clicked.closest('.entry-name') ? nameInput : portInput);
    });

    // focusout on the whole entry — fires when focus leaves to outside
    entry.addEventListener('focusout', async (e) => {
      if (!entry.classList.contains('editing')) return;
      const next = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (!entry.contains(next)) await applyEdit();
    });

    portInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); portInput.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });

    entry.querySelector('.remove-btn')!.addEventListener('click', async () => {
      isEditingServer = false;
      if (!currentStatus) return;
      const newServers = currentStatus.servers
        .filter((s) => s.port !== origPort)
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
    trackingBtn.style.display = 'none';
    trackingHint.style.display = 'none';
  } else if (currentTabId === activeTabId) {
    tabTitle.textContent = 'This tab is connected';
    tabTitle.className = 'tab-title active';
    connectBtn.textContent = 'Disconnect';
    connectBtn.className = 'btn btn-danger';
    focusBtn.style.display = 'none';
    updateTrackingButton(status.trackingActive);
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
    updateTrackingButton(status.trackingActive);
  }
}

function updateTrackingButton(active: boolean): void {
  trackingBtn.style.display = 'block';
  if (active) {
    trackingBtn.textContent = 'Tracking ON';
    trackingBtn.className = 'btn btn-track active';
    trackingHint.style.display = 'block';
  } else {
    trackingBtn.textContent = 'Enable Tracking';
    trackingBtn.className = 'btn btn-track';
    trackingHint.style.display = 'none';
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

trackingBtn.addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE_TRACKING' }) as { active: boolean };
  updateTrackingButton(resp.active);
  if (currentStatus) currentStatus.trackingActive = resp.active;
});

refresh();
setInterval(refresh, 2000);
