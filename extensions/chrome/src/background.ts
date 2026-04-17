import type { Annotation, TabInfo, McpCommand, McpResponse, TabsUpdate } from './types';

const DEFAULT_PORT = 9223;
const RECONNECT_INTERVAL = 3000;

type ServerConfig = { port: number; name?: string };
type ConnState = { ws: WebSocket | null; timer: ReturnType<typeof setTimeout> | null };
type DebuggerEvaluateResult = {
  result?: { value?: unknown };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
};

let connectedTabId: number | null = null;
let serverConfigs: ServerConfig[] = [{ port: DEFAULT_PORT }];
let tabFlowEnabled = false;
let flowTabs: number[] = [];
let trackingTabIds: number[] = []; 
const connMap = new Map<number, ConnState>();

let isLoaded = false;
const loadPromise = loadConfig().then(() => { isLoaded = true; });
const ANNOTATION_MARKER_PREFIX = 'a:';
const LEGACY_ELEMENT_REF_PREFIX = 'el:';
const SELECTOR_COMMANDS = new Set([
  'TYPE',
  'FILL',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'GET_SNAPSHOT',
  'GET_TEXT',
  'GET_ATTRIBUTE',
]);

type ResolvedSelector = {
  selector: string;
  originalSelector: string;
  marker?: string;
  index?: number;
};

type IndexedAnnotation = {
  annotation: Annotation;
  index: number;
};

type ResolvedAnnotationElement = {
  annotation: Annotation;
  index: number;
  marker: string;
  found: boolean;
  selector?: string;
  element?: {
    tag: string;
    text?: string;
    rect: { x: number; y: number; width: number; height: number };
    visible: boolean;
    disabled?: boolean;
  };
  currentUrl?: string;
  urlMatchesCurrentTab: boolean;
};

function getPortStatus(port: number): 'connected' | 'connecting' | 'waiting' {
  const state = connMap.get(port);
  if (!state?.ws) return 'waiting';
  if (state.ws.readyState === WebSocket.OPEN) return 'connected';
  if (state.ws.readyState === WebSocket.CONNECTING) return 'connecting';
  return 'waiting';
}

function annotationMatchesType(annotation: Annotation, type?: string): boolean {
  if (!type) return true;
  return annotation.type === type;
}

function getAnnotationMarker(index: number): string {
  return `${ANNOTATION_MARKER_PREFIX}${index}`;
}

function parseAnnotationMarker(value: string | undefined): number | null {
  if (!value) return null;
  if (value.startsWith(ANNOTATION_MARKER_PREFIX)) return parseAnnotationIndex(value.slice(ANNOTATION_MARKER_PREFIX.length));
  if (value.startsWith(LEGACY_ELEMENT_REF_PREFIX)) return parseAnnotationIndex(value.slice(LEGACY_ELEMENT_REF_PREFIX.length));
  return null;
}

function parseAnnotationIndex(value: unknown): number | null {
  if (typeof value !== 'number' && !/^\d+$/.test(String(value))) return null;
  const index = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(index) || index < 1) return null;
  return index;
}

function readAnnotations(): Promise<Annotation[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get('smartwriterAnnotations', (result) => {
      const annotations = ((result.smartwriterAnnotations || []) as Array<Annotation & { severity?: unknown }>).map(
        ({ severity: _severity, ...annotation }) => annotation as Annotation
      );
      resolve(annotations);
    });
  });
}

function getIndexedAnnotations(annotations: Annotation[], url?: string, type?: string): IndexedAnnotation[] {
  return annotations
    .map((annotation, i) => ({ annotation, index: i + 1 }))
    .filter(({ annotation }) => {
      if (url && annotation.url !== url) return false;
      return annotationMatchesType(annotation, type);
    });
}

async function getAnnotationUrlFilter(args: { url?: string; all?: boolean }): Promise<string | undefined> {
  if (args.all) return undefined;
  if (args.url) return args.url;
  if (!connectedTabId) return undefined;
  return (await getTab(connectedTabId))?.url;
}

function sortIndexedAnnotations(rows: IndexedAnnotation[]): IndexedAnnotation[] {
  return [...rows].sort((a, b) => a.index - b.index);
}

