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
const tabSourceTabId = new Map<number, number>();

let isLoaded = false;
const loadPromise = loadConfig().then(() => { isLoaded = true; });
const ANNOTATION_MARKER_PREFIX = 'a';
// Note: `e<n>` is now used for element refs returned by snapshots.
// Do not treat it as an annotation marker.
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
const TARGET_RESOLUTION_COMMANDS = new Set([
  ...SELECTOR_COMMANDS,
  'CLICK',
  'HOVER',
  'GET_ELEMENT_BY_MARKER',
  'GET_COMPONENT_ORIGIN',
]);

type ResolvedSelector = {
  selector: string;
  originalSelector: string;
  marker?: string;
  index?: number;
};

type TargetResolutionResult = {
  elementRef: string;
  target?: string;
};

type IndexedAnnotation = {
  annotation: Annotation;
  index: number;
};

type DetailedAnnotation = Annotation & {
  index: number;
  marker: string;
  tabId?: number | null;
};

type AnnotationRow = {
  annotation: Annotation;
  index: number;
  markerNumber: number;
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

function annotationMarkerNumber(row: IndexedAnnotation): number {
  const step = row.annotation.stepNumber;
  if (typeof step === 'number' && Number.isInteger(step) && step > 0) return step;
  return row.index;
}

function toAnnotationRows(rows: IndexedAnnotation[]): AnnotationRow[] {
  return rows
    .map((row) => ({
      annotation: row.annotation,
      index: row.index,
      markerNumber: annotationMarkerNumber(row),
    }))
    .sort((a, b) => a.markerNumber - b.markerNumber || a.index - b.index);
}

function filterRowsByTabId(rows: IndexedAnnotation[], tabId: number, connectedUrl?: string): IndexedAnnotation[] {
  return rows.filter(({ annotation }) => {
    if (typeof annotation.tabId === 'number') return annotation.tabId === tabId;
    // Backward compatibility for old records without tabId
    return connectedUrl ? annotation.url === connectedUrl : false;
  });
}

function resolveAnnotationTabId(annotation: Annotation, tabs: chrome.tabs.Tab[]): number | null {
  if (typeof annotation.tabId === 'number') return annotation.tabId;
  return resolveTabIdByUrl(annotation.url, tabs);
}

function resolveAnnotationFlowId(annotation: Annotation, tabs: chrome.tabs.Tab[]): string | null {
  const tabId = resolveAnnotationTabId(annotation, tabs);
  if (tabId === null) return null;
  return getFlowMarker(tabId);
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

function formatAnnotationSummaries(rows: IndexedAnnotation[]): Array<{id: string, type: string, trigger: string, note: string}> {
  return toAnnotationRows(rows).map(({ annotation, markerNumber }) => ({
    id: getAnnotationMarker(markerNumber),
    type: annotation.type,
    trigger: (annotation.trigger ?? '').replace(/\r?\n/g, ' ').trim(),
    note: annotation.note ?? '',
  }));
}

function getUrlLabelMap(rows: AnnotationRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.annotation.url)) {
      map.set(row.annotation.url, `p${map.size + 1}`);
    }
  }
  return map;
}

function formatCompactAnnotationsForConnectedTab(rows: IndexedAnnotation[]): Array<{id: string, pageId: string, type: string, trigger: string, note: string}> {
  const sortedRows = toAnnotationRows(rows);
  const urlLabels = getUrlLabelMap(sortedRows);
  return sortedRows.map(({ annotation, markerNumber }) => ({
    id: getAnnotationMarker(markerNumber),
    pageId: urlLabels.get(annotation.url) ?? '',
    type: annotation.type,
    trigger: (annotation.trigger ?? '').replace(/\r?\n/g, ' ').trim(),
    note: annotation.note ?? '',
  }));
}

