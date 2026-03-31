import type { ContentMessage, ContentResponse } from './types';

browser.runtime.onMessage.addListener(
  (message: ContentMessage, sender: any, sendResponse: (response: ContentResponse) => void) => {
    handleMessage(message, sendResponse);
    return true;
  }
);

async function handleMessage(message: ContentMessage, sendResponse: (response: ContentResponse) => void) {
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
        window.location.href = message.url;
        result = { navigating: true, url: message.url };
        break;
      case 'EVALUATE':
        result = await evaluateScript(message.script, message.args);
        break;
      case 'HOVER':
        result = await handleHover(message.selector);
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

async function handleClick(selector: string): Promise<unknown> {
  const element = document.querySelector(selector) as HTMLElement | null;
  if (!element) throw new Error(`Element not found: ${selector}`);
  element.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  return { clicked: true, selector };
}

async function handleType(selector: string, text: string): Promise<unknown> {
  const element = document.querySelector(selector) as HTMLInputElement | null;
  if (!element) throw new Error(`Element not found: ${selector}`);
  element.focus();
  element.value = '';
  for (const char of text) {
    element.value += char;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { typed: true, selector, text };
}

async function handleFill(selector: string, value: string): Promise<unknown> {
  const element = document.querySelector(selector) as HTMLInputElement | null;
  if (!element) throw new Error(`Element not found: ${selector}`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { filled: true, selector, value };
}

async function handleSelect(selector: string, options: string[]): Promise<unknown> {
  const element = document.querySelector(selector) as HTMLSelectElement | null;
  if (!element) throw new Error(`Element not found: ${selector}`);
  element.value = options[0];
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: true, selector, option: options[0] };
}

async function handleHover(selector: string): Promise<unknown> {
  const element = document.querySelector(selector) as HTMLElement | null;
  if (!element) throw new Error(`Element not found: ${selector}`);
  const event = new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window });
  element.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve, 100));
  return { hovered: true, selector };
}

async function evaluateScript(script: string, args?: unknown[]): Promise<unknown> {
  const fn = new Function(...(args?.map((_, i) => `arg${i}`) || []), script);
  return fn(...(args || []));
}

function getSnapshot(selector?: string): unknown {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error(`Element not found: ${selector}`);
  const tree = buildA11yTree(root as HTMLElement);
  return {
    url: window.location.href,
    title: document.title,
    tree,
    html: root.innerHTML.substring(0, 10000),
  };
}

interface A11yNode {
  tag: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  children: A11yNode[];
  selector?: string;
}

function buildA11yTree(element: HTMLElement, maxDepth = 10): A11yNode {
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
  };

  for (let i = 0; i < Math.min(element.children.length, 20); i++) {
    const child = element.children[i] as HTMLElement;
    if (child.offsetHeight > 0 && child.offsetWidth > 0) {
      node.children.push(buildA11yTree(child, maxDepth - 1));
    }
  }

  return node;
}

function getCssSelector(element: HTMLElement): string {
  if (element.id) return `#${element.id}`;
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
      path.unshift(selector);
      break;
    }
    const siblings = current.parentElement?.children || [];
    if (siblings.length > 1) {
      const index = Array.from(siblings).indexOf(current) + 1;
      selector += `:nth-child(${index})`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(' > ');
}

async function takeScreenshot(): Promise<unknown> {
  const canvas = document.createElement('canvas');
  const rect = document.body.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, width: canvas.width, height: canvas.height };
}

async function waitForText(text: string, timeout = 5000): Promise<unknown> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (document.body.textContent?.includes(text)) {
      return { found: true, text };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Text not found within ${timeout}ms: ${text}`);
}

async function pressKey(key: string): Promise<unknown> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.activeElement?.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve, 50));
  return { keyPressed: true, key };
}

function getText(selector: string): unknown {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return { text: element.textContent, selector };
}

function getAttribute(selector: string, attribute: string): unknown {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return { value: element.getAttribute(attribute), attribute, selector };
}

browser.runtime.sendMessage({ type: 'REGISTER', tabId: 0, url: window.location.href }).catch(() => {});
