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

const iconCache = new Map<string, ImageData>();

async function loadIconImageData(filename: string): Promise<Record<number, ImageData>> {
  const cacheKey = filename;
  if (iconCache.has(cacheKey)) return iconCache.get(cacheKey) as unknown as Record<number, ImageData>;
  const url = chrome.runtime.getURL(filename);
  const resp = await fetch(url);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const sizes = [16, 32, 48, 128];
  const result: Record<number, ImageData> = {};
  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, size, size);
    result[size] = ctx.getImageData(0, 0, size, size);
  }
  iconCache.set(cacheKey, result as unknown as ImageData);
  return result;
}

function updateIcon(): void {
  const fullyConnected =
    mcpSocket !== null &&
    mcpSocket.readyState === WebSocket.OPEN &&
    currentTabId !== null;
  setIcon(fullyConnected);
}

function setIcon(connected: boolean): void {
  const file = connected ? 'icon-on.png' : 'icon-off.png';
  loadIconImageData(file).then((imageDataMap) => {
    chrome.action.setIcon({ imageData: imageDataMap as unknown as ImageData });
  }).catch(() => {});
}

function connectToMcp(): void {
  if (mcpSocket && mcpSocket.readyState !== WebSocket.CLOSED) return;

  mcpSocket = new WebSocket(`ws://localhost:${configuredPort}`);

  mcpSocket.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    updateIcon();
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
    updateIcon();
    scheduleReconnect();
  };

  mcpSocket.onclose = () => {
    mcpSocket = null;
    updateIcon();
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

let attachedDebuggerTabId: number | null = null;

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedDebuggerTabId === tabId) return;
  if (attachedDebuggerTabId !== null) {
    await withCallback<void>((cb) => chrome.debugger.detach({ tabId: attachedDebuggerTabId! }, cb)).catch(() => {});
    attachedDebuggerTabId = null;
  }
  await withCallback<void>((cb) => chrome.debugger.attach({ tabId }, '1.3', cb));
  attachedDebuggerTabId = tabId;
}

async function mouseAction(tabId: number, command: 'HOVER' | 'CLICK', selector: string): Promise<unknown> {
  const target = { tabId };
  await ensureDebuggerAttached(tabId);
  try {
    // Get element center + scroll into view
    const posResult = await withCallback<chrome.debugger.EvaluateResult>((cb) =>
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
        returnByValue: true,
      }, cb)
    );
    const pos = posResult.result?.value as { x: number; y: number } | null;
    if (!pos) throw new Error(`Element not found: ${selector}`);

    // Animate dot from previous position to target
    await withCallback<chrome.debugger.EvaluateResult>((cb) =>
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(() => {
          const DOT_ID = '__sw_cursor__';
          let dot = document.getElementById(DOT_ID);
          if (!dot) {
            dot = document.createElement('div');
            dot.id = DOT_ID;
            Object.assign(dot.style, {
              position: 'fixed', width: '20px', height: '20px', borderRadius: '50%',
              background: 'rgba(99,102,241,0.85)', border: '2px solid white',
              boxShadow: '0 0 8px rgba(99,102,241,0.6)',
              pointerEvents: 'none', zIndex: '2147483647',
              transform: 'translate(-50%,-50%)',
              transition: 'left 0.2s cubic-bezier(.4,0,.2,1), top 0.2s cubic-bezier(.4,0,.2,1)',
            });
            document.body.appendChild(dot);
            dot.style.left = ${pos.x} + 'px';
            dot.style.top = ${pos.y} + 'px';
          }
          requestAnimationFrame(() => {
            dot.style.left = ${pos.x} + 'px';
            dot.style.top = ${pos.y} + 'px';
          });
        })()`,
        returnByValue: false,
      }, cb)
    );

    // Wait for animation
    await new Promise((r) => setTimeout(r, 200));

    if (command === 'CLICK') {
      // Pulse animation on click
      await withCallback<chrome.debugger.EvaluateResult>((cb) =>
        chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(() => {
            const dot = document.getElementById('__sw_cursor__');
            if (dot) {
              dot.style.transition = 'transform 0.1s ease, opacity 0.1s ease';
              dot.style.transform = 'translate(-50%,-50%) scale(1.8)';
              dot.style.opacity = '0.5';
              setTimeout(() => {
                dot.style.transform = 'translate(-50%,-50%) scale(1)';
                dot.style.opacity = '1';
                dot.style.transition = 'left 0.35s cubic-bezier(.4,0,.2,1), top 0.35s cubic-bezier(.4,0,.2,1), transform 0.15s ease, opacity 0.15s ease';
              }, 150);
            }
          })()`,
          returnByValue: false,
        }, cb)
      );
      await new Promise((r) => setTimeout(r, 80));
      await withCallback<void>((cb) =>
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, cb)
      );
      await withCallback<void>((cb) =>
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, cb)
      );
      return { clicked: true, selector, x: pos.x, y: pos.y };
    }

    return { hovered: true, selector, x: pos.x, y: pos.y };
  } catch (e) {
    attachedDebuggerTabId = null;
    await withCallback<void>((cb) => chrome.debugger.detach(target, cb)).catch(() => {});
    throw e;
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

  if (command === 'HOVER' || command === 'CLICK') {
    return mouseAction(currentTabId, command, String(args.selector ?? ''));
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
    updateIcon();
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
    updateIcon();
  }
  sendTabsUpdate();
});

// Keep service worker alive and reconnect WebSocket every 25s
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connectToMcp();
});

setIcon(false);
loadConfig().then(() => connectToMcp());
