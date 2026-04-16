import type { ContentMessage, ContentResponse } from './types';

chrome.runtime.onMessage.addListener(
  (message: ContentMessage, sender, sendResponse: (response: ContentResponse) => void) => {
    handleMessage(message, sendResponse).catch((error) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }
);

async function handleMessage(message: ContentMessage, sendResponse: (response: ContentResponse) => void): Promise<void> {
  try {
    let result: unknown;

    switch (message.type) {
      case 'REGISTER':
        result = { registered: true, url: window.location.href };
        break;
      case 'CLICK':
        result = await handleClick(message.selector);
        break;
      case 'TYPE':
        result = await handleType(message.selector, message.text);
        break;
      case 'FILL':
        result = await handleFill(message.selector, message.value);
        break;
      case 'SELECT':
        result = await handleSelect(message.selector, message.options);
        break;
      case 'NAVIGATE':
        result = await handleNavigate(message.url);
        break;
      case 'GO_BACK':
        result = await handleGoBack();
        break;
      case 'GO_FORWARD':
        result = await handleGoForward();
        break;
      case 'RELOAD':
        result = await handleReload();
        break;
      case 'EVALUATE':
        result = await evaluateScript(message.script, message.args);
        break;
      case 'HOVER':
        result = await handleHover(message.selector);
        break;
      case 'CHECK':
        result = await handleCheck(message.selector);
        break;
      case 'UNCHECK':
        result = await handleUncheck(message.selector);
        break;
      case 'GET_SNAPSHOT':
        result = getSnapshot(message.selector);
        break;
      case 'SCREENSHOT':
        result = await takeScreenshot();
        break;
      case 'WAIT_FOR':
        result = await waitForText(message.text, message.timeout);
        break;
      case 'PRESS_KEY':
        result = await pressKey(message.key);
        break;
      case 'GET_TEXT':
        result = getText(message.selector);
        break;
      case 'GET_ATTRIBUTE':
        result = getAttribute(message.selector, message.attribute);
        break;
      case 'UNREGISTER':
        result = { unregistered: true };
        break;
      case 'TOGGLE_TRACKING':
        result = handleToggleTracking(message.active);
        break;
      default:
        throw new Error(`Unknown message type: ${(message as any).type}`);
    }

    sendResponse({ success: true, data: result });
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getElement(selector: string): HTMLElement {
  const element = document.querySelector(selector) as HTMLElement | null;
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

async function handleClick(selector: string): Promise<unknown> {
  const element = getElement(selector);
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(100);
  element.click();
  await delay(100);
  return { clicked: true, selector };
}

async function handleType(selector: string, text: string): Promise<unknown> {
  const element = getElement(selector) as HTMLInputElement & HTMLTextAreaElement;
  if (!('value' in element)) {
    throw new Error(`Element is not an input: ${selector}`);
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(100);
  element.focus();
  element.value = '';

  for (const char of text) {
    element.value += char;
    dispatchInputEvents(element);
    await delay(10);
  }
  return { typed: true, selector, text };
}

async function handleFill(selector: string, value: string): Promise<unknown> {
  const element = getElement(selector) as HTMLInputElement & HTMLTextAreaElement;
  if (!('value' in element)) {
    throw new Error(`Element is not an input: ${selector}`);
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(50);
  element.focus();
  element.value = value;
  dispatchInputEvents(element);
  return { filled: true, selector, value };
}

async function handleSelect(selector: string, options: string[]): Promise<unknown> {
  const element = getElement(selector) as HTMLSelectElement;
  if (element.tagName.toLowerCase() !== 'select') {
    throw new Error(`Element is not a select: ${selector}`);
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(50);
  element.value = options[0];
  dispatchInputEvents(element);
  return { selected: true, selector, option: options[0] };
}

async function handleNavigate(url: string): Promise<unknown> {
  return new Promise((resolve) => {
    setTimeout(() => {
      window.location.href = url;
      resolve({ navigating: true, url });
    }, 100);
  });
}

async function handleGoBack(): Promise<unknown> {
  window.history.back();
  return { navigating: true, direction: 'back' };
}

async function handleGoForward(): Promise<unknown> {
  window.history.forward();
  return { navigating: true, direction: 'forward' };
}

async function handleReload(): Promise<unknown> {
  window.location.reload();
  return { reloading: true, url: window.location.href };
}

async function handleHover(selector: string): Promise<unknown> {
  const element = getElement(selector);
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(100);
  const event = new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window });
  element.dispatchEvent(event);
  await delay(100);
  return { hovered: true, selector };
}

async function handleCheck(selector: string): Promise<unknown> {
  const element = getElement(selector) as HTMLInputElement;
  if (element.tagName.toLowerCase() !== 'input' || !['checkbox', 'radio'].includes(element.type)) {
    throw new Error(`Element is not a checkbox or radio input: ${selector}`);
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(50);
  element.focus();
  element.checked = true;
  dispatchInputEvents(element);
  return { checked: true, selector };
}

async function handleUncheck(selector: string): Promise<unknown> {
  const element = getElement(selector) as HTMLInputElement;
  if (element.tagName.toLowerCase() !== 'input' || element.type !== 'checkbox') {
    throw new Error(`Element is not a checkbox input: ${selector}`);
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(50);
  element.focus();
  element.checked = false;
  dispatchInputEvents(element);
  return { unchecked: true, selector };
}

async function evaluateScript(script: string, args?: unknown[]): Promise<unknown> {
  try {
    const fn = new Function(...(args?.map((_, i) => `arg${i}`) || []), script);
    const result = fn(...(args || []));
    if (result instanceof Promise) {
      return await result;
    }
    return result;
  } catch (error) {
    throw new Error(`Script evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getSnapshot(selector?: string): unknown {
  const root = selector ? document.querySelector(selector) : document.documentElement;
  if (!root) throw new Error(`Element not found: ${selector}`);
  const tree = buildA11yTree(root as HTMLElement);
  return {
    url: window.location.href,
    title: document.title,
    tree,
    html: root.innerHTML.substring(0, 5000),
  };
}

interface A11yNode {
  tag: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  children: A11yNode[];
  selector?: string;
  id?: string;
  className?: string;
}

function buildA11yTree(element: HTMLElement, maxDepth = 8): A11yNode {
  if (maxDepth <= 0) {
    return {
      tag: element.tagName.toLowerCase(),
      text: element.textContent?.substring(0, 100),
      children: [],
    };
  }

  const node: A11yNode = {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || undefined,
    text: element.children.length === 0 ? element.textContent?.substring(0, 100) : undefined,
    ariaLabel: element.getAttribute('aria-label') || undefined,
    children: [],
    selector: getCssSelector(element),
    id: element.id || undefined,
    className: element.className ? element.className.substring(0, 100) : undefined,
  };

  const visibleChildren: HTMLElement[] = [];
  for (let i = 0; i < element.children.length; i++) {
    const child = element.children[i] as HTMLElement;
    const rect = child.getBoundingClientRect();
    if (rect.height > 0 && rect.width > 0) {
      visibleChildren.push(child);
      if (visibleChildren.length >= 15) break;
    }
  }

  for (const child of visibleChildren) {
    node.children.push(buildA11yTree(child, maxDepth - 1));
  }

  return node;
}

function getCssSelector(element: HTMLElement): string {
  if (element.id) return `#${element.id}`;

  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector += `#${current.id}`;
      path.unshift(selector);
      break;
    }

    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = parent.children;
      if (siblings.length > 1) {
        const index = Array.from(siblings).indexOf(current) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    path.unshift(selector);
    current = parent;
  }

  return path.join(' > ');
}

async function takeScreenshot(): Promise<unknown> {
  const canvas = await html2canvas(document.body);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
}

function html2canvas(element: HTMLElement): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const rect = element.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Could not get canvas context'));
      return;
    }

    ctx.fillStyle = '#f3f0eb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = '14px sans-serif';
    ctx.fillText('Screenshot captured at ' + new Date().toISOString(), 10, 20);

    resolve(canvas);
  });
}

async function waitForText(text: string, timeout = 5000): Promise<unknown> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (document.body.textContent?.includes(text)) {
      return { found: true, text, timeMs: Date.now() - startTime };
    }
    await delay(100);
  }

  throw new Error(`Text not found within ${timeout}ms: ${text}`);
}

async function pressKey(key: string): Promise<unknown> {
  const activeElement = document.activeElement as HTMLElement | null;
  if (!activeElement) {
    throw new Error('No active element found');
  }

  const keydownEvent = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  const keypressEvent = new KeyboardEvent('keypress', {
    key,
    bubbles: true,
    cancelable: true,
  });
  const keyupEvent = new KeyboardEvent('keyup', {
    key,
    bubbles: true,
    cancelable: true,
  });

  activeElement.dispatchEvent(keydownEvent);
  activeElement.dispatchEvent(keypressEvent);
  await delay(50);
  activeElement.dispatchEvent(keyupEvent);

  return { keyPressed: true, key };
}

function getText(selector: string): unknown {
  const element = getElement(selector);
  return { text: element.textContent, selector };
}

function getAttribute(selector: string, attribute: string): unknown {
  const element = getElement(selector);
  return { value: element.getAttribute(attribute), attribute, selector };
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== TRACKING SYSTEM ====================

const TRACKING_CSS = `
/* ── Launcher: rounded square icon, bottom-right ── */
#__sw_launcher__ {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483645;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  background: #1c1917;
  border: 1px solid rgba(214,200,181,0.16);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 16px 44px rgba(36,26,16,0.38);
  transition: transform 0.15s, background 0.15s, border-color 0.15s;
  outline: none;
}
#__sw_launcher__:hover { transform: scale(1.06); background: #292524; border-color: rgba(245,158,11,0.36); }
#__sw_launcher__.picking { background: #78350f; border-color: rgba(245,158,11,0.5); }
#__sw_launcher__ { cursor: pointer !important; }
/* ── Vertical panel ── */
#__sw_panel__ {
  position: fixed;
  bottom: 80px;
  right: 20px;
  z-index: 2147483645;
  width: 60px;
  background: #1c1917;
  border: 1px solid rgba(214,200,181,0.14);
  border-radius: 16px;
  padding: 10px 0 8px;
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  box-shadow: 0 18px 50px rgba(36,26,16,0.42);
  font-family: -apple-system, sans-serif;
}
#__sw_panel__.visible { display: flex; }
.__sw_ph__ {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  width: 100%; padding: 2px 8px 10px;
  border-bottom: 1px solid rgba(214,200,181,0.12);
  margin-bottom: 2px; box-sizing: border-box;
}
.__sw_ph_icon__ {
  width: 32px; height: 32px; border-radius: 9px;
  background: linear-gradient(135deg,#92400e,#115e59);
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; margin-bottom: 1px;
}
.__sw_ph_name__ {
  font-size: 9px; font-weight: 800; color: rgba(231,220,204,0.64);
  letter-spacing: 0.1em; text-transform: uppercase;
}
.__sw_ph_count__ {
  background: rgba(214,200,181,0.12); color: #e7dcc8;
  font-size: 10px; font-weight: 700; padding: 1px 8px;
  border-radius: 10px; min-width: 22px; text-align: center;
}
.__sw_pb__ {
  width: 44px; height: 40px; border-radius: 10px;
  background: transparent; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: rgba(231,220,204,0.56); transition: background 0.12s, color 0.12s; outline: none;
}
.__sw_pb__:hover { background: rgba(214,200,181,0.12); color: #f3eadb; }
.__sw_pb__.active { background: #5b4b2b; color: #f6e9d1; }
.__sw_pb__.danger:hover { background: rgba(190,18,60,0.18); color: #fda4af; }
.__sw_pb__.confirm { background: rgba(190,18,60,0.22); color: #fda4af; }
.__sw_pb_focus__ { flex-direction: column; gap: 3px; height: 46px; padding: 6px 0; }
.__sw_pb_hint__ {
  font-size: 8px; font-weight: 700; letter-spacing: 0.06em; line-height: 1;
  color: rgba(231,220,204,0.42);
}
.__sw_pb_focus__.active .__sw_pb_hint__ { color: rgba(246,233,209,0.74); }
.__sw_divider__ { width: 30px; height: 1px; background: rgba(214,200,181,0.12); margin: 2px 0; }
/* ── Annotation markers on page ── */
.__sw_marker__ {
  position: fixed; z-index: 2147483644;
  display: inline-flex; align-items: center; gap: 3px;
  padding: 4px 8px 4px 6px; border-radius: 7px;
  font-size: 10px; font-weight: 800;
  font-family: -apple-system, sans-serif;
  cursor: pointer; box-shadow: 0 5px 16px rgba(36,26,16,0.32);
  transition: transform 0.1s; white-space: nowrap; pointer-events: auto;
  transform-origin: left bottom;
}
.__sw_marker__:hover { transform: scale(1.12); }
.__sw_mk_step__   { background: #b45309; color: #fef3c7; }
.__sw_mk_change__ { background: #0f766e; color: #ccfbf1; }
.__sw_mk_bug__  { background: #e11d48; color: #fff1f2; }
.__sw_mk_dot__ { width: 5px; height: 5px; border-radius: 50%; background: rgba(246,233,209,0.68); }
/* ── Marker tooltip ── */
.__sw_mtip__ {
  position: fixed; z-index: 2147483646;
  background: #292524; color: #f3eadb;
  border-radius: 12px; padding: 12px 14px 10px;
  width: 230px; box-shadow: 0 12px 38px rgba(36,26,16,0.42);
  font-family: -apple-system, sans-serif; font-size: 12px;
  pointer-events: auto; border: 1px solid rgba(214,200,181,0.14);
}
.__sw_mtip_badge__ {
  display: inline-flex; align-items: center;
  font-size: 9px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 0.07em; padding: 2px 8px; border-radius: 4px; margin-bottom: 7px;
}
.__sw_mtb_change__ { background: rgba(15,118,110,0.22); color: #99f6e4; }
.__sw_mtb_step__ { background: rgba(146,64,14,0.28);  color: #fcd34d; }
.__sw_mtb_bug__  { background: rgba(159,18,57,0.22); color: #fda4af; }
.__sw_mtip_note__ {
  font-size: 12px; color: #d6c8b5; line-height: 1.5;
  margin-bottom: 7px; word-break: break-word;
}
.__sw_mtip_path__ {
  font-size: 9px; font-family: monospace; color: rgba(214,200,181,0.48);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 9px;
}
.__sw_mtip_del__ {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  width: 100%; padding: 6px; background: rgba(190,18,60,0.12); color: #fda4af;
  border: 1px solid rgba(190,18,60,0.24); border-radius: 7px;
  font-size: 11px; font-weight: 600; cursor: pointer;
  font-family: inherit; transition: background 0.12s; box-sizing: border-box;
}
.__sw_mtip_del__:hover { background: rgba(190,18,60,0.24); }
/* ── Pick highlight & cursor ── */
.__sw_pick_hi__ {
  outline: 2px solid #b45309 !important;
  outline-offset: 2px !important;
  background-color: rgba(180,83,9,0.08) !important;
}
.__sw_ann_hi__ {
  outline: 2px solid #0f766e !important;
  outline-offset: 3px !important;
  background-color: rgba(15,118,110,0.16) !important;
  box-shadow: 0 0 0 4px rgba(15,118,110,0.10) !important;
}
.__sw_picking__ * { cursor: crosshair !important; }
/* ── Annotation popup (dark) ── */
#__sw_ann_popup__ {
  position: fixed; z-index: 2147483647;
  background: #292524;
  border: 1px solid rgba(214,200,181,0.14);
  border-radius: 16px;
  box-shadow: 0 24px 70px rgba(36,26,16,0.58);
  width: 380px; padding: 0;
  font-family: -apple-system, BlinkMacSystemFont,'Segoe UI',sans-serif;
  box-sizing: border-box; overflow: hidden;
}
.__sw_ph2__ {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px 12px; border-bottom: 1px solid rgba(214,200,181,0.12);
}
.__sw_pt__  { font-size: 15px; font-weight: 700; color: #f3eadb; }
.__sw_px__ {
  width: 26px; height: 26px; border-radius: 7px;
  background: rgba(214,200,181,0.10); border: none; cursor: pointer;
  color: rgba(231,220,204,0.62); display: flex; align-items: center;
  justify-content: center; font-size: 16px; font-family: inherit;
  transition: background 0.12s; outline: none; line-height: 1;
}
.__sw_px__:hover { background: rgba(214,200,181,0.18); color: #f6e9d1; }
.__sw_ppath__ {
  padding: 7px 18px; font-size: 10px; font-family: monospace;
  color: rgba(214,200,181,0.52); background: rgba(28,25,23,0.54);
  border-bottom: 1px solid rgba(214,200,181,0.10);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.__sw_pbody__ { padding: 16px 18px 18px; }
.__sw_fl__ {
  font-size: 11px; font-weight: 700; color: rgba(231,220,204,0.66);
  text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 8px;
}
.__sw_ta__ {
  width: 100%; box-sizing: border-box; height: 88px;
  padding: 10px 12px; background: rgba(68,64,60,0.55);
  border: 1.5px solid rgba(214,200,181,0.14); border-radius: 10px;
  font-size: 13px; resize: none; outline: none; font-family: inherit;
  color: #f3eadb; margin-bottom: 14px; transition: border-color 0.12s;
}
.__sw_ta__:focus { border-color: rgba(245,158,11,0.72); }
.__sw_ta__::placeholder { color: rgba(214,200,181,0.42); }
.__sw_pills__ { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
.__sw_pill__ {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 13px; border-radius: 20px; font-size: 12px; font-weight: 600;
  cursor: pointer; border: 1.5px solid rgba(214,200,181,0.18);
  background: transparent; color: rgba(231,220,204,0.62);
  font-family: inherit; transition: all 0.12s; outline: none;
}
.__sw_pill__:hover { border-color: rgba(214,200,181,0.36); color: #f3eadb; }
.__sw_pchg__.sel  { border-color: #0f766e; background: rgba(15,118,110,0.28); color: #5eead4; }
.__sw_pstep__.sel { border-color: #d97706; background: rgba(217,119,6,0.28); color: #fde68a; }
.__sw_pbug__.sel  { border-color: #e11d48; background: rgba(225,29,72,0.28); color: #ff8fa3; }
.__sw_si__ { display: none; align-items: center; gap: 6px; margin-bottom: 14px; }
.__sw_si__.show { display: flex; }
.__sw_sil__ { font-size: 11px; color: rgba(231,220,204,0.58); font-weight: 600; }
.__sw_sii__ {
  width: 56px; padding: 5px 8px;
  background: rgba(68,64,60,0.55); border: 1.5px solid rgba(214,200,181,0.16);
  border-radius: 7px; font-size: 12px; color: #f3eadb;
  font-family: inherit; outline: none; box-sizing: border-box;
}
.__sw_sii__:focus { border-color: rgba(245,158,11,0.72); }
.__sw_pfoot__ { display: flex; gap: 8px; align-items: center; padding-top: 2px; }
.__sw_fdel__ { background: rgba(190,18,60,0.12); color: #fda4af; border: 1px solid rgba(190,18,60,0.24); margin-right: auto; }
.__sw_fdel__:hover { background: rgba(190,18,60,0.24); }
.__sw_fpb__ {
  padding: 9px 18px; border-radius: 10px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: none; outline: none; font-family: inherit; transition: all 0.12s;
}
.__sw_fpc__ { background: rgba(214,200,181,0.12); color: rgba(231,220,204,0.74); }
.__sw_fpc__:hover { background: rgba(214,200,181,0.20); color: #f6e9d1; }
.__sw_fps__ { background: #92400e; color: #f7ead7; min-width: 130px; }
.__sw_fps__:hover { background: #78350f; }
.__sw_fps__ kbd {
  font-family: inherit; font-size: 10px; font-weight: 500;
  background: rgba(246,233,209,0.16); color: #f6e9d1;
  border-radius: 4px; padding: 1px 5px; margin-left: 6px; letter-spacing: 0;
}
/* ── Toast ── */
#__sw_toast__ {
  position: fixed; bottom: 82px; right: 20px;
  background: #292524; color: #f3eadb;
  padding: 8px 14px; border-radius: 8px;
  font-family: -apple-system, sans-serif; font-size: 12px; font-weight: 500;
  z-index: 2147483647; pointer-events: none;
  transition: opacity 0.2s ease; opacity: 0;
  box-shadow: 0 8px 24px rgba(36,26,16,0.32);
  border: 1px solid rgba(214,200,181,0.14);
}
/* ── Count badge on launcher ── */
#__sw_badge__ {
  position: absolute; bottom: -5px; right: -5px;
  background: #be123c; color: #f8e4e9;
  font-size: 9px; font-weight: 800; line-height: 14px;
  min-width: 16px; padding: 0 4px; border-radius: 8px;
  border: 2px solid #1c1917; text-align: center;
  pointer-events: none; display: none;
}
#__sw_badge__.show { display: block; }
`;

// SVG icons (feather-style)
const SW_SVG_LAYERS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f3eadb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
const SW_SVG_PICK = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V3h4"/><path d="M21 7V3h-4"/><path d="M3 17v4h4"/><path d="M21 17v4h-4"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>`;
const SW_SVG_EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SW_SVG_EYEOFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SW_SVG_TRASH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

let swTrackingActive = false;
let swPickingElement = false;
let swHighlightedEl: HTMLElement | null = null;
let swMarkersVisible = true;
let swActiveTip: HTMLElement | null = null;
let swScrollTimer: ReturnType<typeof setTimeout> | null = null;
let swClearConfirm = false;
let swClearTimer: ReturnType<typeof setTimeout> | null = null;
let swFocusModeOn = true;
let swMarkerFocusEl: HTMLElement | null = null;

function handleToggleTracking(active: boolean): unknown {
  swTrackingActive = active;
  if (active) {
    injectTrackingWidget();
  } else {
    removeTrackingWidget();
  }
  return { tracking: active };
}

function injectTrackingWidget(): void {
  if (document.getElementById('__sw_launcher__')) return;

  const style = document.createElement('style');
  style.id = '__sw_tracker_styles__';
  style.textContent = TRACKING_CSS;
  document.head.appendChild(style);

  const launcher = document.createElement('button');
  launcher.id = '__sw_launcher__';
  launcher.title = 'Smartwriter Tracker';
  launcher.innerHTML = SW_SVG_LAYERS + '<span id="__sw_badge__"></span>';
  document.body.appendChild(launcher);

  // Vertical panel
  const panel = document.createElement('div');
  panel.id = '__sw_panel__';
  panel.innerHTML = `
    <div class="__sw_ph__">
      <span class="__sw_ph_name__">Track</span>
    </div>
    <button class="__sw_pb__ __sw_pb_focus__ active" id="__sw_pick_btn__" title="Focus mode ON">${SW_SVG_PICK}<span class="__sw_pb_hint__">ESC</span></button>
    <div class="__sw_divider__"></div>
    <button class="__sw_pb__ active" id="__sw_eye_btn__" title="Toggle markers">${SW_SVG_EYE}</button>
    <div class="__sw_divider__"></div>
    <button class="__sw_pb__ danger" id="__sw_del_btn__" title="Clear page annotations">${SW_SVG_TRASH}</button>
  `;
  document.body.appendChild(panel);

  // Pick/focus mode toggle button
  document.getElementById('__sw_pick_btn__')!.addEventListener('click', (e) => {
    e.stopPropagation();
    swFocusModeOn = !swFocusModeOn;
    const pickBtn = document.getElementById('__sw_pick_btn__')!;
    pickBtn.classList.toggle('active', swFocusModeOn);
    pickBtn.title = swFocusModeOn ? 'Focus mode ON' : 'Focus mode OFF';
    if (swFocusModeOn) {
      panel.classList.remove('visible');
      startPickingElement();
    } else {
      cancelPickingElement();
    }
  });

  // Launcher toggles panel; pauses picking while open
  launcher.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !panel.classList.contains('visible');
    if (opening) {
      cancelPickingElement(); // pause while panel is open
      panel.classList.add('visible');
    } else {
      panel.classList.remove('visible');
      if (swFocusModeOn) startPickingElement(); // resume only if focus mode is on
    }
  });

  document.getElementById('__sw_eye_btn__')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const eyeBtn = document.getElementById('__sw_eye_btn__')!;
    swMarkersVisible = !swMarkersVisible;
    eyeBtn.innerHTML = swMarkersVisible ? SW_SVG_EYE : SW_SVG_EYEOFF;
    eyeBtn.classList.toggle('active', swMarkersVisible);
    swSetMarkersVisibility(swMarkersVisible);
  });

  document.getElementById('__sw_del_btn__')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = document.getElementById('__sw_del_btn__')!;
    if (!swClearConfirm) {
      swClearConfirm = true;
      btn.classList.add('confirm');
      btn.title = 'Click again to confirm';
      if (swClearTimer) clearTimeout(swClearTimer);
      swClearTimer = setTimeout(() => {
        swClearConfirm = false;
        btn.classList.remove('confirm');
        btn.title = 'Clear page annotations';
      }, 2500);
      return;
    }
    swClearConfirm = false;
    btn.classList.remove('confirm');
    if (swClearTimer) clearTimeout(swClearTimer);
    chrome.storage.local.get('smartwriterAnnotations', (result) => {
      const url = window.location.href;
      const kept = (result.smartwriterAnnotations || []).filter((a: SwAnnotation) => a.url !== url);
      chrome.storage.local.set({ smartwriterAnnotations: kept }, () => {
        swRemoveAllMarkers();
        swUpdateCount(0);
        panel.classList.remove('visible');
        swShowToast('All annotations cleared');
      });
    });
  });

  document.addEventListener('click', swClosePanel);
  document.addEventListener('keydown', swWidgetKeydown, true);
  window.addEventListener('scroll', swOnScroll, { passive: true });
  window.addEventListener('resize', swOnScroll, { passive: true });
  swRefreshMarkers();
  startPickingElement();
}

