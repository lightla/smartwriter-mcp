#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import net from 'net';
import { execSync, execFileSync } from 'child_process';
import { realpathSync, existsSync, statSync, readFileSync } from 'fs';
import path from 'path';

const DEFAULT_PORT = 9223;

// Global cache for component discovery to boost performance
const FINGERPRINT_CACHE = new Map<string, string>();

/**
 * Fast file search using ripgrep or grep
 */
function fastSearch(term: string, searchPath: string): string[] {
  const matches = new Set<string>();
  try {
    // Priority 1: ripgrep (rg) - extremely fast
    try {
      const rgOutput = execFileSync(
        'rg',
        ['-l', '--max-depth', '10', '--no-ignore', '-g', '*.vue', '-g', '*.tsx', '-g', '*.jsx', term, searchPath],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
      );
      rgOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .forEach((file) => matches.add(file));
    } catch { /* rg not found or no results, fallback to grep */ }
    if (matches.size > 0) return [...matches];

    // Priority 2: optimized grep
    const grepOutput = execFileSync(
      'grep',
      [
        '-R',
        '-l',
        '--include=*.vue',
        '--include=*.tsx',
        '--include=*.jsx',
        '--exclude-dir=node_modules',
        term,
        searchPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    grepOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .forEach((file) => matches.add(file));
    return [...matches];
  } catch {
    return [];
  }
}

type CliOptions = {
  port?: number;
  autoFreePort: boolean;
};

function parsePort(value: string, source: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[Smartwriter MCP] Invalid ${source} port: ${value}`);
  }
  return port;
}

function getCliOptions(): CliOptions {
  const options: CliOptions = { autoFreePort: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      options.port = parsePort(args[++i], 'CLI');
    } else if (args[i] === '--auto-free-port' || args[i] === '--auto-port') {
      options.autoFreePort = true;
    }
  }
  return options;
}

type ProcessEntry = {
  pid: number;
  args: string;
};

function listProcesses(): ProcessEntry[] {
  try {
    const output = execSync('ps -eo pid=,args=', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(' ');
        if (firstSpace < 0) return null;
        const pid = Number.parseInt(line.slice(0, firstSpace), 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;
        return { pid, args: line.slice(firstSpace + 1).trim() };
      })
      .filter((entry): entry is ProcessEntry => entry !== null);
  } catch {
    return [];
  }
}

function getParentPid(pid: number): number | null {
  try {
    const output = execSync(`ps -o ppid= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const parentPid = Number.parseInt(output, 10);
    return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
  } catch {
    return null;
  }
}

function getAncestorPids(pid: number): Set<number> {
  const ancestors = new Set<number>();
  let currentPid = pid;
  for (let i = 0; i < 32; i++) {
    const parentPid = getParentPid(currentPid);
    if (!parentPid || ancestors.has(parentPid) || parentPid === currentPid) break;
    ancestors.add(parentPid);
    currentPid = parentPid;
  }
  return ancestors;
}

function getCurrentScriptPath(): string {
  const argvPath = process.argv[1];
  if (!argvPath) return '';
  try {
    return realpathSync(argvPath);
  } catch {
    return path.resolve(argvPath);
  }
}

const COMMAND_MAP: Record<string, string> = {
  click: 'CLICK',
  type: 'TYPE',
  fill: 'FILL',
  select_option: 'SELECT',
  check: 'CHECK',
  uncheck: 'UNCHECK',
  navigate: 'NAVIGATE',
  go_back: 'GO_BACK',
  go_forward: 'GO_FORWARD',
  reload: 'RELOAD',
  evaluate: 'EVALUATE',
  screenshot: 'SCREENSHOT',
  get_snapshot: 'GET_SNAPSHOT',
  hover: 'HOVER',
  press_key: 'PRESS_KEY',
  wait_for: 'WAIT_FOR',
  get_text: 'GET_TEXT',
  get_attribute: 'GET_ATTRIBUTE',
  get_dom_element: 'GET_ELEMENT_BY_MARKER',
  get_component_source: 'GET_COMPONENT_ORIGIN',
  flow_get_tab_ids: 'GET_FLOW_TAB_IDS',
  tab_get_all_compact_info: 'GET_TABS_COMPACT_INFO',
  tab_connect: 'CONNECT_TAB',
  tab_disconnect: 'DISCONNECT_TAB',
  tab_focus_connected: 'JUMP_CONNECTED_TAB',
  get_detailed_annotations: 'GET_DETAILED_ANNOTATIONS',
  flow_get_detail_anotations: 'GET_GLOBAL_DETAILED_ANNOTATIONS',
  get_compact_annotations: 'GET_COMPACT_ANNOTATIONS',
  flow_get_compact_annotations: 'GET_GLOBAL_COMPACT_ANNOTATIONS',
  clear_all_anotations: 'CLEAR_ALL_ANOTATIONS',
  flow_clear_all_anotations: 'CLEAR_GLOBAL_ALL_ANOTATIONS',
};

const TOOLS = [
  {
    name: 'cli_list_tools',
    description: 'List all Smartwriter MCP tools and their descriptions',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'click',
    description: 'Click an element in the connected tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an input element char by char',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
        text: { type: 'string' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'fill',
    description: 'Fill an input element with a value instantly',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
        value: { type: 'string' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'select_option',
    description: 'Select an option in a select element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
        options: { type: 'array', items: { type: 'string' }, description: 'List of option values to select; first value will be used' },
      },
      required: ['selector', 'options'],
    },
  },
  {
    name: 'check',
    description: 'Check a checkbox or radio input',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'uncheck',
    description: 'Uncheck a checkbox input',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the connected browser tab to a URL',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description: 'Go back to the previous page in the connected tab',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'go_forward',
    description: 'Go forward to the next page in the connected tab',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'reload',
    description: 'Reload the connected browser tab',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'evaluate',
    description: 'Execute JavaScript in the connected tab and return result. Optionally pass marker like a:1 from get_compact_annotations or index to expose the resolved DOM node as `element` inside the script.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional positional arguments available as arg0, arg1, ... inside the script' },
        marker: { type: 'string', description: 'Optional annotation marker from get_compact_annotations, e.g. a:1' },
        index: { type: 'number', description: 'Optional annotation index from get_compact_annotations; resolved element is available as `element` inside the script' },
      },
      required: ['script'],
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_snapshot',
    description: 'Get accessibility snapshot of the current page',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector or annotation marker like a:1 from get_compact_annotations to scope snapshot' },
      },
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key on the focused element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Key to press e.g. Enter, Escape, Tab' },
      },
      required: ['key'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for text to appear on the page',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string' },
        timeout: { type: 'number', description: 'Timeout in ms (default 5000)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_text',
    description: 'Get text content from an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_compact_annotations' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'get_attribute',
    description: 'Get an attribute value from an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_annotations' },
        attribute: { type: 'string' },
      },
      required: ['selector', 'attribute'],
    },
  },
  {
    name: 'get_dom_element',
    description: 'Get detailed DOM element information (tag, classes, attributes, text) for a specific target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Target selector (CSS/XPath/coords/marker like a:1) from get_summary_annotations' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'get_component_source',
    description: 'Get the framework component source file and line number for a specific target. Supports cross-project discovery via project_path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Target selector (CSS/XPath/coords/marker like a:1) from get_summary_annotations' },
        project_path: { type: 'string', description: 'Optional: Path to the source code directory if it is different from the current workspace.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'flow_get_tab_ids',
    description: 'Get flow tab IDs sorted as t:1..t:n.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tab_get_all_compact_info',
    description: 'Get compact flow tab info in PSV: tabId|tabTitle.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tab_connect',
    description: 'Connect to a tab (by t:1 or internal ID) to start sending commands to it',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'string', description: 'Flow ID like t:1 or a numeric Tab ID' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'tab_disconnect',
    description: 'Disconnect a tab from the current session or flow',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'string', description: 'Optional: Flow ID or numeric Tab ID. Defaults to the currently connected tab.' },
      },
    },
  },
  {
    name: 'tab_focus_connected',
    description: 'Focus and bring the currently connected tab to the front',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'cli_server_info',
    description: 'Show current smartwriter-mcp server info: port, PID, and Chrome extension connection status',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'cli_kill_other_instances',
    description: 'Kill all other smartwriter-mcp instances running on this machine, keeping only the current one',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_detailed_annotations',
    description: 'Get detailed annotations for the currently connected tab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['step', 'change', 'bug'], description: 'Filter by annotation type (optional)' },
      },
    },
  },
  {
    name: 'flow_get_detail_anotations',
    description: 'Get detailed annotations across flow tabs, sorted by annotation id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['step', 'change', 'bug'], description: 'Filter by annotation type (optional)' },
      },
    },
  },
  {
    name: 'get_compact_annotations',
    description: 'Get compact tracked annotations for the connected tab. Returns id|pageId|type|note plus pageId|url mapping.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['step', 'change', 'bug'], description: 'Filter by annotation type (optional)' },
      },
    },
  },
  {
    name: 'flow_get_compact_annotations',
    description: 'Get compact tracked annotations across flow tabs. Returns id|pageId|flowId|type|note plus pageId|url mapping, sorted by annotation id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['step', 'change', 'bug'], description: 'Filter by annotation type (optional)' },
      },
    },
  },
  {
    name: 'clear_all_anotations',
    description: 'Clear all tracked annotations for the connected tab.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'flow_clear_all_anotations',
    description: 'Clear all tracked annotations across flow tabs.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function escapePsvCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');
}