function formatAnnotationSummaries(rows: IndexedAnnotation[]): string {
  const lines = sortIndexedAnnotations(rows).map(({ annotation, index }) => {
    const note = (annotation.note ?? '').replace(/\r?\n/g, '\\n');
    return `${getAnnotationMarker(index)}|${annotation.type}|${note}`;
  });
  return ['id|type|note', ...lines].join('\n');
}

function deleteAnnotationFromList(
  annotations: Annotation[],
  args: { index?: number | string; id?: string }
): { kept: Annotation[]; deleted: boolean; index?: number; id?: string } {
  const markerIndex = args.id ? parseAnnotationMarker(args.id) : null;
  if (args.index !== undefined || markerIndex !== null) {
    const index = markerIndex ?? parseAnnotationIndex(args.index);
    if (index === null) {
      throw new Error(`Invalid annotation index: ${String(args.index)}`);
    }
    const zeroBased = index - 1;
    if (zeroBased < 0 || zeroBased >= annotations.length) {
      return { kept: annotations, deleted: false, index };
    }
    return {
      kept: annotations.filter((_, i) => i !== zeroBased),
      deleted: true,
      index,
      id: annotations[zeroBased]?.id,
    };
  }

  if (args.id) {
    const kept = annotations.filter((annotation) => annotation.id !== args.id);
    return { kept: kept, deleted: kept.length !== annotations.length, id: args.id };
  }

  throw new Error('Missing index');
}

async function getAnnotationByIndex(indexValue: unknown): Promise<IndexedAnnotation> {
  const index = parseAnnotationIndex(indexValue);
  if (index === null) {
    throw new Error(`Invalid annotation index: ${String(indexValue)}`);
  }

  const annotations = await readAnnotations();
  const annotation = annotations[index - 1];
  if (!annotation) {
    throw new Error(`Annotation not found at index: ${index}`);
  }
  return { annotation, index };
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(chrome.runtime.lastError ? null : tab);
    });
  });
}

async function loadConfig(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'smartwriterServers', 
      'smartwriterPort', 
      'smartwriterTabId', 
      'smartwriterTabFlow',
      'smartwriterFlowTabs',
      'smartwriterTrackingTabs'
    ], async (result) => {
      if (result.smartwriterTabFlow !== undefined) {
        tabFlowEnabled = !!result.smartwriterTabFlow;
      }
      
      if (result.smartwriterFlowTabs) {
        flowTabs = result.smartwriterFlowTabs as number[];
      }
      
      if (result.smartwriterTrackingTabs) {
        trackingTabIds = result.smartwriterTrackingTabs as number[];
      }

      if (result.smartwriterServers) {
        serverConfigs = result.smartwriterServers as ServerConfig[];
      } else if (result.smartwriterPort) {
        serverConfigs = [{ port: result.smartwriterPort as number }];
      }

      const savedTabId = result.smartwriterTabId as number | undefined;
      if (savedTabId) {
        try {
          // Verify tab still exists
          await chrome.tabs.get(savedTabId);
          connectedTabId = savedTabId;
        } catch {
          connectedTabId = null;
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
    connectedTabId !== null;
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

function withCallback<T>(fn: (callback: (result?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result as T);
    });
  });
}