function swClosePanel(e: MouseEvent): void {
  const panel = document.getElementById('__sw_panel__');
  const launcher = document.getElementById('__sw_launcher__');
  if (panel && launcher && panel.classList.contains('visible') &&
      !panel.contains(e.target as Node) && !launcher.contains(e.target as Node)) {
    panel.classList.remove('visible');
    if (swClearConfirm) {
      swClearConfirm = false;
      document.getElementById('__sw_del_btn__')?.classList.remove('confirm');
    }
    if (swFocusModeOn) startPickingElement(); // resume only if focus mode is on
  }
  if (swActiveTip && !swActiveTip.contains(e.target as Node) &&
      !(e.target as Element).closest('.__sw_marker__')) {
    swActiveTip.remove();
    swActiveTip = null;
  }
}

function removeTrackingWidget(): void {
  cancelPickingElement();
  swRemoveAllMarkers();
  document.getElementById('__sw_launcher__')?.remove();
  document.getElementById('__sw_panel__')?.remove();
  document.getElementById('__sw_tracker_styles__')?.remove();
  document.getElementById('__sw_ann_popup__')?.remove();
  document.getElementById('__sw_toast__')?.remove();
  swActiveTip?.remove();
  swActiveTip = null;
  document.removeEventListener('click', swClosePanel);
  document.removeEventListener('keydown', swWidgetKeydown, true);
  window.removeEventListener('scroll', swOnScroll);
  window.removeEventListener('resize', swOnScroll);
  if (swScrollTimer) clearTimeout(swScrollTimer);
  if (swClearTimer) clearTimeout(swClearTimer);
}

