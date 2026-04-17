#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import net from 'net';
import { execSync } from 'child_process';

const DEFAULT_PORT = 9223;

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

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { autoFreePort: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--auto-port') {
      options.autoFreePort = true;
      continue;
    }

    if (arg === '--port') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('[Smartwriter MCP] Missing value for --port');
      }
      options.port = parsePort(value, 'CLI');
      i += 1;
      continue;
    }

    if (arg.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length), 'CLI');
      continue;
    }

    throw new Error(`[Smartwriter MCP] Unknown argument: ${arg}`);
  }

  return options;
}

async function isPortInUse(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(p);
  });
}

async function findFreePort(startPort: number, attempts = 200): Promise<number | null> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = startPort + offset;
    if (!(await isPortInUse(candidate))) {
      return candidate;
    }
  }
  return null;
}

let currentPort = DEFAULT_PORT;
let extensionWs: WebSocket | null = null;
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
>();

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sendToExtension(command: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
      return reject(
        new Error(
          'No Chrome extension connected. Open Chrome, click the Smartwriter MCP extension icon, and connect a tab.'
        )
      );
    }
    const requestId = generateId();
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Command timeout: ${command}`));
    }, 30000);
    pendingRequests.set(requestId, { resolve, reject, timeout });
    extensionWs.send(JSON.stringify({ type: 'COMMAND', requestId, command, args }));
  });
}

function psvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Error) return value.message.replace(/\r?\n/g, '\\n');
  if (typeof value === 'string') return value.replace(/\r?\n/g, '\\n');
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((item) => psvCell(item)).join(';');
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return String(value).replace(/\r?\n/g, '\\n');
    return entries
      .map(([key, nested]) => `${key}=${psvCell(nested)}`)
      .join(';');
  }
  return String(value);
}

function flattenPsvObject(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  const row: Record<string, string> = {};

  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      nested &&
      typeof nested === 'object' &&
      !Array.isArray(nested) &&
      !(nested instanceof Date)
    ) {
      Object.assign(row, flattenPsvObject(nested as Record<string, unknown>, path));
    } else {
      row[path] = psvCell(nested);
    }
  }

  return row;
}

function formatPsv(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return psvCell(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      const rows = value.map((item) => flattenPsvObject(item as Record<string, unknown>));
      const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      return [headers.join('|'), ...rows.map((row) => headers.map((header) => row[header] ?? '').join('|'))].join('\n');
    }
    return ['value', ...value.map((item) => psvCell(item))].join('\n');
  }

  const flattened = flattenPsvObject(value as Record<string, unknown>);
  return ['key|value', ...Object.entries(flattened).map(([key, cell]) => `${key}|${cell}`)].join('\n');
}

function textResponse(value: unknown) {
  return { content: [{ type: 'text' as const, text: formatPsv(value) }] };
}

function errorResponse(message: unknown) {
  return {
    content: [{ type: 'text' as const, text: `error|message\ntrue|${psvCell(message)}` }],
    isError: true,
  };
}

const TOOLS = [
  {
    name: 'list_tools',
    description: 'List all Smartwriter MCP tools and their descriptions',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'navigate',
    description: 'Navigate the connected browser tab to a URL',
    inputSchema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
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
    name: 'click',
    description: 'Click an element in the connected tab',
    inputSchema: {
      type: 'object' as const,
      properties: { selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' } },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an input element char by char',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of option values to select; first value will be used',
        },
      },
      required: ['selector', 'options'],
    },
  },
  {
    name: 'check',
    description: 'Check a checkbox or radio input',
    inputSchema: {
      type: 'object' as const,
      properties: { selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' } },
      required: ['selector'],
    },
  },
  {
    name: 'uncheck',
    description: 'Uncheck a checkbox input',
    inputSchema: {
      type: 'object' as const,
      properties: { selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' } },
      required: ['selector'],
    },
  },
  {
    name: 'snapshot',
    description: 'Get accessibility snapshot of the current page',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector or annotation marker like a:1 from get_summary_anotations to scope snapshot' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'evaluate',
    description:
      'Execute JavaScript in the connected tab and return result. ' +
      'Optionally pass marker like a:1 from get_summary_anotations or index to expose the resolved DOM node as `element` inside the script.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute' },
        args: {
          type: 'array',
          items: {},
          description: 'Optional positional arguments available as arg0, arg1, ... inside the script',
        },
        marker: {
          type: 'string',
          description: 'Optional annotation marker from get_summary_anotations, e.g. a:1',
        },
        index: {
          type: 'number',
          description: 'Optional annotation index from get_summary_anotations; resolved element is available as `element` inside the script',
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element',
    inputSchema: {
      type: 'object' as const,
      properties: { selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' } },
      required: ['selector'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key on the focused element',
    inputSchema: {
      type: 'object' as const,
      properties: { key: { type: 'string', description: 'Key to press e.g. Enter, Escape, Tab' } },
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
      properties: { selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' } },
      required: ['selector'],
    },
  },
  {
    name: 'get_attribute',
    description: 'Get an attribute value from an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a:1 from get_summary_anotations' },
        attribute: { type: 'string' },
      },
      required: ['selector', 'attribute'],
    },
  },
  {
    name: 'get_tabs',
    description: 'Get list of all open browser tabs',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'connect_tab',
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
    name: 'jump_connected_tab',
    description: 'Focus and bring the currently connected tab to the front',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'server_info',
    description: 'Show current smartwriter-mcp server info: port, PID, and Chrome extension connection status',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'kill_other_instances',
    description: 'Kill all other smartwriter-mcp instances running on this machine, keeping only the current one',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_annotations',
    description:
      'Get all tracked element annotations saved via the in-page tracking UI. ' +
      'Each annotation includes: selectors.primary (use this with click/hover to target the element), ' +
      'selectors.cssPath & selectors.xpath (fallbacks), element info (tag, text, classList, rect), ' +
      'framework info (React/Vue component name and chain — useful for tracing back to a Next.js or Nuxt.js component), ' +
      'type (step = reproduction step, change = requested UI change, bug = bug location), note, and timestamp.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Filter by page URL (optional). Defaults to the connected tab URL when omitted.' },
        all: { type: 'boolean', description: 'Return annotations from all URLs instead of defaulting to the connected tab URL' },
        type: {
          type: 'string',
          enum: ['step', 'change', 'bug'],
          description: 'Filter by annotation type (optional)',
        },
      },
    },
  },
  {
    name: 'get_summary_anotations',
    description:
      'Get compact tracked element annotations for the agent to read. ' +
      'Returns plain text lines in the format id|type|note. Type is preserved as saved; selector details are intentionally hidden. ' +
      'The note field may contain | characters; split only the first two separators.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Filter by page URL (optional). Defaults to the connected tab URL when omitted.' },
        all: { type: 'boolean', description: 'Return annotations from all URLs instead of defaulting to the connected tab URL' },
        type: {
          type: 'string',
          enum: ['step', 'change', 'bug'],
          description: 'Filter by annotation type (optional)',
        },
      },
    },
  },
  {
    name: 'clear_annotations',
    description:
      'Clear tracked element annotations. Defaults to the connected tab URL, or pass url for a specific page, or all=true for all pages. Returns PSV cleared|scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Clear only annotations for this URL (optional). Defaults to the connected tab URL when omitted.' },
        all: { type: 'boolean', description: 'Clear annotations from all URLs instead of defaulting to the connected tab URL' },
      },
    },
  },
  {
    name: 'delete_annotation',
    description: 'Delete a single annotation permanently by annotation marker id like a:1, by index, or by legacy ID. Returns plain text deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        index: { type: 'number', description: 'Annotation index from get_summary_anotations' },
        id: { type: 'string', description: 'Annotation marker from get_summary_anotations, e.g. a:1, or a legacy annotation ID' },
      },
    },
  },
];

const COMMAND_MAP: Record<string, string> = {
  navigate: 'NAVIGATE',
  go_back: 'GO_BACK',
  go_forward: 'GO_FORWARD',
  reload: 'RELOAD',
  click: 'CLICK',
  type: 'TYPE',
  fill: 'FILL',
  select_option: 'SELECT',
  check: 'CHECK',
  uncheck: 'UNCHECK',
  snapshot: 'GET_SNAPSHOT',
  screenshot: 'SCREENSHOT',
  evaluate: 'EVALUATE',
  hover: 'HOVER',
  press_key: 'PRESS_KEY',
  wait_for: 'WAIT_FOR',
  get_text: 'GET_TEXT',
  get_attribute: 'GET_ATTRIBUTE',
  get_tabs: 'GET_TABS',
  get_flow_tab_ids: 'GET_FLOW_TAB_IDS',
  connect_tab: 'CONNECT_TAB',
  jump_connected_tab: 'JUMP_CONNECTED_TAB',
  get_annotations: 'GET_ANNOTATIONS',
  get_summary_anotations: 'GET_SUMMARY_ANOTATIONS',
  clear_annotations: 'CLEAR_ANNOTATIONS',
  delete_annotation: 'DELETE_ANNOTATION',
};

async function main() {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const requestedPort =
    cliOptions.port ??
    (process.env.SMARTWRITER_PORT ? parsePort(process.env.SMARTWRITER_PORT, 'environment') : DEFAULT_PORT);

  let port = requestedPort;
  currentPort = port;

  if (await isPortInUse(port)) {
    if (cliOptions.autoFreePort) {
      const freePort = await findFreePort(port + 1);
      if (!freePort) {
        process.stderr.write(
          `[Smartwriter MCP] ERROR: Could not find a free port above ${port}.\n` +
            `[Smartwriter MCP] Try running with an explicit port, e.g. smartwriter-mcp --port=9224\n`
        );
        process.exit(1);
      }

      process.stderr.write(
        `[Smartwriter MCP] Port ${port} is in use. Falling back to free port ${freePort} because --auto-port was provided.\n`
      );
      port = freePort;
      currentPort = port;
    } else {
      process.stderr.write(
        `[Smartwriter MCP] ERROR: Port ${port} is already in use by another process.\n` +
          `[Smartwriter MCP] Start with a specific port:\n` +
          `[Smartwriter MCP]   smartwriter-mcp --port=9224\n` +
          `[Smartwriter MCP] Or let Smartwriter MCP pick the next free port automatically:\n` +
          `[Smartwriter MCP]   smartwriter-mcp --auto-port\n` +
          `[Smartwriter MCP] Then update the port in the extension popup settings (gear icon).\n`
      );
      process.exit(1);
    }
  }

  const wss = new WebSocketServer({ port });
  process.stderr.write(`[Smartwriter MCP] WebSocket server started on ws://localhost:${port}\n`);
  if (port !== requestedPort) {
    process.stderr.write(
      `[Smartwriter MCP] Requested port was ${requestedPort}; update the extension popup to ${port} if needed.\n`
    );
  }
  process.stderr.write(`[Smartwriter MCP] Waiting for Chrome extension to connect...\n`);

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
      } catch {
        // ignore parse errors
      }
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

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === 'list_tools') {
      const toolList = TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
      return textResponse(toolList);
    }

    if (name === 'server_info') {
      const info = {
        pid: process.pid,
        port: currentPort,
        extensionConnected: extensionWs !== null && extensionWs.readyState === WebSocket.OPEN,
        wsUrl: `ws://localhost:${currentPort}`,
      };
      return textResponse(info);
    }

    if (name === 'kill_other_instances') {
      try {
        const output = execSync(
          `ps aux | grep 'smartwriter-mcp' | grep -v grep | awk '{print $2}'`
        ).toString().trim();
        const pids = output.split('\n').map(Number).filter((p) => p && p !== process.pid);
        if (pids.length === 0) {
          return textResponse({ killed: 0, pids: '' });
        }
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // ignore if already dead
          }
        }
        return textResponse({ killed: pids.length, pids: pids.join(';') });
      } catch (error) {
        return errorResponse(error);
      }
    }

    const command = COMMAND_MAP[name];
    if (!command) {
      return errorResponse(`Unknown tool: ${name}`);
    }
    try {
      const result = await sendToExtension(command, args as Record<string, unknown>);
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