function formatCompactAnnotationsGlobal(rows: IndexedAnnotation[], tabs: chrome.tabs.Tab[]): Array<{id: string, pageId: string, tabId: string, type: string, trigger: string, note: string}> {
  const flowRows = toAnnotationRows(rows).map(({ annotation, markerNumber, index }) => ({
    annotation,
    markerNumber,
    index,
    flowId: resolveAnnotationFlowId(annotation, tabs),
  })).filter((row) => row.flowId !== null);

  const sorted = flowRows.sort((a, b) => a.markerNumber - b.markerNumber || a.index - b.index);

  const urlLabels = getUrlLabelMap(sorted.map((row) => ({
    annotation: row.annotation,
    index: row.index,
    markerNumber: row.markerNumber,
  })));

  return sorted.map(({ annotation, markerNumber, flowId }) => ({
    id: getAnnotationMarker(markerNumber),
    pageId: urlLabels.get(annotation.url) ?? '',
    tabId: flowId ?? '',
    type: annotation.type,
    trigger: (annotation.trigger ?? '').replace(/\r?\n/g, ' ').trim(),
    note: annotation.note ?? '',
  }));
}

function clearAnnotationsByUrl(urlFilter?: string): Promise<{ cleared: boolean; scope: string; count: number }> {
  return new Promise((resolve) => {
    chrome.storage.local.get('smartwriterAnnotations', (result) => {
      const annotations = (result.smartwriterAnnotations || []) as Annotation[];
      const kept = urlFilter ? annotations.filter((annotation) => annotation.url !== urlFilter) : [];
      const deletedCount = annotations.length - kept.length;
      chrome.storage.local.set({ smartwriterAnnotations: kept }, () => {
        resolve({ cleared: true, scope: urlFilter ?? 'all', count: deletedCount });
      });
    });
  });
}

function clearAnnotationsByTabId(tabId: number, connectedUrl?: string): Promise<{ cleared: boolean; scope: string; count: number }> {
  return new Promise((resolve) => {
    chrome.storage.local.get('smartwriterAnnotations', (result) => {
      const annotations = (result.smartwriterAnnotations || []) as Annotation[];
      const kept = annotations.filter((annotation) => {
        if (typeof annotation.tabId === 'number') return annotation.tabId !== tabId;
        return connectedUrl ? annotation.url !== connectedUrl : true;
      });
      const deletedCount = annotations.length - kept.length;
      chrome.storage.local.set({ smartwriterAnnotations: kept }, () => {
        resolve({ cleared: true, scope: `tab:${tabId}`, count: deletedCount });
      });
    });
  });
}

function flowDisabledResult(): { result: string; reason: string } {
  return { result: 'Empty', reason: 'Tabflow must be enabled' };
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

async function getTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => resolve(tabs));
  });
}

function toDetailedAnnotations(rows: IndexedAnnotation[]): DetailedAnnotation[] {
  return toAnnotationRows(rows).map(({ annotation, index, markerNumber }) => ({
    ...annotation,
    index,
    marker: getAnnotationMarker(markerNumber),
  }));
}

function resolveTabIdByUrl(url: string, tabs: chrome.tabs.Tab[]): number | null {
  const matched = tabs.find((tab) => tab.id !== undefined && tab.url === url);
  return matched?.id ?? null;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let expression = script;

  if (args && args.length > 0) {
    const argBindings = (args ?? [])
      .map((_, i) => `const arg${i} = __smartwriterArgs[${i}];`)
      .join('\n');
    expression = `(async (...__smartwriterArgs) => {
${argBindings}
${script}
})(...${JSON.stringify(args ?? [])})`;
  }

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

  const remoteObj = result.result;
  if (!remoteObj) return undefined;

  if (remoteObj.value !== undefined) return remoteObj.value;
  if (remoteObj.unserializableValue !== undefined) return remoteObj.unserializableValue;
  return remoteObj.description || remoteObj.type;
}

async function resolveSelectorArgument(_tabId: number, selector: string): Promise<ResolvedSelector> {
  const index = parseAnnotationMarker(selector);
  if (index === null) {
    return { selector, originalSelector: selector };
  }

  return {
    selector,
    originalSelector: selector,
    marker: getAnnotationMarker(index),
    index,
  };
}