function swOnScroll(): void {
  if (swScrollTimer) clearTimeout(swScrollTimer);
  swScrollTimer = setTimeout(swRefreshMarkers, 100);
}

// --- Element Picker ---

function startPickingElement(): void {
  if (swPickingElement) return;
  swPickingElement = true;
  document.getElementById('__sw_launcher__')?.classList.add('picking');
  document.body.classList.add('__sw_picking__');
  document.addEventListener('mouseover', onPickerMouseover, true);
  document.addEventListener('click', onPickerClick, true);
}

function cancelPickingElement(): void {
  if (!swPickingElement) return;
  swPickingElement = false;
  document.getElementById('__sw_launcher__')?.classList.remove('picking');
  document.body.classList.remove('__sw_picking__');
  document.removeEventListener('mouseover', onPickerMouseover, true);
  document.removeEventListener('click', onPickerClick, true);
  if (swHighlightedEl) {
    swHighlightedEl.classList.remove('__sw_pick_hi__');
    swHighlightedEl = null;
  }
}

function onPickerMouseover(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (!target) return;
  if (target.closest('#__sw_launcher__') || target.closest('#__sw_panel__') ||
      target.closest('#__sw_ann_popup__') || target.closest('.__sw_marker__') ||
      target.closest('#__sw_toast__')) return;
  if (swHighlightedEl && swHighlightedEl !== target) {
    swHighlightedEl.classList.remove('__sw_pick_hi__');
  }
  swHighlightedEl = target;
  target.classList.add('__sw_pick_hi__');
}

function onPickerClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (!target) return;
  if (target.closest('#__sw_launcher__') || target.closest('#__sw_panel__') ||
      target.closest('#__sw_ann_popup__') || target.closest('.__sw_marker__') ||
      target.closest('#__sw_toast__') || target.closest('.__sw_mtip__')) return;
  e.preventDefault();
  e.stopPropagation();
  cancelPickingElement();
  showAnnotationPopup(target, e.clientX, e.clientY);
}

function swWidgetKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // Let popup handle its own Esc
  if (document.getElementById('__sw_ann_popup__')) return;
  e.preventDefault();
  swFocusModeOn = !swFocusModeOn;
  const pickBtn = document.getElementById('__sw_pick_btn__');
  if (pickBtn) {
    pickBtn.classList.toggle('active', swFocusModeOn);
    pickBtn.title = swFocusModeOn ? 'Focus mode ON' : 'Focus mode OFF';
  }
  if (swFocusModeOn) {
    startPickingElement();
  } else {
    if (swHighlightedEl) { swHighlightedEl.classList.remove('__sw_pick_hi__'); swHighlightedEl = null; }
    cancelPickingElement();
  }
}

// --- Annotation Markers ---

let swAnnotationsCache: SwAnnotation[] = [];

function swRefreshMarkers(): void {
  chrome.storage.local.get('smartwriterAnnotations', (result) => {
    const url = window.location.href;
    const all: SwAnnotation[] = result.smartwriterAnnotations || [];
    swAnnotationsCache = all.filter(a => a.url === url);
    swRemoveAllMarkers();
    swAnnotationsCache.forEach(swAddMarker);
    swUpdateCount(swAnnotationsCache.length);
  });
}

