import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ContentMessage, TabInfo } from './types';

let currentTabId: number | null = null;
let registeredTabs = new Map<number, TabInfo>();
const MCP_PORT = 9223;
let mcpSocket: WebSocket | null = null;

function initializeWebSocketServer() {
  const wsServer = new WebSocketServer({ port: MCP_PORT });
  console.log('[EXT] WebSocket server listening on port ' + MCP_PORT);

  wsServer.on('connection', (ws: WebSocket) => {
    console.log('[EXT] MCP server connected');
    mcpSocket = ws;

    // Send initial tabs list
    sendTabsUpdate();

    ws.on('message', async (data: Buffer) => {
      try {
        const dataStr = typeof data === 'string' ? data : data.toString();
        const message = JSON.parse(dataStr);
        if (message.type === 'COMMAND') {
          const result = await handleCommand(message);
          ws.send(JSON.stringify({
            requestId: message.requestId,
            result,
          }));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        ws.send(JSON.stringify({
          error: errorMsg,
        }));
      }
    });

    ws.on('close', () => {
      console.log('[EXT] MCP server disconnected');
      mcpSocket = null;
    });

    ws.on('error', (error: Error) => {
      console.error('[EXT] WebSocket error:', error);
    });
  });

  wsServer.on('error', (error: Error) => {
    console.error('[EXT] WebSocket server error:', error);
  });
}

async function handleCommand(message: any): Promise<unknown> {
  const { tabId, command, args } = message;

  if (!tabId) {
    throw new Error('No tab specified');
  }

  const contentMessage: ContentMessage = {
    type: command as any,
    ...args,
  } as ContentMessage;

  return new Promise((resolve, reject) => {
    browser.tabs.sendMessage(tabId, contentMessage).then((response: any) => {
      if (response?.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || 'Unknown error'));
      }
    }).catch((error: any) => {
      reject(new Error(error.message || String(error)));
    });
  });
}

function sendTabsUpdate() {
  if (mcpSocket) {
    mcpSocket.send(JSON.stringify({
      type: 'TABS_UPDATE',
      tabs: Array.from(registeredTabs.values()),
    }));
  }
}

browser.runtime.onMessage.addListener((request: any, sender: any, sendResponse: any) => {
  if (request.type === 'CONNECT_TAB') {
    currentTabId = request.tabId;
    console.log(`[EXT] Connected to tab ${currentTabId}`);
    sendTabsUpdate();
    sendResponse({ success: true, tabId: currentTabId });
  } else if (request.type === 'GET_TABS') {
    browser.tabs.query({}).then((tabs: any[]) => {
      const tabInfos: TabInfo[] = tabs.map((tab: any) => ({
        tabId: tab.id!,
        url: tab.url || '',
        title: tab.title || '',
      }));
      registeredTabs.clear();
      tabInfos.forEach((tab) => registeredTabs.set(tab.tabId, tab));
      sendTabsUpdate();
      sendResponse(tabInfos);
    });
    return true;
  } else if (request.type === 'GET_CURRENT_TAB') {
    sendResponse({ tabId: currentTabId });
  }
  return false;
});

browser.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId === currentTabId) {
    currentTabId = null;
    console.log('[EXT] Current tab was closed');
  }
  registeredTabs.delete(tabId);
  sendTabsUpdate();
});

browser.tabs.onUpdated.addListener((tabId: number, changeInfo: any, tab: any) => {
  if (changeInfo.title || changeInfo.url) {
    const tabInfo: TabInfo = {
      tabId: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
    };
    registeredTabs.set(tabId, tabInfo);
    sendTabsUpdate();
  }
});

console.log('[EXT] Smartwriter MCP extension loaded');
initializeWebSocketServer();
