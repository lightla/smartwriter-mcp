import type { TabInfo, McpCommand, McpResponse, TabsUpdate } from './types';

const DEFAULT_PORT = 9223;
const RECONNECT_INTERVAL = 3000;

type ServerConfig = { port: number; name?: string };
type ConnState = { ws: WebSocket | null; timer: ReturnType<typeof setTimeout> | null };

let currentTabId: number | null = null;
let serverConfigs: ServerConfig[] = [{ port: DEFAULT_PORT }];
const connMap = new Map<number, ConnState>();

function getPortStatus(port: number): 'connected' | 'connecting' | 'waiting' {
  const state = connMap.get(port);
  if (!state?.ws) return 'waiting';
  if (state.ws.readyState === WebSocket.OPEN) return 'connected';
  if (state.ws.readyState === WebSocket.CONNECTING) return 'connecting';
  return 'waiting';
}

async function loadConfig(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['smartwriterServers', 'smartwriterPort', 'smartwriterTabId'], async (result) => {
      if (result.smartwriterServers) {
        serverConfigs = result.smartwriterServers as ServerConfig[];
      } else if (result.smartwriterPort) {
        // migrate from old single-port config
        serverConfigs = [{ port: result.smartwriterPort as number }];
      }

      const savedTabId = result.smartwriterTabId as number | undefined;
      if (savedTabId) {
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
  const anyConnected =
    [...connMap.values()].some((s) => s.ws !== null && s.ws.readyState === WebSocket.OPEN) &&
    currentTabId !== null;
  setIcon(anyConnected);
}

function setIcon(connected: boolean): void {
  const file = connected ? 'icon-on.png' : 'icon-off.png';
  loadIconImageData(file).then((imageDataMap) => {
    chrome.action.setIcon({ imageData: imageDataMap as unknown as ImageData });
  }).catch(() => {});
}

function connectToPort(cfg: ServerConfig): void {
  const { port } = cfg;
  let state = connMap.get(port);
  if (!state) {
    state = { ws: null, timer: null };
    connMap.set(port, state);
  }
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) return;

  const ws = new WebSocket(`ws://localhost:${port}`);
  state.ws = ws;

  ws.onopen = () => {
    if (state!.timer) {
      clearTimeout(state!.timer);
      state!.timer = null;
    }
    updateIcon();
    sendTabsUpdate();
  };

  ws.onmessage = async (event: MessageEvent<string>) => {
    try {
      const message = JSON.parse(event.data) as McpCommand;
      if (message.type === 'COMMAND') {
        const result = await handleCommand(message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ requestId: message.requestId, result } as McpResponse));
        }
      }
    } catch (error) {
      try {
        const msg = JSON.parse(event.data);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            requestId: msg.requestId,
            error: error instanceof Error ? error.message : String(error),
          } as McpResponse));
        }
      } catch {
        // ignore
      }
    }
  };

  ws.onerror = () => {
    if (state!.ws === ws) state!.ws = null;
    updateIcon();
    scheduleReconnect(cfg);
  };

  ws.onclose = () => {
    if (state!.ws === ws) state!.ws = null;
    updateIcon();
    scheduleReconnect(cfg);
  };
}

function scheduleReconnect(cfg: ServerConfig): void {
  const state = connMap.get(cfg.port);
  if (!state || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (serverConfigs.some((s) => s.port === cfg.port)) {
      connectToPort(cfg);
    }
  }, RECONNECT_INTERVAL);
}

function disconnectPort(port: number): void {
  const state = connMap.get(port);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.onerror = null;
    state.ws.close();
    state.ws = null;
  }
  connMap.delete(port);
}

function connectAll(): void {
  for (const cfg of serverConfigs) {
    connectToPort(cfg);
  }
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
              transition: 'left 0.1s ease, top 0.1s ease',
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
    await new Promise((r) => setTimeout(r, 100));

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
      await new Promise((r) => setTimeout(r, 30));
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

function sendTabsUpdate(): void {
  const openStates = [...connMap.values()].filter((s) => s.ws?.readyState === WebSocket.OPEN);
  if (openStates.length === 0) return;
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
    const data = JSON.stringify(update);
    for (const state of openStates) {
      state.ws!.send(data);
    }
  });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'GET_STATUS') {
    sendResponse({
      servers: serverConfigs.map((cfg) => ({
        port: cfg.port,
        name: cfg.name,
        wsStatus: getPortStatus(cfg.port),
      })),
      currentTabId,
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
  } else if (request.type === 'SET_SERVERS') {
    const newConfigs = request.servers as ServerConfig[];
    const newPorts = new Set(newConfigs.map((c: ServerConfig) => c.port));
    for (const cfg of serverConfigs) {
      if (!newPorts.has(cfg.port)) disconnectPort(cfg.port);
    }
    serverConfigs = newConfigs;
    chrome.storage.local.set({ smartwriterServers: serverConfigs });
    for (const cfg of serverConfigs) connectToPort(cfg);
    updateIcon();
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
  if (alarm.name === 'keepalive') connectAll();
});

setIcon(false);
loadConfig().then(() => connectAll());