function swAddMarker(ann: SwAnnotation): void {
  let el: Element | null = null;
  try { el = document.querySelector(ann.selectors.primary); } catch (_) { /* ignore */ }
  if (!el) {
    try { el = document.querySelector(ann.selectors.cssPath); } catch (_) { /* ignore */ }
  }

  const marker = document.createElement('div');
  marker.className = `__sw_marker__ __sw_mk_${ann.type}__`;
  marker.dataset.annId = ann.id;
  const prefix = `#${ann.stepNumber ?? '?'}`;
  marker.innerHTML = `<span class="__sw_mk_dot__"></span>${prefix}`;

  if (el) {
    const rect = el.getBoundingClientRect();
    marker.style.left = `${Math.max(0, rect.left)}px`;
    marker.style.top = `${Math.max(0, rect.top)}px`;
  } else {
    const r = ann.element.rect;
    marker.style.left = `${Math.max(0, r.x - window.scrollX)}px`;
    marker.style.top = `${Math.max(0, r.y - window.scrollY)}px`;
  }

  if (!swMarkersVisible) marker.style.display = 'none';

  marker.addEventListener('mouseenter', () => {
    // Clear any active picker highlight first
    if (swHighlightedEl) {
      swHighlightedEl.classList.remove('__sw_pick_hi__');
      swHighlightedEl = null;
    }
    let target: Element | null = null;
    try { target = document.querySelector(ann.selectors.primary); } catch (_) {}
    if (target instanceof HTMLElement) {
      target.classList.add('__sw_ann_hi__');
      swMarkerFocusEl = target;
    }
  });

  marker.addEventListener('mouseleave', () => {
    if (swMarkerFocusEl) {
      swMarkerFocusEl.classList.remove('__sw_ann_hi__');
      swMarkerFocusEl = null;
    }
  });

  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    const mr = marker.getBoundingClientRect();
    showEditPopup(ann, mr.right + 6, mr.top);
  });

  document.body.appendChild(marker);
}

