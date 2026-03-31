import type { TabInfo, McpCommand, McpResponse, TabsUpdate } from './types';

const DEFAULT_PORT = 9223;
const RECONNECT_INTERVAL = 3000;

let mcpSocket: WebSocket | null = null;
let currentTabId: number | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let configuredPort: number = DEFAULT_PORT;

function getWsStatus(): 'connected' | 'connecting' | 'waiting' {
  if (!mcpSocket) return 'waiting';
  if (mcpSocket.readyState === WebSocket.OPEN) return 'connected';
  if (mcpSocket.readyState === WebSocket.CONNECTING) return 'connecting';
  return 'waiting';
}

async function loadConfig(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['smartwriterPort', 'smartwriterTabId'], async (result) => {
      configuredPort = result.smartwriterPort || DEFAULT_PORT;

      const savedTabId = result.smartwriterTabId as number | undefined;
      if (savedTabId) {
        // Verify the tab still exists before restoring
        try {
          await new Promise<void>((res, rej) => {
            chrome.tabs.get(savedTabId, (tab) => {
              if (chrome.runtime.lastError || !tab) rej();
              else res();
            });
          });
          currentTabId = savedTabId;
        } catch {
          chrome.storage.local.remove('smartwriterTabId');
        }
      }

      resolve();
    });
  });
}

function connectToMcp(): void {
  if (mcpSocket && mcpSocket.readyState !== WebSocket.CLOSED) return;

  mcpSocket = new WebSocket(`ws://localhost:${configuredPort}`);

  mcpSocket.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    sendTabsUpdate();
  };

  mcpSocket.onmessage = async (event: MessageEvent<string>) => {
    try {
      const message = JSON.parse(event.data) as McpCommand;
      if (message.type === 'COMMAND') {
        const result = await handleCommand(message);
        sendMcpResponse({ requestId: message.requestId, result });
      }
    } catch (error) {
      try {
        const msg = JSON.parse(event.data);
        sendMcpResponse({
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // ignore
      }
    }
  };

  mcpSocket.onerror = () => {
    mcpSocket = null;
    scheduleReconnect();
  };

  mcpSocket.onclose = () => {
    mcpSocket = null;
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToMcp();
  }, RECONNECT_INTERVAL);
}

function withCallback<T>(fn: (callback: (result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function evaluateWithDebugger(tabId: number, script: string, args?: unknown[]): Promise<unknown> {
  const target = { tabId };
  const expression = `(async (...__smartwriterArgs) => {${script}
})(...${JSON.stringify(args ?? [])})`;

  await withCallback<void>((callback) => chrome.debugger.attach(target, '1.3', callback));
  try {
    const result = await withCallback<chrome.debugger.EvaluateResult>((callback) =>
      chrome.debugger.sendCommand(
        target,
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        callback
      )
    );

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Unknown evaluation error';
      throw new Error(`Script evaluation failed: ${description}`);
    }

    return result.result?.value;
  } finally {
    try {
      await withCallback<void>((callback) => chrome.debugger.detach(target, callback));
    } catch {
      // Ignore detach errors so the original evaluation failure can surface cleanly.
    }
  }
}

async function handleCommand(message: McpCommand): Promise<unknown> {
  const { command, args } = message;

  if (command === 'GET_TABS') {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        resolve(
          tabs
            .filter((t) => t.id !== undefined)
            .map((t) => ({
              tabId: t.id,
              url: t.url,
              title: t.title,
              active: t.active,
              isConnected: t.id === currentTabId,
            }))
        );
      });
    });
  }

  if (!currentTabId) {
    throw new Error('No tab connected. Click the Smartwriter MCP extension icon to connect a tab.');
  }

  if (command === 'EVALUATE') {
    return evaluateWithDebugger(currentTabId, String(args.script ?? ''), args.args as unknown[] | undefined);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Command timeout: ${command}`)), 30000);
    chrome.tabs.sendMessage(currentTabId!, { type: command, ...args }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || 'Unknown error'));
      }
    });
  });
}

function sendMcpResponse(response: McpResponse): void {
  if (mcpSocket?.readyState === WebSocket.OPEN) {
    mcpSocket.send(JSON.stringify(response));
  }
}

function sendTabsUpdate(): void {
  if (mcpSocket?.readyState !== WebSocket.OPEN) return;
  chrome.tabs.query({}, (tabs) => {
    const update: TabsUpdate = {
      type: 'TABS_UPDATE',
      tabs: tabs.filter((t) => t.id !== undefined).map((t) => ({
        tabId: t.id!,
        url: t.url || '',
        title: t.title || '',
        active: t.active || false,
      })),
      currentTabId,
    };
    mcpSocket!.send(JSON.stringify(update));
  });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'GET_STATUS') {
    sendResponse({
      wsStatus: getWsStatus(),
      currentTabId,
      port: configuredPort,
    });
  } else if (request.type === 'CONNECT_TAB') {
    currentTabId = request.tabId;
    if (currentTabId) {
      chrome.storage.local.set({ smartwriterTabId: currentTabId });
    } else {
      chrome.storage.local.remove('smartwriterTabId');
    }
    sendTabsUpdate();
    sendResponse({ success: true });
  } else if (request.type === 'SET_PORT') {
    configuredPort = request.port;
    chrome.storage.local.set({ smartwriterPort: request.port });
    if (mcpSocket) {
      mcpSocket.close();
      mcpSocket = null;
    }
    setTimeout(connectToMcp, 500);
    sendResponse({ success: true });
  }
});

chrome.tabs.onActivated.addListener(() => sendTabsUpdate());
chrome.tabs.onUpdated.addListener(() => sendTabsUpdate());
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId) {
    currentTabId = null;
    chrome.storage.local.remove('smartwriterTabId');
  }
  sendTabsUpdate();
});

loadConfig().then(() => connectToMcp());