function csvEscapeCell(value: string): string {
  // CSV-like escaping for comma-separated values inside a single PSV cell.
  // Wrap in double-quotes if the cell contains a comma, quote, or newline.
  if (/[,"\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function kvEscapeCell(value: string): string {
  // Escaping for k=v pairs joined by ';' inside a single PSV cell.
  // Quote when ambiguous (contains separators or quotes/newlines).
  if (/[;=,"\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function isScalarLike(value: unknown): value is string | number | boolean | bigint | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

function toScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return Object.prototype.toString.call(value);
}

function flattenPsvRows(value: unknown, key = 'value', rows: Array<[string, string]> = []): Array<[string, string]> {
  if (value === null || value === undefined) {
    rows.push([key, '']);
    return rows;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push([key, '']);
      return rows;
    }
    if (value.every(isScalarLike)) {
      const csv = value.map((v) => csvEscapeCell(toScalar(v))).join(',');
      rows.push([`${key}[]`, csv]);
      return rows;
    }

    // Common shape: [{ name, value }, ...] (e.g. fingerprints.allAttrs)
    if (
      value.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.prototype.hasOwnProperty.call(item, 'name') &&
          Object.prototype.hasOwnProperty.call(item, 'value') &&
          isScalarLike((item as any).name) &&
          isScalarLike((item as any).value)
      )
    ) {
      const csv = (value as Array<{ name: unknown; value: unknown }>)
        .map((entry) => `${toScalar(entry.name)}=${toScalar(entry.value)}`)
        .map(csvEscapeCell)
        .join(',');
      rows.push([`${key}[]`, csv]);
      return rows;
    }

    value.forEach((item, index) => {
      flattenPsvRows(item, `${key}[${index}]`, rows);
    });
    return rows;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      rows.push([key, '']);
      return rows;
    }

    // If this object is a flat map of scalar values, keep it on one line to avoid noisy repetition
    // like `selectors.primary`, `selectors.cssPath`, etc.
    if (entries.every(([, childValue]) => isScalarLike(childValue))) {
      const csv = entries
        .map(([childKey, childValue]) => `${childKey}=${toScalar(childValue)}`)
        .map(csvEscapeCell)
        .join(',');
      rows.push([key, csv]);
      return rows;
    }

    entries.forEach(([childKey, childValue]) => {
      const nextKey = key === 'value' ? childKey : `${key}.${childKey}`;
      flattenPsvRows(childValue, nextKey, rows);
    });
    return rows;
  }

  rows.push([key, toScalar(value)]);
  return rows;
}

function flattenToKvPairs(
  value: unknown,
  prefix: string,
  pairs: Array<[string, string]>,
  ctx?: { elementText?: string }
): void {
  if (value === null || value === undefined) {
    pairs.push([prefix, '']);
    return;
  }

  if (isScalarLike(value)) {
    pairs.push([prefix, toScalar(value)]);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      pairs.push([`${prefix}[]`, '']);
      return;
    }
    if (value.every(isScalarLike)) {
      pairs.push([`${prefix}[]`, value.map((v) => csvEscapeCell(toScalar(v))).join(',')]);
      return;
    }
    if (
      value.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.prototype.hasOwnProperty.call(item, 'name') &&
          Object.prototype.hasOwnProperty.call(item, 'value') &&
          isScalarLike((item as any).name) &&
          isScalarLike((item as any).value)
      )
    ) {
      const csv = (value as Array<{ name: unknown; value: unknown }>)
        .map((entry) => `${toScalar(entry.name)}=${toScalar(entry.value)}`)
        .map(csvEscapeCell)
        .join(',');
      pairs.push([`${prefix}[]`, csv]);
      return;
    }
    value.forEach((item, index) => {
      flattenToKvPairs(item, `${prefix}[${index}]`, pairs, ctx);
    });
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Special-case: attributes map => key[] as name=value CSV (minimal, stable for agents).
    if (prefix.endsWith('attributes') || prefix === 'attributes') {
      const entries = Object.entries(obj).filter(([, v]) => isScalarLike(v));
      const csv = entries
        .map(([k, v]) => `${k}=${toScalar(v)}`)
        .map(csvEscapeCell)
        .join(',');
      pairs.push([`${prefix}[]`, csv]);
      return;
    }

    // Special-case: DOMRect-like object => keep minimal fields, one key
    if (prefix.endsWith('rect') || prefix === 'rect') {
      const x = isScalarLike(obj.x) ? toScalar(obj.x) : '';
      const y = isScalarLike(obj.y) ? toScalar(obj.y) : '';
      const w = isScalarLike(obj.width) ? toScalar(obj.width) : '';
      const h = isScalarLike(obj.height) ? toScalar(obj.height) : '';
      const parts = [
        x ? `x=${x}` : '',
        y ? `y=${y}` : '',
        w ? `w=${w}` : '',
        h ? `h=${h}` : '',
      ].filter(Boolean);
      pairs.push([prefix, parts.join(',')]);
      return;
    }

    // Special-case: selectors often repeats primary/cssPath
    if (prefix.endsWith('selectors') || prefix === 'selectors') {
      const primary = isScalarLike(obj.primary) ? toScalar(obj.primary) : '';
      const cssPath = isScalarLike(obj.cssPath) ? toScalar(obj.cssPath) : '';
      const xpath = isScalarLike(obj.xpath) ? toScalar(obj.xpath) : '';
      const text = isScalarLike(obj.text) ? toScalar(obj.text) : '';

      // Minimal selector payload: keep `primary` when present; otherwise fall back to cssPath/xpath.
      if (primary) {
        pairs.push([`${prefix}.primary`, primary]);
      } else if (cssPath) {
        pairs.push([`${prefix}.cssPath`, cssPath]);
      } else if (xpath) {
        pairs.push([`${prefix}.xpath`, xpath]);
      }

      // `selectors.text` is often redundant with element text; keep only if different and non-empty.
      if (text && (!ctx?.elementText || text !== ctx.elementText)) pairs.push([`${prefix}.text`, text]);

      const extraKeys = Object.keys(obj).filter((k) => !['primary', 'cssPath', 'xpath', 'text'].includes(k));
      extraKeys.forEach((k) => {
        const nextPrefix = `${prefix}.${k}`;
        flattenToKvPairs(obj[k], nextPrefix, pairs, ctx);
      });
      return;
    }

    // Special-case: fingerprints => compress scalar hints, keep arrays separately
    if (prefix === 'fingerprints') {
      const scalarEntries = Object.entries(obj).filter(
        ([k, v]) =>
          k !== 'classList' &&
          k !== 'allAttrs' &&
          isScalarLike(v)
      ) as Array<[string, string | number | boolean | bigint | null | undefined]>;
      if (scalarEntries.length) {
        const csv = scalarEntries
          .map(([k, v]) => `${k}=${toScalar(v)}`)
          .map(csvEscapeCell)
          .join(',');
        pairs.push([prefix, csv]);
      }
      if (Object.prototype.hasOwnProperty.call(obj, 'classList')) {
        flattenToKvPairs(obj.classList, `${prefix}.classList`, pairs, ctx);
      }
      if (Object.prototype.hasOwnProperty.call(obj, 'allAttrs')) {
        flattenToKvPairs(obj.allAttrs, `${prefix}.allAttrs`, pairs, ctx);
      }
      const extraKeys = Object.keys(obj).filter((k) => !['classList', 'allAttrs', ...scalarEntries.map(([k]) => k)].includes(k));
      extraKeys.forEach((k) => {
        flattenToKvPairs(obj[k], `${prefix}.${k}`, pairs, ctx);
      });
      return;
    }

    Object.entries(obj).forEach(([k, v]) => {
      const nextPrefix = prefix ? `${prefix}.${k}` : k;
      flattenToKvPairs(v, nextPrefix, pairs, ctx);
    });
    return;
  }

  // Fallback
  pairs.push([prefix, toScalar(value)]);
}