function swRemoveAllMarkers(): void {
  document.querySelectorAll('.__sw_marker__').forEach(m => m.remove());
  swActiveTip?.remove();
  swActiveTip = null;
}

function swSetMarkersVisibility(visible: boolean): void {
  document.querySelectorAll<HTMLElement>('.__sw_marker__').forEach(m => {
    m.style.display = visible ? '' : 'none';
  });
}

function swUpdateCount(n: number): void {
  const badge = document.getElementById('__sw_badge__');
  if (badge) {
    badge.textContent = String(n);
    badge.classList.toggle('show', n > 0);
  }
}


function swDeleteAnnotation(id: string): void {
  chrome.storage.local.get('smartwriterAnnotations', (result) => {
    const kept = (result.smartwriterAnnotations || []).filter((a: SwAnnotation) => a.id !== id);
    chrome.storage.local.set({ smartwriterAnnotations: kept }, () => {
      swRefreshMarkers();
      swShowToast('Annotation deleted');
    });
  });
}

function showEditPopup(ann: SwAnnotation, clientX: number, clientY: number): void {
  document.getElementById('__sw_ann_popup__')?.remove();
  cancelPickingElement();

  const popup = document.createElement('div');
  popup.id = '__sw_ann_popup__';

  const closePopup = () => {
    popup.remove();
    document.removeEventListener('keydown', escHandler);
    if (document.getElementById('__sw_launcher__') && swFocusModeOn) startPickingElement();
  };

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); document.getElementById('__sw_save_btn__')?.click(); }
  };

  const bc = ann.selectors.primary + (ann.framework?.componentName ? ` · ${ann.framework.componentName}` : '');

  popup.innerHTML = `
    <div class="__sw_ph2__">
      <span class="__sw_pt__">Edit Annotation</span>
      <button class="__sw_px__" id="__sw_close_popup__">×</button>
    </div>
    <div class="__sw_ppath__" title="${swEscHtml(bc)}">${swEscHtml(bc)}</div>
    <div class="__sw_pbody__">
      <div class="__sw_fl__">Comment</div>
      <textarea class="__sw_ta__" id="__sw_note_text__" placeholder="Describe the issue...">${swEscHtml(ann.note)}</textarea>
      <div class="__sw_fl__">Type</div>
      <div class="__sw_pills__" id="__sw_type_pills__">
        <button class="__sw_pill__ __sw_pstep__${ann.type === 'step' ? ' sel' : ''}" data-type="step">✅ Step</button>
        <button class="__sw_pill__ __sw_pbug__${ann.type === 'bug' ? ' sel' : ''}" data-type="bug">🐛 Bug</button>
        <button class="__sw_pill__ __sw_pchg__${ann.type === 'change' ? ' sel' : ''}" data-type="change">✏️ Change</button>
      </div>
      <div class="__sw_pfoot__">
        <button class="__sw_fpb__ __sw_fdel__" id="__sw_delete_btn__">🗑 Delete</button>
        <button class="__sw_fpb__ __sw_fpc__" id="__sw_cancel_btn__">Cancel</button>
        <button class="__sw_fpb__ __sw_fps__" id="__sw_save_btn__">Save <kbd>Ctrl+↵</kbd></button>
      </div>
    </div>
  `;

  const popupW = 380, popupH = 480;
  let left = clientX;
  let top = clientY - Math.round(popupH / 2);
  if (left + popupW > window.innerWidth - 10) left = clientX - popupW - 12;
  if (top + popupH > window.innerHeight - 10) top = window.innerHeight - popupH - 10;
  popup.style.left = `${Math.max(10, left)}px`;
  popup.style.top = `${Math.max(10, top)}px`;

  document.body.appendChild(popup);
  document.addEventListener('keydown', escHandler);

  let selectedType: 'change' | 'step' | 'bug' = ann.type;

  popup.querySelectorAll<HTMLElement>('#__sw_type_pills__ .__sw_pill__').forEach(btn => {
    btn.addEventListener('click', () => {
      popup.querySelectorAll('#__sw_type_pills__ .__sw_pill__').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      selectedType = btn.dataset.type as 'change' | 'step' | 'bug';
    });
  });

  setTimeout(() => {
    const ta = document.getElementById('__sw_note_text__') as HTMLTextAreaElement;
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }, 60);

  document.getElementById('__sw_close_popup__')!.addEventListener('click', closePopup);
  document.getElementById('__sw_cancel_btn__')!.addEventListener('click', closePopup);

  document.getElementById('__sw_delete_btn__')!.addEventListener('click', () => {
    closePopup();
    swDeleteAnnotation(ann.id);
  });

  document.getElementById('__sw_save_btn__')!.addEventListener('click', () => {
    const note = (document.getElementById('__sw_note_text__') as HTMLTextAreaElement).value.trim();

    chrome.storage.local.get('smartwriterAnnotations', (result) => {
      const list: SwAnnotation[] = result.smartwriterAnnotations || [];
      const idx = list.findIndex(a => a.id === ann.id);
      if (idx >= 0) {
        const { severity: _severity, ...cleanAnnotation } = list[idx] as SwAnnotation & { severity?: unknown };
        list[idx] = { ...cleanAnnotation, type: selectedType, note };
        chrome.storage.local.set({ smartwriterAnnotations: list }, () => swRefreshMarkers());
      }
    });
    closePopup();
    swShowToast('Annotation updated');
  });
}

