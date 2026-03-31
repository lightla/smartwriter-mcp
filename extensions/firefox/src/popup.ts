import type { TabInfo } from './types';

async function loadTabs() {
  const tabsList = document.getElementById('tabsList') as HTMLElement;
  const status = document.getElementById('status') as HTMLElement;

  try {
    const tabs = await browser.runtime.sendMessage({ type: 'GET_TABS' }) as any[];
    const currentResponse = await browser.runtime.sendMessage({ type: 'GET_CURRENT_TAB' }) as any;
    const currentTabId = currentResponse?.tabId;

    if (!tabs || tabs.length === 0) {
      tabsList.innerHTML = '<p style="text-align: center; color: #999; padding: 20px;">No tabs</p>';
      return;
    }

    if (currentTabId) {
      status.innerHTML = '<p style="margin: 0; font-weight: 500;">Connected</p>';
      status.className = 'status connected';
    }

    const tabsHtml = tabs
      .map(
        (tab: TabInfo) => `
      <div class="tab-item ${tab.tabId === currentTabId ? 'current' : ''}">
        <div class="tab-item-info">
          <div class="tab-item-title">${escapeHtml(tab.title || 'Untitled')}</div>
          <div class="tab-item-url">${escapeHtml(tab.url)}</div>
        </div>
        <button class="btn ${tab.tabId === currentTabId ? 'btn-disconnect' : 'btn-connect'}" data-tab-id="${tab.tabId}">
          ${tab.tabId === currentTabId ? 'Connected' : 'Connect'}
        </button>
      </div>
    `
      )
      .join('');

    tabsList.innerHTML = tabsHtml;

    document.querySelectorAll('[data-tab-id]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const tabId = parseInt((e.target as HTMLButtonElement).dataset.tabId!);
        await connectToTab(tabId);
      });
    });
  } catch (error) {
    tabsList.innerHTML = '<p style="color: #c00; padding: 12px; text-align: center;">Error loading tabs</p>';
  }
}

async function connectToTab(tabId: number) {
  try {
    const response = await browser.runtime.sendMessage({ type: 'CONNECT_TAB', tabId }) as any;
    if (response?.success) {
      await loadTabs();
    }
  } catch (error) {
    console.error('Error connecting:', error);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function updateWSStatus() {
  const wsStatus = document.getElementById('ws-status');
  try {
    const ws = new WebSocket('ws://localhost:9223');
    ws.onopen = () => {
      wsStatus!.textContent = 'Connected';
      wsStatus!.style.color = '#22c55e';
      ws.close();
    };
    ws.onerror = () => {
      wsStatus!.textContent = 'Not running';
      wsStatus!.style.color = '#ef4444';
    };
    setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        wsStatus!.textContent = 'Connecting...';
        wsStatus!.style.color = '#f59e0b';
      }
    }, 2000);
  } catch (error) {
    wsStatus!.textContent = 'Not running';
    wsStatus!.style.color = '#ef4444';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadTabs();
  updateWSStatus();
  setInterval(loadTabs, 2000);
});