async function resolveSelectorToElementRef(
  tabId: number,
  selector: string,
  force = false
): Promise<{ resolved: ResolvedSelector; elementRef: string }> {
  const resolved = await resolveSelectorArgument(tabId, selector);
  const targetResolution = (await sendContentCommand(tabId, 'RESOLVE_TARGET', {
    target: resolved.selector,
    force,
  })) as TargetResolutionResult;
  const elementRef = String(targetResolution?.elementRef ?? '');
  if (!elementRef) {
    throw new Error(`Failed to resolve element ref for: ${selector}`);
  }
  return { resolved, elementRef };
}

function isStaleElementRefError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('element ref is stale') || msg.includes('stale') || msg.includes('detached');
}

async function executeTargetCommandWithAutoReresolve(
  tabId: number,
  command: string,
  args: Record<string, unknown>,
  selector: string
): Promise<{ result: unknown; resolved: ResolvedSelector }> {
  const first = await resolveSelectorToElementRef(tabId, selector);
  try {
    const result = await sendContentCommand(tabId, command, {
      ...args,
      selector: first.resolved.selector,
      elementRef: first.elementRef,
    });
    return { result, resolved: first.resolved };
  } catch (error) {
    if (!isStaleElementRefError(error)) throw error;
    const retry = await resolveSelectorToElementRef(tabId, selector, true);
    const result = await sendContentCommand(tabId, command, {
      ...args,
      selector: retry.resolved.selector,
      elementRef: retry.elementRef,
    });
    return { result, resolved: retry.resolved };
  }
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

  const sendOnce = () =>
    new Promise<unknown>((resolve, reject) => {
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

  try {
    return await sendOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingReceiver =
      message.includes('Receiving end does not exist') ||
      message.includes('Could not establish connection') ||
      message.includes('The message port closed before a response was received');

    if (!missingReceiver) throw error;

    // After extension reload, existing tabs may not have the content script injected yet.
    await new Promise<void>((resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId }, files: ['content.js'] },
        () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve())
      );
    });

    return await sendOnce();
  }
}

async function mouseAction(tabId: number, command: 'HOVER' | 'CLICK', selector: string, elementRef?: string): Promise<unknown> {
  const target = { tabId };
  await ensureDebuggerAttached(tabId);
  try {
    // 1. Get coordinates
    const pos = (await sendContentCommand(tabId, 'GET_ELEMENT_COORDS', { selector, elementRef })) as { x: number; y: number };
    
    // 2. Centralized UI: Show/Move cursor with icon via content script
    await sendContentCommand(tabId, 'SET_CURSOR_STATE', { x: pos.x, y: pos.y, show: true });

    // Wait for movement animation
    await delay(200);

    if (command === 'CLICK') {
      // 3. Centralized UI: Pulse effect
      await sendContentCommand(tabId, 'SET_CURSOR_STATE', { pulse: true });
      
      // Wait for pulse to start
      await delay(50);

      // 4. Physical CDP Clicks - Temporarily hide dot so it doesn't block the click
      await sendContentCommand(tabId, 'SET_CURSOR_STATE', { show: false });

      await withCallback<unknown>((cb) =>
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, cb)
      );
      
      // Tiny delay for realistic click duration
      await delay(60);

      await withCallback<unknown>((cb) =>
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, cb)
      );
      
      return { clicked: true, x: pos.x, y: pos.y };
    }

    // For HOVER, hide after a bit too
    setTimeout(() => {
      sendContentCommand(tabId, 'SET_CURSOR_STATE', { show: false }).catch(() => {});
    }, 1000);

    return { hovered: true, x: pos.x, y: pos.y };
  } catch (e) {
    // Ensure hidden on error
    sendContentCommand(tabId, 'SET_CURSOR_STATE', { show: false }).catch(() => {});
    throw e;
  }
}