// --- Smart Selector Generation ---

function getFullCssPath(el: HTMLElement): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    if ((current as HTMLElement).id) {
      part += `#${(current as HTMLElement).id}`;
      parts.unshift(part);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent && parent.children.length > 1) {
      const idx = Array.from(parent.children).indexOf(current) + 1;
      part += `:nth-child(${idx})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}

function getXPath(el: HTMLElement): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.nodeName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c: Element) => c.nodeName === current!.nodeName);
      const idx = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}[${idx}]` : tag);
    } else {
      parts.unshift(tag);
    }
    current = parent;
  }
  return '/' + parts.join('/');
}

interface SwAnnotationSelectors {
  primary: string;
  testId?: string;
  id?: string;
  cssPath: string;
  xpath: string;
  text?: string;
}

function generateSmartSelectors(el: HTMLElement): SwAnnotationSelectors {
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy')
    || el.getAttribute('data-test') || el.getAttribute('data-qa') || undefined;
  const id = el.id || undefined;
  const cssPath = getFullCssPath(el);
  const xpath = getXPath(el);
  const text = el.textContent?.trim().substring(0, 60) || undefined;

  let primary: string;
  if (testId) {
    primary = `[data-testid="${testId}"]`;
  } else if (id) {
    primary = `#${id}`;
  } else {
    primary = cssPath;
  }

  return {
    primary,
    testId: testId ? `[data-testid="${testId}"]` : undefined,
    id: id ? `#${id}` : undefined,
    cssPath,
    xpath,
    text,
  };
}

// --- Framework Detection ---

interface SwAnnotationFramework {
  type: 'react' | 'vue' | 'next' | 'nuxt' | 'unknown';
  componentName?: string;
  componentChain?: string[];
}

function detectFramework(el: HTMLElement): SwAnnotationFramework {
  // React / Next.js — walk the fiber tree
  const reactKey = Object.keys(el).find(k =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
  );
  if (reactKey) {
    const chain: string[] = [];
    let fiber = (el as any)[reactKey];
    while (fiber && chain.length < 8) {
      const type = fiber.type;
      if (type && typeof type === 'function' && type.name && type.name.length > 1
          && type.name !== 'div' && type.name !== 'span' && !chain.includes(type.name)) {
        chain.push(type.name);
      } else if (type && typeof type === 'object' && type.displayName
          && !chain.includes(type.displayName)) {
        chain.push(type.displayName);
      }
      fiber = fiber.return;
    }
    const isNext = typeof (window as any).__NEXT_DATA__ !== 'undefined';
    return {
      type: isNext ? 'next' : 'react',
      componentName: chain[0],
      componentChain: chain.length > 0 ? chain : undefined,
    };
  }

  // Vue / Nuxt.js
  const vueEl = el as any;
  const vueComp = vueEl.__vueParentComponent || vueEl.__vue__;
  if (vueComp || vueEl._vei) {
    const isNuxt = typeof (window as any).__nuxt !== 'undefined'
      || typeof (window as any).$nuxt !== 'undefined';
    return {
      type: isNuxt ? 'nuxt' : 'vue',
      componentName: vueComp?.type?.__name || vueComp?.type?.name || undefined,
    };
  }

  if (typeof (window as any).__NEXT_DATA__ !== 'undefined') return { type: 'next' };
  if (typeof (window as any).__nuxt !== 'undefined'
      || typeof (window as any).$nuxt !== 'undefined') return { type: 'nuxt' };

  return { type: 'unknown' };
}

// --- Annotation Storage ---

interface SwAnnotation {
  id: string;
  url: string;
  timestamp: string;
  type: 'change' | 'step' | 'bug';
  note: string;
  stepNumber?: number;
  selectors: SwAnnotationSelectors;
  element: {
    tag: string;
    text?: string;
    classList: string[];
    attributes: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
  };
  framework: SwAnnotationFramework;
}

function swSaveAnnotation(annotation: SwAnnotation): void {
  chrome.storage.local.get('smartwriterAnnotations', (result) => {
    const list: SwAnnotation[] = result.smartwriterAnnotations || [];
    list.push(annotation);
    chrome.storage.local.set({ smartwriterAnnotations: list }, () => {
      swRefreshMarkers();
    });
  });
}