async function evaluateWithDebugger(tabId: number, script: string, args?: unknown[]): Promise<unknown> {
  const target = { tabId };
  const argBindings = (args ?? [])
    .map((_, i) => `const arg${i} = __smartwriterArgs[${i}];`)
    .join('\n');
  const expression = `(async (...__smartwriterArgs) => {
${argBindings}
${script}
})(...${JSON.stringify(args ?? [])})`;

  await ensureDebuggerAttached(tabId);
  return evaluateInAttachedDebugger(target, expression, true);
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

async function evaluateInAttachedDebugger(
  target: chrome.debugger.Debuggee,
  expression: string,
  returnByValue: boolean
): Promise<unknown> {
  const result = await withCallback<DebuggerEvaluateResult>((callback) =>
    chrome.debugger.sendCommand(
      target,
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue,
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
}

async function resolveAnnotationElement(tabId: number, indexValue: unknown): Promise<ResolvedAnnotationElement> {
  const { annotation, index } = await getAnnotationByIndex(indexValue);
  const tab = await getTab(tabId);
  const marker = getAnnotationMarker(index);
  const selectors = [annotation.selectors?.primary, annotation.selectors?.cssPath].filter(Boolean);

  const expression = `(() => {
    const selectors = ${JSON.stringify(selectors)};
    let element = null;
    let matchedSelector = null;
    for (const selector of selectors) {
      try {
        element = document.querySelector(selector);
        if (element) {
          matchedSelector = selector;
          break;
        }
      } catch (_) {}
    }
    if (!element) return { found: false };
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      found: true,
      selector: matchedSelector,
      element: {
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || '').trim().slice(0, 200) || undefined,
        rect: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        disabled: 'disabled' in element ? Boolean(element.disabled) : undefined,
      },
    };
  })()`;

  await ensureDebuggerAttached(tabId);
  const resolved = (await evaluateInAttachedDebugger({ tabId }, expression, true)) as
    | { found: false }
    | {
        found: true;
        selector: string;
        element: ResolvedAnnotationElement['element'];
      };

  return {
    annotation,
    index,
    marker,
    found: resolved.found,
    selector: resolved.found ? resolved.selector : undefined,
    element: resolved.found ? resolved.element : undefined,
    currentUrl: tab?.url,
    urlMatchesCurrentTab: tab?.url === annotation.url,
  };
}

async function resolveSelectorArgument(tabId: number, selector: string): Promise<ResolvedSelector> {
  const index = parseAnnotationMarker(selector);
  if (index === null) {
    return { selector, originalSelector: selector };
  }

  const resolved = await resolveAnnotationElement(tabId, index);
  if (!resolved.found || !resolved.selector) {
    throw new Error(`Element not found for index: ${index}`);
  }

  return {
    selector: resolved.selector,
    originalSelector: selector,
    marker: resolved.marker,
    index,
  };
}

function scrubSelectorResult(result: unknown, resolved: ResolvedSelector): unknown {
  if (!resolved.index || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  return {
    ...(result as Record<string, unknown>),
    selector: resolved.marker,
    marker: resolved.marker,
    index: resolved.index,
  };
}

function sanitizeSelectorError(error: unknown, resolved: ResolvedSelector): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (!resolved.index) return new Error(raw);
  const sanitized = raw.split(resolved.selector).join(resolved.marker ?? resolved.originalSelector);
  return new Error(sanitized);
}

async function sendContentCommand(tabId: number | null, command: string, args: Record<string, unknown>): Promise<unknown> {
  if (tabId === null) {
    throw new Error('No tab connected. Open Chrome, click the Smartwriter MCP extension icon, and connect a tab.');
  }

  // Inject flow marker if toggling tracking
  if (command === 'TOGGLE_TRACKING' && args.active) {
    args.flowMarker = getFlowMarker(tabId) ?? undefined;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Command timeout: ${command}`)), 30000);
    chrome.tabs.sendMessage(tabId, { type: command, ...args }, (response) => {
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

async function mouseAction(tabId: number, command: 'HOVER' | 'CLICK', selector: string): Promise<unknown> {
  const target = { tabId };
  await ensureDebuggerAttached(tabId);
  try {
    // Get element center + scroll into view
    const posResult = await withCallback<DebuggerEvaluateResult>((cb) =>
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
    await withCallback<DebuggerEvaluateResult>((cb) =>
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(() => {
          const DOT_ID = '__sw_cursor__';
          let dot = document.getElementById(DOT_ID);
          if (!dot) {
            dot = document.createElement('div');
            dot.id = DOT_ID;
            Object.assign(dot.style, {
              position: 'fixed', width: '20px', height: '20px', borderRadius: '50%',
              background: '#a6d0c4', border: '2px solid #116466',
              boxShadow: '0 0 0 4px rgba(17,100,102,0.18)',
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
      await withCallback<DebuggerEvaluateResult>((cb) =>
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
      await withCallback<unknown>((cb) =>
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, cb)
      );
      await withCallback<unknown>((cb) =>
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

function getFlowMarker(tabId: number): string | null {
  const idx = flowTabs.indexOf(tabId);
  return idx !== -1 ? `t:${idx + 1}` : null;
}

function parseFlowMarker(value: string): number | null {
  if (!value.startsWith('t:')) return null;
  const idx = parseInt(value.slice(2), 10) - 1;
  return (idx >= 0 && idx < flowTabs.length) ? flowTabs[idx] : null;
}

function internalConnectTab(tabId: number): void {
  // IDEMPOTENCY CHECK: If already connected and tracking this EXACT tab, do nothing.
  const alreadyTracking = trackingTabIds.includes(tabId);
  const alreadyConnected = (connectedTabId === tabId);
  
  if (alreadyConnected && alreadyTracking) {
    return; 
  }

  // SCIENTIFIC PROTOCOL: Persistent state management
  if (!tabFlowEnabled) {
    // Single Mode: Notify others to stop
    for (const oldId of trackingTabIds) {
      if (oldId !== tabId) {
        chrome.tabs.sendMessage(oldId, { type: 'TOGGLE_TRACKING', active: false }).catch(() => {});
      }
    }
    trackingTabIds = [];
    flowTabs = [];
  }

  if (!flowTabs.includes(tabId)) flowTabs.push(tabId);
  connectedTabId = tabId;
  if (!trackingTabIds.includes(tabId)) trackingTabIds.push(tabId);
  
  // Persist all connection state
  chrome.storage.local.set({ 
    smartwriterTabId: connectedTabId,
    smartwriterFlowTabs: flowTabs,
    smartwriterTrackingTabs: trackingTabIds
  });

  const marker = getFlowMarker(tabId);
  chrome.tabs.sendMessage(tabId, { 
    type: 'TOGGLE_TRACKING', 
    active: true,
    flowMarker: marker ?? undefined
  }).catch(() => {});
  
  updateIcon();
  sendTabsUpdate();
}

function internalDisconnectTab(tabId: number): void {
  flowTabs = flowTabs.filter(id => id !== tabId);
  trackingTabIds = trackingTabIds.filter(id => id !== tabId);
  if (connectedTabId === tabId) {
    connectedTabId = null;
  }
  
  chrome.storage.local.set({ 
    smartwriterTabId: connectedTabId,
    smartwriterFlowTabs: flowTabs,
    smartwriterTrackingTabs: trackingTabIds
  });

  chrome.tabs.sendMessage(tabId, { 
    type: 'TOGGLE_TRACKING', 
    active: false,
    flowMarker: undefined
  }).catch(() => {});
  
  updateIcon();
  sendTabsUpdate();
}

async function handleCommand(message: McpCommand): Promise<unknown> {
  const { command, args } = message;

  switch (command) {
    case 'GET_TABS':
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
                isConnected: t.id === connectedTabId,
              }))
          );
        });
      });

    case 'GET_ANNOTATIONS': {
      const { url, type, all } = args as { url?: string; type?: string; all?: boolean };
      const urlFilter = await getAnnotationUrlFilter({ url, all });
      return sortIndexedAnnotations(getIndexedAnnotations(await readAnnotations(), urlFilter, type)).map(({ annotation }) => annotation);
    }

    case 'GET_SUMMARY_ANOTATIONS':
    case 'GET_ANNOTATION_SUMMARIES': {
      const { url, type, all } = args as { url?: string; type?: string; all?: boolean };
      const urlFilter = await getAnnotationUrlFilter({ url, all });
      return formatAnnotationSummaries(getIndexedAnnotations(await readAnnotations(), urlFilter, type));
    }

    case 'CLEAR_ANNOTATIONS': {
      const { url, all } = args as { url?: string; all?: boolean };
      const urlFilter = await getAnnotationUrlFilter({ url, all });
      return new Promise((resolve) => {
        chrome.storage.local.get('smartwriterAnnotations', (result) => {
          const annotations = (result.smartwriterAnnotations || []) as Annotation[];
          const kept = urlFilter ? annotations.filter((annotation) => annotation.url !== urlFilter) : [];
          const deletedCount = annotations.length - kept.length;
          chrome.storage.local.set({ smartwriterAnnotations: kept }, () => {
            resolve(['cleared|scope|count', `true|${urlFilter ?? 'all'}|${deletedCount}`].join('\n'));
          });
        });
      });
    }

    case 'DELETE_ANNOTATION':
      return new Promise((resolve) => {
        chrome.storage.local.get('smartwriterAnnotations', (result) => {
          const annotations = (result.smartwriterAnnotations || []) as Annotation[];
          const deleted = deleteAnnotationFromList(annotations, args as { index?: number | string; id?: string });
          chrome.storage.local.set({ smartwriterAnnotations: deleted.kept }, () => {
            resolve(['deleted', deleted.deleted ? 'true' : 'false'].join('\n'));
          });
        });
      });

    case 'DISCONNECT_TAB': {
      const selector = args.tabId ? String(args.tabId) : '';
      let targetId = connectedTabId;
      if (selector) {
        targetId = selector.startsWith('t:') ? parseFlowMarker(selector) : parseInt(selector, 10);
      }
      if (targetId) {
        internalDisconnectTab(targetId);
      } else if (connectedTabId) {
        internalDisconnectTab(connectedTabId);
      }
      return { success: true };
    }

    case 'CONNECT_TAB': {
      const selector = args.tabId ? String(args.tabId) : '';
      if (!selector) {
        if (connectedTabId) internalDisconnectTab(connectedTabId);
        return { success: true, connected: false };
      }
      const targetId = selector.startsWith('t:') ? parseFlowMarker(selector) : parseInt(selector, 10);
      if (!targetId || isNaN(targetId)) throw new Error(`Invalid tab target: ${selector}`);
      
      // SERVER COMMAND logic: Connect if not already the active target
      if (connectedTabId !== targetId) {
        internalConnectTab(targetId);
      }
      return { success: true, connectedTabId: targetId, flowMarker: getFlowMarker(targetId) };
    }

    case 'EVALUATE': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const { marker, elementId, index } = args as { marker?: string; elementId?: string; index?: number | string };
      let script = String(args.script ?? '');
      let ref = marker ?? elementId;
      if (!ref && index !== undefined) {
        const parsedIndex = parseAnnotationIndex(index);
        if (parsedIndex !== null) ref = getAnnotationMarker(parsedIndex);
      }
      if (ref) {
        const resolved = await resolveSelectorArgument(connectedTabId, ref);
        script = `const element = document.querySelector(${JSON.stringify(resolved.selector)});
if (!element) throw new Error(${JSON.stringify(`Element not found for index: ${resolved.index}`)});
${script}`;
      }
      return evaluateWithDebugger(connectedTabId, script, args.args as unknown[] | undefined);
    }

    case 'HOVER':
    case 'CLICK': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const resolved = await resolveSelectorArgument(connectedTabId, String(args.selector ?? ''));
      try {
        const result = await mouseAction(connectedTabId, command, resolved.selector);
        return scrubSelectorResult(result, resolved);
      } catch (error) {
        throw sanitizeSelectorError(error, resolved);
      }
    }

    case 'GET_FLOW_TAB_IDS':
      return tabFlowEnabled ? flowTabs.map((id, i) => `t:${i + 1}`).join(', ') : '';

    case 'JUMP_CONNECTED_TAB':
      if (!connectedTabId) throw new Error('No tab connected.');
      await chrome.tabs.update(connectedTabId, { active: true });
      return { success: true, connectedTabId };

    default:
      if (connectedTabId && SELECTOR_COMMANDS.has(command) && typeof args.selector === 'string') {
        const resolved = await resolveSelectorArgument(connectedTabId, args.selector);
        try {
          const result = await sendContentCommand(connectedTabId, command, { ...args, selector: resolved.selector });
          return scrubSelectorResult(result, resolved);
        } catch (error) {
          throw sanitizeSelectorError(error, resolved);
        }
      }
      return sendContentCommand(connectedTabId, command, args);
  }
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
      connectedTabId,
    };
    const data = JSON.stringify(update);
    for (const state of openStates) {
      state.ws!.send(data);
    }
  });
}

async function onMessageHandler(request: any, _sender: chrome.runtime.MessageSender): Promise<any> {
  const type = request.type as string;

  switch (type) {
    case 'HANDSHAKE':
    case 'GET_STATUS': {
      const senderTabId = _sender.tab?.id ?? null;
      return {
        tabFlowEnabled,
        isTracking: senderTabId !== null && trackingTabIds.includes(senderTabId),
        flowMarker: senderTabId !== null ? getFlowMarker(senderTabId) : null,
        connectedTabId,
        trackingActive: connectedTabId !== null && trackingTabIds.includes(connectedTabId),
        servers: serverConfigs.map((cfg) => ({
          port: cfg.port,
          wsStatus: getPortStatus(cfg.port),
        })),
      };
    }

    case 'GET_TRACKING_STATE': {
      const tabId = _sender.tab?.id ?? null;
      return { active: tabId !== null && trackingTabIds.includes(tabId) };
    }

    case 'STOP_TRACKING_FROM_CONTENT': {
      const senderTabId = _sender.tab?.id;
      if (senderTabId != null) {
        trackingTabIds = trackingTabIds.filter(id => id !== senderTabId);
        chrome.storage.local.set({ smartwriterTrackingTabs: trackingTabIds });
      }
      return { success: true };
    }

    case 'GET_FLOW_MARKER': {
      const senderTabId = _sender.tab?.id;
      return { flowMarker: senderTabId ? getFlowMarker(senderTabId) : null };
    }

    case 'TAB_FLOW_CHANGED': {
      tabFlowEnabled = !!request.enabled;
      
      // SCIENTIFIC RESET: Clear all connection and tracking state for a clean slate when switching modes
      const oldTrackingIds = [...trackingTabIds];
      flowTabs = [];
      trackingTabIds = [];
      connectedTabId = null;
      
      // Notify all tabs that were previously tracking to stop immediately
      for (const id of oldTrackingIds) {
        chrome.tabs.sendMessage(id, { type: 'TOGGLE_TRACKING', active: false }).catch(() => {});
      }
      
      chrome.storage.local.set({ 
        smartwriterTabFlow: tabFlowEnabled,
        smartwriterFlowTabs: flowTabs,
        smartwriterTrackingTabs: trackingTabIds,
        smartwriterTabId: connectedTabId
      });

      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { 
              type: 'TAB_FLOW_STATE_CHANGE', 
              enabled: tabFlowEnabled,
              flowMarker: undefined // Strictly no marker after mode change
            }).catch(() => {});
          }
        }
      });

      updateIcon();
      sendTabsUpdate();
      return { success: true };
    }

    case 'TOGGLE_TRACKING': {
      if (connectedTabId === null) {
        return { success: false, error: 'No tab connected' };
      }
      if (trackingTabIds.includes(connectedTabId)) {
        trackingTabIds = trackingTabIds.filter(id => id !== connectedTabId);
        chrome.tabs.sendMessage(connectedTabId, { type: 'TOGGLE_TRACKING', active: false }).catch(() => {});
      } else {
        if (!trackingTabIds.includes(connectedTabId)) trackingTabIds.push(connectedTabId);
        chrome.tabs.sendMessage(connectedTabId, { 
          type: 'TOGGLE_TRACKING', 
          active: true,
          flowMarker: getFlowMarker(connectedTabId) ?? undefined
        }).catch(() => {});
      }
      chrome.storage.local.set({ smartwriterTrackingTabs: trackingTabIds });
      return { success: true, active: trackingTabIds.includes(connectedTabId) };
    }

    case 'TOGGLE_FLOW_TAB': {
      let targetTabId = request.tabId;
      if (!targetTabId && _sender.tab?.id) targetTabId = _sender.tab.id;
      if (targetTabId) {
        if (flowTabs.includes(targetTabId)) {
          internalDisconnectTab(targetTabId);
          return { success: true, connected: false };
        } else {
          internalConnectTab(targetTabId);
          return { success: true, connected: true, flowMarker: getFlowMarker(targetTabId) };
        }
      } else {
        return { success: false, error: 'Unknown tab' };
      }
    }

    case 'CONNECT_TAB':
    case 'DISCONNECT_TAB': {
      const targetId = request.tabId;
      if (!targetId) {
        if (connectedTabId !== null) internalDisconnectTab(connectedTabId);
        return { success: true, connected: false };
      } else {
        internalConnectTab(targetId);
        return { success: true, connected: true, connectedTabId: targetId };
      }
    }

    case 'SET_SERVERS': {
      const newConfigs = request.servers as ServerConfig[];
      const newPorts = new Set(newConfigs.map((c: ServerConfig) => c.port));
      for (const cfg of serverConfigs) {
        if (!newPorts.has(cfg.port)) disconnectPort(cfg.port);
      }
      serverConfigs = newConfigs;
      chrome.storage.local.set({ smartwriterServers: serverConfigs });
      for (const cfg of serverConfigs) connectToPort(cfg);
      updateIcon();
      return { success: true };
    }

    case 'COMMAND': {
      return await handleCommand(request as unknown as McpCommand);
    }

    default:
      return false;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isLoaded) {
    loadPromise.then(() => onMessageHandler(request, sender).then(sendResponse));
    return true;
  }
  onMessageHandler(request, sender).then(sendResponse);
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // If in Tab Flow mode and switching to a flow tab, update connected ID
  if (tabFlowEnabled && flowTabs.includes(tabId)) {
    connectedTabId = tabId;
    chrome.storage.local.set({ smartwriterTabId: connectedTabId });
  }
  sendTabsUpdate();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Re-inject tracking widget after navigation if it was active
  if (changeInfo.status === 'complete' && trackingTabIds.includes(tabId)) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { 
        type: 'TOGGLE_TRACKING', 
        active: true,
        flowMarker: getFlowMarker(tabId) ?? undefined
      }).catch(() => {});
    }, 400);
  }
  sendTabsUpdate();
});

chrome.storage.onChanged.addListener((changes) => {
  // External sync: Background memory MUST follow Storage source of truth
  let needsBroadcast = false;
  if (changes.smartwriterTabFlow) {
    tabFlowEnabled = !!changes.smartwriterTabFlow.newValue;
    needsBroadcast = true;
  }
  if (changes.smartwriterFlowTabs) {
    flowTabs = changes.smartwriterFlowTabs.newValue || [];
    needsBroadcast = true;
  }
  if (changes.smartwriterTrackingTabs) {
    trackingTabIds = changes.smartwriterTrackingTabs.newValue || [];
    needsBroadcast = true;
  }

  if (needsBroadcast) {
    // SCIENTIFIC BROADCAST: Notify every single tab about the state change
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { 
            type: 'TAB_FLOW_STATE_CHANGE', 
            enabled: tabFlowEnabled, 
            flowMarker: getFlowMarker(tab.id) ?? undefined 
          }).catch(() => {});
          
          // Also sync manual tracking state
          chrome.tabs.sendMessage(tab.id, {
            type: 'TOGGLE_TRACKING',
            active: trackingTabIds.includes(tab.id),
            flowMarker: getFlowMarker(tab.id) ?? undefined
          }).catch(() => {});
        }
      }
    });
  }
  sendTabsUpdate();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  let changed = false;
  if (tabId === connectedTabId) {
    connectedTabId = null;
    changed = true;
  }
  const oldLen = flowTabs.length;
  flowTabs = flowTabs.filter(id => id !== tabId);
  if (flowTabs.length !== oldLen) changed = true;
  
  const oldTrackLen = trackingTabIds.length;
  trackingTabIds = trackingTabIds.filter(id => id !== tabId);
  if (trackingTabIds.length !== oldTrackLen) changed = true;

  if (changed) {
    chrome.storage.local.set({ 
      smartwriterTabId: connectedTabId,
      smartwriterFlowTabs: flowTabs,
      smartwriterTrackingTabs: trackingTabIds
    });
    // SCIENTIFIC SYNC: Notify all remaining flow tabs to update their Flow ID markers
    for (const id of flowTabs) {
      chrome.tabs.sendMessage(id, { 
        type: 'TAB_FLOW_STATE_CHANGE', 
        enabled: tabFlowEnabled, 
        flowMarker: getFlowMarker(id) ?? undefined 
      }).catch(() => {});
    }
  }
  updateIcon();
  sendTabsUpdate();
});

// Keep service worker alive and reconnect WebSocket every 25s
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connectAll();
});

setIcon(false);
loadConfig().then(() => connectAll());