async function typeText(tabId: number, text: string): Promise<void> {
  const target = { tabId };
  await ensureDebuggerAttached(tabId);
  for (const char of text) {
    await withCallback<void>((cb) => 
      chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        unmodifiedText: char,
      }, cb)
    );
    await withCallback<void>((cb) => 
      chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char,
        unmodifiedText: char,
      }, cb)
    );
    await delay(20);
  }
}

async function pressKey(tabId: number, key: string): Promise<void> {
  const target = { tabId };
  await ensureDebuggerAttached(tabId);
  const keyCode = key === 'Enter' ? 13 : 0;
  
  await withCallback<void>((cb) => 
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: key,
      code: key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    }, cb)
  );
  
  if (key === 'Enter') {
    await withCallback<void>((cb) => 
      chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'char',
        text: '\r',
        unmodifiedText: '\r',
      }, cb)
    );
  }

  await new Promise(r => setTimeout(r, 50));

  await withCallback<void>((cb) => 
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: key,
      code: key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    }, cb)
  );
}

function getFlowMarker(tabId: number): string | null {
  const idx = flowTabs.indexOf(tabId);
  return idx !== -1 ? `t${idx + 1}` : null;
}

function parseFlowMarker(value: string): number | null {
  if (!value.startsWith('t')) return null;
  const idx = parseInt(value.slice(1), 10) - 1;
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

    case 'GET_TABS_COMPACT_INFO':
      if (!tabFlowEnabled) throw new Error('Flow mode is disabled.');
      return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const rows = flowTabs
            .map((tabId, idx) => {
              const tab = tabs.find((t) => t.id === tabId);
              if (!tab) return null;
              return { tabId: `t${idx + 1}`, tabTitle: (tab.title || '').replace(/\r?\n/g, ' ').trim() };
            })
            .filter((row): row is { tabId: string; tabTitle: string } => row !== null);
          resolve(rows);
        });
      });

    case 'GET_CONNECTED_TAB_INFO':
      if (!connectedTabId) throw new Error('No tab connected.');
      return new Promise((resolve) => {
        chrome.tabs.get(connectedTabId!, (tab) => {
          const title = (tab?.title || '').replace(/\r?\n/g, ' ').trim();
          const url = tab?.url || '';
          const active = tab?.active ?? false;
          resolve({ tabId: String(connectedTabId), title, url, active });
        });
      });
    case 'FIND_ELEMENT_BY_TEXT':
      if (!connectedTabId) throw new Error('No tab connected.');
      return sendContentCommand(connectedTabId, 'FIND_ELEMENT_BY_TEXT', args);

    case 'SMART_FOCUS': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const { target: targetText } = args as { target: string };
      try {
        const result = (await sendContentCommand(connectedTabId, 'SMART_FOCUS', { target: targetText })) as {
          elementRef: string;
          tagName: string;
          text: string;
        };
        // Return format: e165 a "why custody..."
        return `${result.elementRef} ${result.tagName} "${result.text.replace(/"/g, '\\"')}"`;
      } catch (error) {
        return 'Not found';
      }
    }

    case 'SMART_SEARCH': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const { query } = args as { query: string };
      
      // 1. Capture Initial State (URL + DOM Summary) - Use debugger to bypass CSP
      const initialTab = await getTab(connectedTabId);
      const initialUrl = initialTab?.url || '';
      const initialDom = (await evaluateWithDebugger(connectedTabId, 
        "document.body.innerText.length + '-' + document.querySelectorAll('*').length" 
      )) as string;

      const prep = (await sendContentCommand(connectedTabId, 'SMART_SEARCH', args)) as { 
        inputRef: string; 
        submitBtnRef?: string;
      };
      
      // 2. Focus and Type
      await mouseAction(connectedTabId, 'CLICK', '', prep.inputRef);
      await delay(100);
      await typeText(connectedTabId, query);
      await delay(300);
      
      // 3. Multi-strategy Submission Loop
      const strategies = [
        async () => {
          await pressKey(connectedTabId, 'Enter');
          return 'enter_key';
        },
        async () => {
          if (prep.submitBtnRef) {
            await mouseAction(connectedTabId, 'CLICK', '', prep.submitBtnRef);
            return 'button_click';
          }
          return null;
        }
      ];

      for (const strategy of strategies) {
        const method = await strategy();
        if (!method) continue;

        // Wait and check for changes (URL or DOM)
        for (let i = 0; i < 10; i++) {
          await delay(200);
          const currentTab = await getTab(connectedTabId);
          const currentDom = (await evaluateWithDebugger(connectedTabId, 
            "document.body.innerText.length + '-' + document.querySelectorAll('*').length" 
          )) as string;

          if (currentTab && currentTab.url !== initialUrl) {
            return { searched: true, status: 'navigated', method, newUrl: currentTab.url };
          }
          if (currentDom !== initialDom) {
            // Check if the query text is now on the page (indicating results)
            const isQueryPresent = (await evaluateWithDebugger(connectedTabId, 
              `document.body.innerText.toLowerCase().includes(${JSON.stringify(query.toLowerCase())})` 
            )) as boolean;
            if (isQueryPresent) {
              return { searched: true, status: 'content_updated', method, detail: 'Local search results detected.' };
            }
          }
        }
      }
      
      return { searched: true, status: 'no_change_detected', detail: 'Typed query but no navigation or content change observed.' };
    }
    case 'GET_DETAILED_ANNOTATIONS': {
      const { type } = args as { type?: string };
      if (!connectedTabId) throw new Error('No tab connected.');
      const connectedTab = await getTab(connectedTabId);
      const connectedUrl = connectedTab?.url;
      const rows = filterRowsByTabId(getIndexedAnnotations(await readAnnotations(), undefined, type), connectedTabId, connectedUrl);
      return toDetailedAnnotations(rows);
    }

    case 'GET_GLOBAL_DETAILED_ANNOTATIONS': {
      const { type } = args as { type?: string };
      if (!tabFlowEnabled) return flowDisabledResult();
      const tabs = await getTabs();
      const rows = toDetailedAnnotations(getIndexedAnnotations(await readAnnotations(), undefined, type))
        .map((row) => ({
          ...row,
          flowId: resolveAnnotationFlowId(row, tabs),
        }))
        .filter((row) => row.flowId !== null);
      return rows.sort((a, b) => {
        const markerA = Number.parseInt(String(a.marker).slice(2), 10) || 0;
        const markerB = Number.parseInt(String(b.marker).slice(2), 10) || 0;
        return markerA - markerB || a.index - b.index;
      });
    }

    case 'GET_COMPACT_ANNOTATIONS': {
      const { type } = args as { type?: string };
      if (!connectedTabId) throw new Error('No tab connected.');
      const connectedTab = await getTab(connectedTabId);
      const connectedUrl = connectedTab?.url;
      const rows = filterRowsByTabId(getIndexedAnnotations(await readAnnotations(), undefined, type), connectedTabId, connectedUrl);
      return formatCompactAnnotationsForConnectedTab(rows);
    }

    case 'GET_GLOBAL_COMPACT_ANNOTATIONS': {
      const { type } = args as { type?: string };
      if (!tabFlowEnabled) return flowDisabledResult();
      return formatCompactAnnotationsGlobal(getIndexedAnnotations(await readAnnotations(), undefined, type), await getTabs());
    }

    case 'GET_SUMMARY_ANOTATIONS':
    case 'GET_ANNOTATION_SUMMARIES': {
      const { type } = args as { type?: string };
      if (!connectedTabId) throw new Error('No tab connected.');
      const connectedTab = await getTab(connectedTabId);
      const connectedUrl = connectedTab?.url;
      const rows = filterRowsByTabId(getIndexedAnnotations(await readAnnotations(), undefined, type), connectedTabId, connectedUrl);
      return formatCompactAnnotationsForConnectedTab(rows);
    }

    case 'CLEAR_ALL_ANOTATIONS': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const connectedTab = await getTab(connectedTabId);
      const connectedUrl = connectedTab?.url;
      return clearAnnotationsByTabId(connectedTabId, connectedUrl);
    }

    case 'CLEAR_GLOBAL_ALL_ANOTATIONS':
      if (!tabFlowEnabled) return flowDisabledResult();
      return clearAnnotationsByUrl(undefined);

    case 'CLEAR_ANNOTATIONS': {
      const { url, all } = args as { url?: string; all?: boolean };
      const urlFilter = await getAnnotationUrlFilter({ url, all });
      return clearAnnotationsByUrl(urlFilter);
    }

    case 'DELETE_ANNOTATION':
      return new Promise((resolve) => {
        chrome.storage.local.get('smartwriterAnnotations', (result) => {
          const annotations = (result.smartwriterAnnotations || []) as Annotation[];
          const deleted = deleteAnnotationFromList(annotations, args as { index?: number | string; id?: string });
          chrome.storage.local.set({ smartwriterAnnotations: deleted.kept }, () => {
            resolve({ deleted: deleted.deleted, index: deleted.index, id: deleted.id });
          });
        });
      });

    case 'DISCONNECT_TAB': {
      const selector = args.tabId ? String(args.tabId) : '';
      let targetId = connectedTabId;
      if (selector) {
        targetId = selector.startsWith('t') ? parseFlowMarker(selector) : parseInt(selector, 10);
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
      const targetId = selector.startsWith('t') ? parseFlowMarker(selector) : parseInt(selector, 10);
      if (!targetId || isNaN(targetId)) throw new Error(`Invalid tab target: ${selector}`);
      
      // SERVER COMMAND logic: Connect if not already the active target
      if (connectedTabId !== targetId) {
        internalConnectTab(targetId);
      }
      return { success: true, connectedTabId: targetId, flowMarker: getFlowMarker(targetId) };
    }

    case 'EVALUATE': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const { marker, elementId, index, script, args: scriptArgs } = args as { 
        marker?: string; 
        elementId?: string; 
        index?: number | string;
        script?: string;
        args?: unknown[];
      };
      
      let finalScript = String(script ?? (args as any).script ?? '');
      let ref = marker ?? elementId;
      if (!ref && index !== undefined) {
        const parsedIndex = parseAnnotationIndex(index);
        if (parsedIndex !== null) ref = getAnnotationMarker(parsedIndex);
      }
      if (ref) {
        const resolved = await resolveSelectorArgument(connectedTabId, ref);
        finalScript = `const element = document.querySelector(${JSON.stringify(resolved.selector)});
if (!element) throw new Error(${JSON.stringify(`Element not found for index: ${resolved.index}`)});
${finalScript}`;
      }
      return evaluateWithDebugger(connectedTabId, finalScript, scriptArgs || (args as any).args);
    }

    case 'CLICK': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const selector = String(args.selector ?? '');
      const resolved = await resolveSelectorArgument(connectedTabId, selector);
      
      // 1. Capture initial state
      const initialTab = await getTab(connectedTabId);
      const initialUrl = initialTab?.url || '';
      const initialState = (await evaluateWithDebugger(connectedTabId, 
        "window.scrollY + '-' + document.body.innerText.length"
      )) as string;

      // 2. Strategy A: Physical CDP Click
      await mouseAction(connectedTabId, 'CLICK', resolved.selector, (args as any).elementRef);
      
      // 3. Verification & Strategy B: Auto Fallback
      await delay(600); // Wait for potential reaction
      const currentTab = await getTab(connectedTabId);
      const currentState = (await evaluateWithDebugger(connectedTabId, 
        "window.scrollY + '-' + document.body.innerText.length"
      )) as string;

      const changed = (currentTab?.url !== initialUrl) || (currentState !== initialState);
      
      if (!changed) {
        // Physical click didn't do anything visible -> Try JS Click (Self-Healing)
        await evaluateWithDebugger(connectedTabId, `(() => {
          const el = document.querySelector('[data-sw-ref="${resolved.elementRef}"]') || 
                     document.querySelector(${JSON.stringify(resolved.selector)});
          if (el && typeof el.click === 'function') {
            el.click();
          }
        })()`);
        return { success: true, method: 'js_fallback' };
      }

      return { success: true, method: 'physical_click' };
    }

    case 'HOVER': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const selector = String(args.selector ?? '');
      const resolved = await resolveSelectorArgument(connectedTabId, selector);
      const result = await mouseAction(connectedTabId, 'HOVER', resolved.selector, (args as any).elementRef);
      return scrubSelectorResult(result, resolved);
    }

    case 'TYPE': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const { text, selector } = args as { text: string; selector?: string };
      if (selector) {
        const resolved = await resolveSelectorArgument(connectedTabId, selector);
        await mouseAction(connectedTabId, 'CLICK', resolved.selector, (args as any).elementRef);
        await delay(100);
      }
      await typeText(connectedTabId, text);
      return { typed: true, text };
    }

    case 'PRESS_KEY': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const { key } = args as { key: string };
      await pressKey(connectedTabId, key);
      return { pressed: true, key };
    }

    case 'PRESS_ENTER':
      if (!connectedTabId) throw new Error('No tab connected.');
      await pressKey(connectedTabId, 'Enter');
      return { pressed: true, key: 'Enter' };
    case 'GET_COMPONENT_ORIGIN': {
      if (!connectedTabId) throw new Error('No tab connected.');
      const selector = String(args.selector ?? '');
      try {
        const { result, resolved } = await executeTargetCommandWithAutoReresolve(connectedTabId, command, args, selector);
        return scrubSelectorResult(result, resolved);
      } catch (error) {
        const resolved = await resolveSelectorArgument(connectedTabId, selector);
        throw sanitizeSelectorError(error, resolved);
      }
    }

    case 'JUMP_CONNECTED_TAB':
      if (!connectedTabId) throw new Error('No tab connected.');
      await chrome.tabs.update(connectedTabId, { active: true });
      return { success: true, connectedTabId };

    default:
      if (connectedTabId && TARGET_RESOLUTION_COMMANDS.has(command) && typeof args.selector === 'string') {
        const selector = args.selector;
        try {
          const { result, resolved } = await executeTargetCommandWithAutoReresolve(connectedTabId, command, args, selector);
          return scrubSelectorResult(result, resolved);
        } catch (error) {
          const resolved = await resolveSelectorArgument(connectedTabId, selector);
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
        senderTabId,
        sourceTabId: senderTabId !== null ? (tabSourceTabId.get(senderTabId) ?? null) : null,
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

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id === 'number' && typeof tab.openerTabId === 'number') {
    tabSourceTabId.set(tab.id, tab.openerTabId);
  }
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
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { 
            type: 'TAB_FLOW_STATE_CHANGE', 
            enabled: tabFlowEnabled, 
            flowMarker: getFlowMarker(tab.id) ?? undefined 
          }).catch(() => {});
        }
      }
    });
  }
  sendTabsUpdate();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabSourceTabId.delete(tabId);
  let changed = false;
  if (tabId === connectedTabId) {
    connectedTabId = null;
    changed = true;
  }
  flowTabs = flowTabs.filter(id => id !== tabId);
  trackingTabIds = trackingTabIds.filter(id => id !== tabId);
  chrome.storage.local.set({ 
    smartwriterTabId: connectedTabId,
    smartwriterFlowTabs: flowTabs,
    smartwriterTrackingTabs: trackingTabIds
  });
  updateIcon();
  sendTabsUpdate();
});

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connectAll();
});

setIcon(false);
loadConfig().then(() => connectAll());