function swGetNextStep(callback: (n: number) => void): void {
  chrome.storage.local.get('smartwriterAnnotations', (result) => {
    const list: SwAnnotation[] = result.smartwriterAnnotations || [];
    const url = window.location.href;
    const steps = list.filter(a => a.url === url);
    const max = steps.reduce((m, a) => Math.max(m, a.stepNumber ?? 0), 0);
    callback(max + 1);
  });
}

function swEscHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function swGetRelevantAttrs(el: HTMLElement): Record<string, string> {
  const names = ['id', 'class', 'type', 'name', 'href', 'src', 'alt', 'placeholder',
    'aria-label', 'role', 'data-testid', 'data-cy', 'data-test', 'data-qa', 'for'];
  const attrs: Record<string, string> = {};
  for (const attr of names) {
    const val = el.getAttribute(attr);
    if (val) attrs[attr] = val.substring(0, 200);
  }
  return attrs;
}

// --- Annotation Popup ---

function showAnnotationPopup(el: HTMLElement, clientX: number, clientY: number): void {
  document.getElementById('__sw_ann_popup__')?.remove();
  el.classList.add('__sw_pick_hi__');

  const selectors = generateSmartSelectors(el);
  const framework = detectFramework(el);

  const breadcrumb = (() => {
    let s = selectors.primary;
    if (framework.componentName) s += ` · ${framework.componentName}`;
    return s;
  })();

  swGetNextStep((nextStep) => {
    const popup = document.createElement('div');
    popup.id = '__sw_ann_popup__';

    const closePopup = () => {
      popup.remove();
      el.classList.remove('__sw_pick_hi__');
      document.removeEventListener('keydown', escHandler);
      // restart picking only if the widget is still on the page and focus mode is on
      if (document.getElementById('__sw_launcher__') && swFocusModeOn) startPickingElement();
    };

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); document.getElementById('__sw_save_btn__')?.click(); }
    };

    popup.innerHTML = `
      <div class="__sw_ph2__">
        <span class="__sw_pt__">Add Annotation</span>
        <button class="__sw_px__" id="__sw_close_popup__">×</button>
      </div>
      <div class="__sw_ppath__" title="${swEscHtml(breadcrumb)}">${swEscHtml(breadcrumb)}</div>
      <div class="__sw_pbody__">
        <div class="__sw_fl__">Comment</div>
        <textarea class="__sw_ta__" id="__sw_note_text__" placeholder="Describe the issue..."></textarea>
        <div class="__sw_fl__">Type</div>
        <div class="__sw_pills__" id="__sw_type_pills__">
          <button class="__sw_pill__ __sw_pstep__ sel" data-type="step">✅ Step</button>
          <button class="__sw_pill__ __sw_pbug__" data-type="bug">🐛 Bug</button>
          <button class="__sw_pill__ __sw_pchg__" data-type="change">✏️ Change</button>
        </div>
        <div class="__sw_pfoot__">
          <button class="__sw_fpb__ __sw_fpc__" id="__sw_cancel_btn__">Cancel</button>
          <button class="__sw_fpb__ __sw_fps__" id="__sw_save_btn__">Save <kbd>Ctrl+↵</kbd></button>
        </div>
      </div>
    `;

    // Position popup near click, clamped to viewport
    const popupW = 380, popupH = 480;
    let left = clientX + 12;
    let top = clientY - Math.round(popupH / 2);
    if (left + popupW > window.innerWidth - 10) left = clientX - popupW - 12;
    if (top + popupH > window.innerHeight - 10) top = window.innerHeight - popupH - 10;
    popup.style.left = `${Math.max(10, left)}px`;
    popup.style.top = `${Math.max(10, top)}px`;

    document.body.appendChild(popup);
    document.addEventListener('keydown', escHandler);

    let selectedType: 'change' | 'step' | 'bug' = 'step';

    popup.querySelectorAll<HTMLElement>('#__sw_type_pills__ .__sw_pill__').forEach(btn => {
      btn.addEventListener('click', () => {
        popup.querySelectorAll('#__sw_type_pills__ .__sw_pill__').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');
        selectedType = btn.dataset.type as 'change' | 'step' | 'bug';
        document.getElementById('__sw_si__')!.classList.toggle('show', selectedType === 'step');
      });
    });

    setTimeout(() => (document.getElementById('__sw_note_text__') as HTMLTextAreaElement)?.focus(), 60);

    document.getElementById('__sw_close_popup__')!.addEventListener('click', closePopup);
    document.getElementById('__sw_cancel_btn__')!.addEventListener('click', closePopup);

    document.getElementById('__sw_save_btn__')!.addEventListener('click', () => {
      const note = (document.getElementById('__sw_note_text__') as HTMLTextAreaElement).value.trim();

      const rect = el.getBoundingClientRect();
      const annotation: SwAnnotation = {
        id: `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        url: window.location.href,
        timestamp: new Date().toISOString(),
        type: selectedType,
        note,
        stepNumber: nextStep,
        selectors,
        element: {
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 200) || undefined,
          classList: Array.from(el.classList).filter(c => !c.startsWith('__sw_')),
          attributes: swGetRelevantAttrs(el),
          rect: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        },
        framework,
      };

      swSaveAnnotation(annotation);
      closePopup();
      swShowToast(`Saved: ${selectedType.charAt(0).toUpperCase() + selectedType.slice(1)}`);
    });
  });
}

function swShowToast(msg: string): void {
  document.getElementById('__sw_toast__')?.remove();
  const toast = document.createElement('div');
  toast.id = '__sw_toast__';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 220);
    }, 1800);
  });
}

// ==================== END TRACKING SYSTEM ====================

chrome.runtime
  .sendMessage({ type: 'REGISTER', tabId: (chrome.runtime as any).id, url: window.location.href })
  .catch(() => {
    // Ignore errors during registration
  });

// Re-apply tracking widget if it was active before navigation
chrome.runtime.sendMessage({ type: 'GET_TRACKING_STATE' })
  .then((resp: any) => { if (resp?.active) injectTrackingWidget(); })
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.smartwriterAnnotations) return;
  if (!document.getElementById('__sw_launcher__')) return;
  swRefreshMarkers();
});
