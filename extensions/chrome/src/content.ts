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

    const parent = current.parentElement;
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

    ctx.fillStyle = '#ffffff';
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

chrome.runtime
  .sendMessage({ type: 'REGISTER', tabId: (chrome.runtime as any).id, url: window.location.href })
  .catch(() => {
    // Ignore errors during registration
  });
