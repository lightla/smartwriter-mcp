#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import net from 'net';
import { execSync } from 'child_process';

const DEFAULT_PORT = 9223;

// Global cache for component discovery to boost performance
const FINGERPRINT_CACHE = new Map<string, string>();

/**
 * Fast file search using ripgrep or grep
 */
function fastSearch(term: string, searchPath: string): string[] {
  try {
    // Priority 1: ripgrep (rg) - extremely fast
    try {
      const rgCmd = `rg -l "${term}" "${searchPath}" -g "*.{vue,tsx,jsx}" --max-depth 10 --no-ignore | head -n 3`;
      const files = execSync(rgCmd).toString().trim().split('\n').filter(f => f);
      if (files.length > 0) return files;
    } catch (e) { /* rg not found, fallback to grep */ }

    // Priority 2: optimized grep
    const grepCmd = `grep -r "${term}" "${searchPath}" --include="*.vue" --include="*.tsx" --include="*.jsx" --exclude-dir=node_modules -l | head -n 3`;
    return execSync(grepCmd).toString().trim().split('\n').filter(f => f);
  } catch (e) {
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
  global_get_tabs: 'GET_TABS',
  global_get_flow_tab_ids: 'GET_FLOW_TAB_IDS',
  tab_connect: 'CONNECT_TAB',
  tab_disconnect: 'DISCONNECT_TAB',
  tab_focus_connected: 'JUMP_CONNECTED_TAB',
  get_detailed_annotations: 'GET_DETAILED_ANNOTATIONS',
  global_get_detailed_annotations: 'GET_GLOBAL_DETAILED_ANNOTATIONS',
  get_compact_annotations: 'GET_COMPACT_ANNOTATIONS',
  global_get_compact_annotations: 'GET_GLOBAL_COMPACT_ANNOTATIONS',
  clear_all_anotations: 'CLEAR_ALL_ANOTATIONS',
  global_clear_all_anotations: 'CLEAR_GLOBAL_ALL_ANOTATIONS',
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
    name: 'global_get_tabs',
    description: 'Get list of all open browser tabs',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'global_get_flow_tab_ids',
    description: 'Get list of all tab IDs currently linked in the flow (e.g., t:1, t:2)',
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
    name: 'global_get_detailed_annotations',
    description: 'Get detailed annotations across all URLs, including tabId, sorted by tabId.',
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
    name: 'global_get_compact_annotations',
    description: 'Get compact tracked annotations across all URLs. Returns id|pageId|tabId|type|note plus pageId|url mapping, sorted by tabId.',
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
    name: 'global_clear_all_anotations',
    description: 'Clear all tracked annotations across all URLs.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function escapePsvCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');
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
    entries.forEach(([childKey, childValue]) => {
      const nextKey = key === 'value' ? childKey : `${key}.${childKey}`;
      flattenPsvRows(childValue, nextKey, rows);
    });
    return rows;
  }

  rows.push([key, toScalar(value)]);
  return rows;
}

function toPsv(value: unknown): string {
  const rows = flattenPsvRows(value);
  return ['key|value', ...rows.map(([k, v]) => `${escapePsvCell(k)}|${escapePsvCell(v)}`)].join('\n');
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
        const output = execSync(`ps aux | grep 'smartwriter-mcp' | grep -v grep | awk '{print $2}'`).toString().trim();
        const pids = output.split('\n').map(Number).filter(p => p && p !== process.pid);
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
          const fp = result.fingerprints;
          if (fp) {
            // Check Cache
            const cacheKey = fp.allAttrs?.find((a: any) => a.name.startsWith('data-v-'))?.name || fp.attributes?.id;
            if (cacheKey && FINGERPRINT_CACHE.has(cacheKey)) {
              result.sourceFile = FINGERPRINT_CACHE.get(cacheKey);
              result.analysisHint = `Found via Lightning Cache`;
              return textResponse(result);
            }

            // Discovery Paths
            let searchPaths: string[] = [];
            if (args.project_path) {
              searchPaths.push(String(args.project_path).replace(/^~/, process.env.HOME || ''));
            } else {
              searchPaths.push(process.cwd());
              ['~/workspace', '~/projects', '~/dev'].forEach(p => searchPaths.push(p.replace(/^~/, process.env.HOME || '')));
            }

            // Patterns
            const searchPatterns: string[] = [];
            if (fp.allAttrs) {
              fp.allAttrs.forEach((a: any) => {
                if (a.name.startsWith('data-v-')) searchPatterns.push(a.name);
                else if (a.value && a.value.length > 3) searchPatterns.push(`${a.name}="${a.value}"`);
              });
            }

            if (searchPatterns.length > 0) {
              let bestMatch = null;
              let maxScore = 0;
              const uniquePaths = [...new Set(searchPaths)].filter(p => {
                try { return execSync(`test -d "${p}" && echo 1`).toString().trim() === '1'; } catch { return false; }
              });

              for (const path of uniquePaths) {
                for (const pattern of searchPatterns) {
                  const files = fastSearch(pattern, path);
                  for (const file of files) {
                    const content = execSync(`cat "${file}"`).toString();
                    let score = 0;
                    if (fp.allAttrs) {
                      fp.allAttrs.forEach((a: any) => {
                        if (content.includes(`${a.name}="${a.value}"`)) score += 10;
                        else if (a.name.startsWith('data-v-') && content.includes(a.name)) score += 15;
                      });
                    }
                    if (score > maxScore) {
                      maxScore = score;
                      bestMatch = file;
                    }
                  }
                  if (maxScore >= 15) break;
                }
                if (maxScore >= 15) break;
              }

              if (bestMatch) {
                if (cacheKey) FINGERPRINT_CACHE.set(cacheKey, bestMatch);
                result.sourceFile = bestMatch;
                result.analysisHint = `Auto-discovered via Optimized Scanning (Score: ${maxScore})`;
              }
            }
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