function toCompactPsv(value: unknown): string {
  const rows: Array<[string, string]> = [];
  const header: [string, string] = ['path', 'data'];

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (isScalarLike(item)) {
        rows.push([`value[${index}]`, toScalar(item)]);
        return;
      }

      const elementText =
        item && typeof item === 'object' && !Array.isArray(item)
          ? (item as any)?.element?.text
          : undefined;

      const pairs: Array<[string, string]> = [];
      flattenToKvPairs(item, '', pairs, { elementText: typeof elementText === 'string' ? elementText : undefined });
      const compact = pairs
        .filter(([k]) => k.length > 0)
        .map(([k, v]) => `${k}=${kvEscapeCell(v)}`)
        .join(';');
      rows.push([`value[${index}]`, compact]);
    });

    return [header.join('|'), ...rows.map(([k, v]) => `${escapePsvCell(k)}|${escapePsvCell(v)}`)].join('\n');
  }

  if (isScalarLike(value)) {
    return [header.join('|'), `value|${escapePsvCell(toScalar(value))}`].join('\n');
  }

  const pairs: Array<[string, string]> = [];
  flattenToKvPairs(value, '', pairs);
  const compact = pairs
    .filter(([k]) => k.length > 0)
    .map(([k, v]) => `${k}=${kvEscapeCell(v)}`)
    .join(';');
  return [header.join('|'), `value|${escapePsvCell(compact)}`].join('\n');
}

function toPsv(value: unknown): string {
  return toCompactPsv(value);
}

function textResponse(data: unknown) {
  if (typeof data === 'string') return { content: [{ type: 'text', text: data }] };
  return { content: [{ type: 'text', text: toPsv(data) }] };
}

function errorResponse(error: unknown) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

async function main() {
  const options = getCliOptions();
  const requestedPort = options.port || DEFAULT_PORT;

  let extensionWs: WebSocket | null = null;
  const pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: any) => void; timeout: NodeJS.Timeout }
  >();

  async function sendToExtension(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome extension not connected');
    }
    const requestId = Math.random().toString(36).substring(2);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Extension request timeout (${command})`));
      }, 35000);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      extensionWs!.send(JSON.stringify({ type: 'COMMAND', command, requestId, args }));
    });
  }

  async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, '127.0.0.1');
    });
  }

  let port = requestedPort;
  if (options.autoFreePort) {
    while (port <= 65535 && !(await isPortAvailable(port))) {
      port++;
    }
    if (port > 65535) {
      throw new Error(`[Smartwriter MCP] Could not find an available port from ${requestedPort} to 65535`);
    }
  }

  const wss = new WebSocketServer({ port });
  process.stderr.write(`[Smartwriter MCP] WebSocket server started on ws://localhost:${port}\n`);

  wss.on('connection', (ws) => {
    process.stderr.write('[Smartwriter MCP] Chrome extension connected!\n');
    if (extensionWs) extensionWs.close();
    extensionWs = ws;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'TABS_UPDATE') return;
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch { /* ignore */ }
    });

    ws.on('close', () => {
      process.stderr.write('[Smartwriter MCP] Chrome extension disconnected. Waiting for reconnect...\n');
      if (extensionWs === ws) extensionWs = null;
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Extension disconnected'));
        pendingRequests.delete(id);
      }
    });
  });

  const server = new Server(
    { name: 'smartwriter-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Standard MCP Tool Handling
    if (name === 'cli_list_tools') {
      return textResponse(TOOLS.map(t => ({ name: t.name, description: t.description })));
    }

    if (name === 'cli_server_info') {
      return textResponse({
        pid: process.pid,
        port,
        extensionConnected: extensionWs !== null && extensionWs.readyState === WebSocket.OPEN,
        wsUrl: `ws://localhost:${port}`,
      });
    }

    if (name === 'cli_kill_other_instances') {
      try {
        const scriptPath = getCurrentScriptPath();
        const selfAndAncestors = getAncestorPids(process.pid);
        selfAndAncestors.add(process.pid);
        const pids = listProcesses()
          .filter((entry) => {
            if (selfAndAncestors.has(entry.pid)) return false;
            if (scriptPath) return entry.args.includes(scriptPath);
            return entry.args.includes('smartwriter-mcp/dist/index.js');
          })
          .map((entry) => entry.pid);
        if (pids.length === 0) return textResponse({ killed: 0 });
        pids.forEach(p => { try { process.kill(p, 'SIGTERM'); } catch { /* ignore */ } });
        return textResponse({ killed: pids.length, pids: pids.join(', ') });
      } catch (e) { return errorResponse(e); }
    }

    // Extension Command Mapping
    const command = COMMAND_MAP[name as string];
    if (!command) {
      return errorResponse(`Unknown tool: ${name}`);
    }

    try {
      const result = (await sendToExtension(command, args as Record<string, unknown>)) as any;

      // GENETIC FINGERPRINTING & AUTO DISCOVERY FALLBACK
      if (name === 'get_component_source' && result && result.sourceFile?.includes('NOT_FOUND')) {
        try {
          const fp = result.fingerprints && typeof result.fingerprints === 'object' ? result.fingerprints : null;
          if (fp) {
            const allAttrsRaw = Array.isArray((fp as any).allAttrs) ? (fp as any).allAttrs : [];
            const allAttrs = allAttrsRaw
              .map((entry: any) => ({
                name: typeof entry?.name === 'string' ? entry.name : '',
                value: typeof entry?.value === 'string' ? entry.value : '',
              }))
              .filter((entry: { name: string; value: string }) => entry.name.length > 0);
            const fpId = typeof (fp as any).id === 'string' ? (fp as any).id : '';
            const fpClassName = typeof (fp as any).className === 'string' ? (fp as any).className : '';
            const fpClassList = Array.isArray((fp as any).classList)
              ? (fp as any).classList.filter((item: unknown): item is string => typeof item === 'string' && item.length > 1)
              : [];
            const fpTagName = typeof (fp as any).tagName === 'string' ? (fp as any).tagName.toLowerCase() : '';
            const frameworkHints = Array.isArray((fp as any).frameworkHints)
              ? (fp as any).frameworkHints.filter((item: unknown): item is string => typeof item === 'string')
              : [];
            const normalizedComponentName = typeof result.componentName === 'string' && result.componentName !== 'Anonymous'
              ? result.componentName
              : '';

            // Check Cache
            const cacheKey =
              allAttrs.find((a: { name: string }) => a.name.startsWith('data-v-'))?.name ||
              fpId ||
              fpClassList[0] ||
              fpClassName.split(/\s+/).find(Boolean) ||
              undefined;
            if (cacheKey && FINGERPRINT_CACHE.has(cacheKey)) {
              result.sourceFile = FINGERPRINT_CACHE.get(cacheKey);
              result.analysisHint = `Found via Lightning Cache`;
              return textResponse(result);
            }

            // Discovery Paths
            let searchPaths: string[] = [];
            if (args.project_path) {
              const expanded = String(args.project_path).replace(/^~/, process.env.HOME || '');
              searchPaths.push(path.resolve(expanded));
            } else {
              searchPaths.push(process.cwd());
            }

            // Patterns
            const searchPatternsSet = new Set<string>();
            allAttrs.forEach((a: { name: string; value: string }) => {
              if (a.name.startsWith('data-v-')) {
                searchPatternsSet.add(a.name);
                return;
              }
              if (a.value && a.value.length > 3) {
                searchPatternsSet.add(`${a.name}="${a.value}"`);
                if (a.name === 'class' || a.name === 'id' || a.name.startsWith('data-')) {
                  searchPatternsSet.add(a.value);
                }
              }
            });
            if (fpId) searchPatternsSet.add(fpId);
            fpClassList.forEach((className: string) => searchPatternsSet.add(className));
            if (normalizedComponentName) searchPatternsSet.add(normalizedComponentName);
            const searchPatterns = [...searchPatternsSet].filter((pattern) => pattern.length > 2).slice(0, 25);

            if (searchPatterns.length > 0) {
              let bestMatch: string | null = null;
              let maxScore = 0;
              const scoredFiles = new Map<string, number>();
              const uniquePaths = [...new Set(searchPaths)].filter((dirPath) => {
                try {
                  return existsSync(dirPath) && statSync(dirPath).isDirectory();
                } catch {
                  return false;
                }
              });
              let scannedFileCount = 0;

              for (const scanPath of uniquePaths) {
                for (const pattern of searchPatterns) {
                  const files = fastSearch(pattern, scanPath);
                  for (const file of files) {
                    if (scannedFileCount >= 120) break;
                    scannedFileCount++;
                    let content = '';
                    try {
                      content = readFileSync(file, 'utf8');
                    } catch {
                      continue;
                    }

                    let score = scoredFiles.get(file) || 0;
                    allAttrs.forEach((a: { name: string; value: string }) => {
                      if (a.value && content.includes(`${a.name}="${a.value}"`)) score += 18;
                      else if (a.name.startsWith('data-v-') && content.includes(a.name)) score += 16;
                      else if (a.value && a.value.length > 3 && content.includes(a.value)) score += 4;
                    });
                    if (fpTagName && content.includes(`<${fpTagName}`)) score += 3;
                    if (fpId && content.includes(fpId)) score += 8;
                    fpClassList.forEach((className: string) => {
                      if (content.includes(className)) score += 3;
                    });
                    if (normalizedComponentName && content.includes(normalizedComponentName)) score += 6;
                    const basename = path.basename(file).toLowerCase();
                    if (normalizedComponentName && basename.includes(normalizedComponentName.toLowerCase())) score += 20;
                    if (frameworkHints.includes('vue-scoped-css') && file.endsWith('.vue')) score += 8;
                    if (frameworkHints.includes('react-fiber-detected') && (file.endsWith('.tsx') || file.endsWith('.jsx'))) {
                      score += 8;
                    }

                    scoredFiles.set(file, score);
                    if (score > maxScore) {
                      maxScore = score;
                      bestMatch = file;
                    }
                  }
                  if (scannedFileCount >= 120) break;
                  if (maxScore >= 24) break;
                }
                if (scannedFileCount >= 120) break;
                if (maxScore >= 24) break;
              }

              if (bestMatch) {
                if (cacheKey) FINGERPRINT_CACHE.set(cacheKey, bestMatch);
                result.sourceFile = bestMatch;
                result.analysisHint = `Auto-discovered via fingerprint scan (score=${maxScore}, scannedFiles=${Math.min(scannedFileCount, 120)})`;
              } else {
                result.analysisHint = `Fingerprint scan did not find confident match (scannedFiles=${Math.min(scannedFileCount, 120)})`;
              }
            } else {
              result.analysisHint = 'Insufficient fingerprint data for fallback scan';
            }
          } else {
            result.analysisHint = 'No structured fingerprints returned by extension';
          }
        } catch (e) { /* ignore fallback errors */ }
      }

      return textResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`[Smartwriter MCP] Fatal error: ${error}\n`);
  process.exit(1);
});
