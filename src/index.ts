#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import net from 'net';
import { execSync, execFileSync, spawn, ChildProcess } from 'child_process';
import { realpathSync, existsSync, statSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { runWorkflow, formatReport, deleteWorkflowResult, deleteWorkflowGroup, deleteWorkflowSession } from './workflow.js';
import yaml from 'js-yaml';

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
  reportOnly: boolean;
};

function parsePort(value: string, source: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[Smartwriter MCP] Invalid ${source} port: ${value}`);
  }
  return port;
}

function getCliOptions(): CliOptions {
  const options: CliOptions = { autoFreePort: false, reportOnly: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      options.port = parsePort(args[++i], 'CLI');
    } else if (args[i] === '--auto-free-port' || args[i] === '--auto-port') {
      options.autoFreePort = true;
    } else if (args[i] === '--report-only') {
      options.reportOnly = true;
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
  get_compact_dom_snapshot: 'GET_SNAPSHOT',
  get_aria_snapshot: 'GET_ARIA_SNAPSHOT',
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
  tab_get_connected_info: 'GET_CONNECTED_TAB_INFO',
  find_element_by_text: 'FIND_ELEMENT_BY_TEXT',
  smart_search: 'SMART_SEARCH',
  smart_focus: 'SMART_FOCUS',
  smart_click: 'SMART_CLICK',
  smart_type: 'SMART_TYPE',
  smart_fill: 'SMART_FILL',
  smart_hover: 'SMART_HOVER',
  smart_select_option: 'SMART_SELECT_OPTION',
  smart_check: 'SMART_CHECK',
  smart_uncheck: 'SMART_UNCHECK',
  press_enter: 'PRESS_ENTER',
  run_workflow: 'RUN_WORKFLOW',
  start_observe: 'START_OBSERVE',
  stop_observe: 'STOP_OBSERVE',
  flush_observe: 'FLUSH_OBSERVE',
  screenshot_step: 'SCREENSHOT_STEP',
  start_recording: 'START_RECORDING',
  stop_recording: 'STOP_RECORDING',
  get_workflow_settings: 'GET_WORKFLOW_SETTINGS',
  assert_url: 'ASSERT',
  assert_visible: 'ASSERT',
  assert_not_visible: 'ASSERT',
  assert_element: 'ASSERT',
  assert_not_element: 'ASSERT',
  highlight_target: 'HIGHLIGHT_TARGET',
  remove_highlight: 'REMOVE_HIGHLIGHT',
  };

  const TOOLS = [
  {
    name: 'cli_list_tools',
    description: 'List all Smartwriter MCP tools and their descriptions',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'smart_focus',
    description: 'Intelligently find the best target (link, button, etc.) by text or selector and return its reference marker (eIndex) for use with click/hover tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the element to focus' },
      },
      required: ['target'],
    },
  },
  {
    name: 'smart_click',
    description: 'Find an element by text or selector and click it. Combines smart_focus + click in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the element to click' },
      },
      required: ['target'],
    },
  },
  {
    name: 'smart_type',
    description: 'Find an element by text or selector, focus it, and type text into it char by char. Combines smart_focus + click + type in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the input element' },
        text: { type: 'string', description: 'The text to type char by char' },
      },
      required: ['target', 'text'],
    },
  },
  {
    name: 'smart_fill',
    description: 'Find an element by text or selector and fill it with a value instantly. Combines smart_focus + fill in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the input element' },
        value: { type: 'string', description: 'The value to fill in' },
      },
      required: ['target', 'value'],
    },
  },
  {
    name: 'smart_hover',
    description: 'Find an element by text or selector and hover over it. Combines smart_focus + hover in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the element to hover over' },
      },
      required: ['target'],
    },
  },
  {
    name: 'smart_select_option',
    description: 'Find a select element by text or selector and select an option. Combines smart_focus + select_option in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the select element' },
        options: { type: 'array', items: { type: 'string' }, description: 'List of option values to select; first value will be used' },
      },
      required: ['target', 'options'],
    },
  },
  {
    name: 'smart_check',
    description: 'Find a checkbox or radio input by text or selector and check it. Combines smart_focus + check in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the checkbox or radio element' },
      },
      required: ['target'],
    },
  },
  {
    name: 'smart_uncheck',
    description: 'Find a checkbox input by text or selector and uncheck it. Combines smart_focus + uncheck in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'The text or selector of the checkbox element' },
      },
      required: ['target'],
    },
  },
  {
    name: 'press_enter',
    description: 'Press the Enter key physically on the currently focused element.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'find_element_by_text',

    description: 'Find an element by its text content or title/alt attributes and return its reference and details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The text to search for (case-insensitive)' },
        exact: { type: 'boolean', description: 'Whether to match the text exactly' },
      },
      required: ['text'],
    },
  },
  {
    name: 'smart_search',
    description: 'Automatically find the search bar on the page, type the query, and submit it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search term to enter' },
      },
      required: ['query'],
    },
  },
  {
    name: 'click',
    description: 'Click an element in the connected tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
    description: 'Execute JavaScript in the connected tab and return result. Optionally pass marker like a1 or index to expose the resolved DOM node as `element` inside the script.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional positional arguments available as arg0, arg1, ... inside the script' },
        marker: { type: 'string', description: 'Optional annotation marker from get_compact_annotations, e.g. a1)' },
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
    description: 'Get compact DOM snapshot of the current page (token-efficient PSV)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector or annotation marker like a1 to scope snapshot' },
      },
    },
  },
  {
    name: 'get_compact_dom_snapshot',
    description: 'Get compact DOM snapshot of the current page (token-efficient PSV)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector or annotation marker like a1 to scope snapshot' },
      },
    },
  },
  {
    name: 'get_aria_snapshot',
    description: 'Get ARIA accessibility tree snapshot of the current page (ultra token-efficient, semantic roles)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector or annotation marker to scope snapshot' },
        depth: { type: 'number', description: 'Maximum tree depth (default 10)' },
      },
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like a1' },
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
        selector: { type: 'string', description: 'CSS selector, or annotation marker like e1 from get_summary_annotations' },
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
        selector: { type: 'string', description: 'Target selector (CSS/XPath/coords/marker like a1' },
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
        selector: { type: 'string', description: 'Target selector (CSS/XPath/coords/marker like a1' },
        project_path: { type: 'string', description: 'Optional: Path to the source code directory if it is different from the current workspace.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'flow_get_tab_ids',
    description: 'Get flow tab IDs sorted as t1..tn.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tab_get_all_compact_info',
    description: 'Get compact flow tab info in PSV: tabId|tabTitle.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tab_get_connected_info',
    description: 'Get connected tab info in PSV: tabId|title|url|active.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tab_connect',
    description: 'Connect to a tab (by t1 or internal ID) to start sending commands to it',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'string', description: 'Flow ID like t1 or a numeric Tab ID' },
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
    description: 'Get compact tracked annotations for the connected tab. Returns id|pageId|type|trigger|note plus pageId|url mapping.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['step', 'change', 'bug'], description: 'Filter by annotation type (optional)' },
      },
    },
  },
  {
    name: 'flow_get_compact_annotations',
    description: 'Get compact tracked annotations across flow tabs. Returns id|pageId|tabId|type|trigger|note plus pageId|url mapping, sorted by annotation id. tabId is a TabFlow marker like t1 (not the raw Chrome tabId).',
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
  {
    name: 'assert_url',
    description: 'Assert that the current page URL matches conditions. Use in workflow tests to verify navigation succeeded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        equals: { type: 'string', description: 'URL must equal this value exactly' },
        contains: { type: 'string', description: 'URL must contain this substring' },
        starts_with: { type: 'string', description: 'URL must start with this prefix' },
        matches: { type: 'string', description: 'URL must match this regex pattern' },
      },
    },
  },
  {
    name: 'assert_visible',
    description: 'Assert that specific text is visible on the current page. Use in workflow tests to verify validation messages, headings, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text that should be visible on the page (case-insensitive)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'assert_not_visible',
    description: 'Assert that specific text is NOT visible on the current page. Use to verify error messages are absent, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text that should NOT be visible on the page (case-insensitive)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'assert_element',
    description: 'Assert that a DOM element matching the CSS selector exists on the page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector that should match an element' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'assert_not_element',
    description: 'Assert that no DOM element matching the CSS selector exists on the page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector that should NOT match any element' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'run_workflow',
    description: 'Execute a workflow from a YAML file path or inline YAML. Runs all steps sequentially (navigate, smart_click, smart_type, etc.), captures errors, and returns a compact report. Results are saved as HTML report file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to YAML workflow file' },
        yaml: { type: 'string', description: 'Inline YAML workflow definition' },
        sessionId: { type: 'string', description: 'Optional session ID to group multiple workflow runs together' },
      },
    },
  },
  {
    name: 'delete_workflow_result',
    description: 'Delete a workflow result by its ID. Removes the result directory and its files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The result ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_workflow_group',
    description: 'Delete all workflow results in a group. Group is specified as path like "Signup/Fail".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group: { type: 'string', description: 'Group path to delete (e.g. "Signup/Fail")' },
      },
      required: ['group'],
    },
  },
  {
    name: 'delete_workflow_session',
    description: 'Delete all workflow results in a session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID to delete' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'start_observe',
    description: 'Start capturing browser console errors, JS exceptions, and network errors (HTTP 4xx/5xx). Call before running a workflow to capture issues.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'stop_observe',
    description: 'Stop capturing and return all observed console errors, JS exceptions, and network errors since start_observe was called.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'flush_observe',
    description: 'Return observed events since last flush without stopping observation. Use between workflow steps to capture per-step observations.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'screenshot_step',
    description: 'Take a screenshot of the current page state. Returns base64 PNG data.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'start_recording',
    description: 'Start screen recording using CDP screencast. Captures frames for later playback.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'stop_recording',
    description: 'Stop screen recording and return captured frames.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_workflow_settings',
    description: 'Get workflow settings from the extension (screenshot per step, recording enabled).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'start_report_server',
    description: 'Get the workflow dashboard URL. The MCP server always serves the dashboard on its own port — this returns it immediately. If a separate report server was spawned, returns that port instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'stop_report_server',
    description: 'Stop the separate report server process if one was spawned. The dashboard remains available on the MCP server port.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

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

const TEXT_KEYS = new Set([
  'note', 'text'
]);

function toScalar(value: unknown, key?: string): string {
  if (value === null || value === undefined) {
    if (key === 'trigger') return 'No';
    return '';
  }

  if (typeof value === 'string') {
    // Special handling for trigger markers
    if (key === 'trigger') {
      const trimmed = value.trim();
      if (!trimmed) return 'No';
      // Return marker as-is (no quotes), e.g., a1
      return trimmed.replace(/^([a-z]+):?(\d+)$/i, '$1$2');
    }

    // Standardize other markers: a:1 -> a1, p:1 -> p1, etc.
    if (key === 'id' || key === 'pageId' || key === 'tabId' || key === 'marker') {
      return value.replace(/^([a-z]+):?(\d+)$/i, '$1$2');
    }

    // Quote if key is note/text OR if it contains spaces/newlines/tabs
    if ((key && TEXT_KEYS.has(key)) || /[\s\n\t]/.test(value)) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return Object.prototype.toString.call(value);
}

/** Convert any value to ultra-compact plain text — ARIA-tree style (no colons). */
function toCompactText(value: unknown, indent = 0): string {
  if (value === null || value === undefined) return '';

  // Strings: pass through (already formatted by sender, e.g. getAriaSnapshot)
  if (typeof value === 'string') return value;

  // Scalars
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);

  const prefix = '  '.repeat(indent);

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return '';

    // Array of scalars => comma list on one line
    if (value.every(isScalarLike)) {
      return value.map((v) => toScalar(v)).join(', ');
    }

    // Array of flat objects with consistent keys => TABLE
    // e.g. [{id:a1,pageId:p1,...}, {id:a2,pageId:p2,...}]
    if (value.length > 0 && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      const firstKeys = Object.keys(value[0] as Record<string, unknown>);
      if (
        firstKeys.length > 0 &&
        value.every((item) => {
          const keys = Object.keys(item as Record<string, unknown>);
          return keys.length === firstKeys.length && keys.every((k, i) => k === firstKeys[i]);
        }) &&
        value.every((item) => Object.values(item as Record<string, unknown>).every((v) => isScalarLike(v)))
      ) {
        // Show header if > 2 columns OR if 2 columns are NOT (name, description)
        const isStandardList = firstKeys.length === 2 && firstKeys[0] === 'name' && firstKeys[1] === 'description';
        const showHeader = firstKeys.length > 2 || !isStandardList;

        const rows = (value as Array<Record<string, unknown>>).map((item) =>
          firstKeys.map((k) => toScalar(item[k], k)).join(' ')
        );
        
        const lines = showHeader ? [firstKeys.join(' '), ...rows] : rows;
        return lines.map((line) => `${prefix}${line}`).join('\n');
      }
    }

    // Fallback: list with dashed bullet
    return value
      .map((item) => {
        if (isScalarLike(item)) return `${prefix}- ${toScalar(item)}`;
        return `${prefix}-\n${toCompactText(item, indent + 1)}`;
      })
      .join('\n');
  }

  // Objects
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return '';

    // If all entries are scalars, put them on a single line if short, else one per line
    if (entries.every(([, v]) => isScalarLike(v))) {
      const line = entries.map(([k, v]) => `${k} ${toScalar(v, k)}`).join(' ');
      if (line.length < 80) return `${prefix}${line}`;
      return entries.map(([k, v]) => `${prefix}${k} ${toScalar(v, k)}`).join('\n');
    }

    // Nested object
    return entries
      .map(([k, v]) => {
        if (isScalarLike(v)) return `${prefix}${k} ${toScalar(v, k)}`;
        const content = toCompactText(v, indent + 1);
        if (content.trim().length === 0) return '';
        return `${prefix}${k}\n${content}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(value);
}

function textResponse(data: unknown, toolName?: string) {
  if (typeof data === 'string') return { content: [{ type: 'text', text: data }] };

  // ACTION REVOLUTION: Return simple "OK" for interaction tools to save tokens
  const actionTools = [
    'type', 'press_key', 'press_enter', 'fill', 'check', 'uncheck', 
    'hover', 'select_option', 'tab_connect', 'tab_disconnect', 'navigate', 
    'reload', 'go_back', 'go_forward', 'tab_focus_connected', 
    'clear_all_anotations', 'flow_clear_all_anotations'
    // smart_focus and click EXCLUDED
  ];
  
  if (toolName && actionTools.includes(toolName)) {
    // Treat any non-error response as success for action tools
    const isError = (data as any)?.error || (data as any)?.isError || (data as any)?.success === false;
    if (!isError) return { content: [{ type: 'text', text: 'OK' }] };
  }

  // Handle ultra-compact text conversion with minimal noise
  return { content: [{ type: 'text', text: toCompactText(data) }] };
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

  // Report-only mode: lightweight HTTP server for dashboard (no MCP, no WebSocket)
  if (options.reportOnly) {
    const WORKFLOWS_DIR = path.join(os.homedir(), '.smartwriter', 'workflows');
    const MIME_TYPES: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.webm': 'video/webm',
      '.mp4': 'video/mp4',
    };

    const httpServer = http.createServer((req, res) => {
      const urlPath = req.url?.split('?')[0] || '/';
      let filePath: string;
      if (urlPath === '/' || urlPath === '/index.html') {
        filePath = path.join(WORKFLOWS_DIR, 'index.html');
      } else {
        filePath = path.join(WORKFLOWS_DIR, urlPath);
      }
      if (!filePath.startsWith(WORKFLOWS_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      if (statSync(filePath).isDirectory()) {
        const files = execSync(`ls -1 "${filePath}"`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
        const html = files.map(f => `<a href="${path.basename(f)}">${f}</a>`).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      try {
        const data = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    let port = requestedPort;
    if (options.autoFreePort) {
      while (port <= 65535 && !(await isPortAvailable(port))) port++;
      if (port > 65535) {
        process.stderr.write('[Smartwriter Report] No available port\n');
        process.exit(1);
      }
    }

    async function isPortAvailable(p: number): Promise<boolean> {
      return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => { s.close(); resolve(true); });
        s.listen(p, '127.0.0.1');
      });
    }

    httpServer.listen(port, '127.0.0.1', () => {
      // Output port so parent process can read it
      process.stdout.write(`REPORT_PORT:${port}\n`);
      process.stderr.write(`[Smartwriter Report] Dashboard serving on http://localhost:${port}/\n`);
    });
    return; // No MCP server, no WebSocket — just HTTP
  }

  let extensionWs: WebSocket | null = null;
  const pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: any) => void; timeout: NodeJS.Timeout }
  >();

  // Report server child process management
  let reportServerProcess: ChildProcess | null = null;
  let reportServerPort: number | null = null;

  function killReportServer() {
    if (reportServerProcess) {
      try { reportServerProcess.kill('SIGTERM'); } catch { /* already dead */ }
      reportServerProcess = null;
      reportServerPort = null;
    }
  }

  // Kill report server on exit
  process.on('SIGINT', () => { killReportServer(); process.exit(0); });
  process.on('SIGTERM', () => { killReportServer(); process.exit(0); });
  process.on('exit', () => { killReportServer(); });

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

  // HTTP server for dashboard + WebSocket upgrade
  const WORKFLOWS_DIR = path.join(os.homedir(), '.smartwriter', 'workflows');
  const TEST_APP_DIR = path.join(path.dirname(realpathSync(new URL(import.meta.url).pathname)), '..', 'test', 'sample-app');
  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
  };

  const httpServer = http.createServer(async (req, res) => {
    const urlPath = req.url?.split('?')[0] || '/';

    // API endpoints for delete operations
    if (req.method === 'DELETE' && urlPath.startsWith('/api/')) {
      const importWorkflow = async () => {
        const { deleteWorkflowResult, deleteWorkflowGroup, deleteWorkflowSession } = await import('./workflow.js');
        return { deleteWorkflowResult, deleteWorkflowGroup, deleteWorkflowSession };
      };

      if (urlPath.startsWith('/api/result/')) {
        const id = decodeURIComponent(urlPath.slice('/api/result/'.length));
        importWorkflow().then(({ deleteWorkflowResult }) => {
          const deleted = deleteWorkflowResult(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ deleted, id }));
        }).catch(() => { res.writeHead(500); res.end('Error'); });
        return;
      }
      if (urlPath.startsWith('/api/group/')) {
        const group = decodeURIComponent(urlPath.slice('/api/group/'.length));
        const groupPath = group.split('/').map(s => s.trim()).filter(Boolean);
        importWorkflow().then(({ deleteWorkflowGroup }) => {
          const count = deleteWorkflowGroup(groupPath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ deleted: count, group }));
        }).catch(() => { res.writeHead(500); res.end('Error'); });
        return;
      }
      if (urlPath.startsWith('/api/session/')) {
        const sessionId = decodeURIComponent(urlPath.slice('/api/session/'.length));
        importWorkflow().then(({ deleteWorkflowSession }) => {
          const count = deleteWorkflowSession(sessionId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ deleted: count, sessionId }));
        }).catch(() => { res.writeHead(500); res.end('Error'); });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Rebuild dashboard on demand
    if (req.method === 'POST' && urlPath === '/api/rebuild') {
      try {
        const scriptPath = path.join(path.dirname(realpathSync(new URL(import.meta.url).pathname)), '..', 'scripts', 'rebuild-dashboard.mjs');
        execSync('node "' + scriptPath + '"', { encoding: 'utf-8', timeout: 10000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // API: List workflow YAML files
    if (req.method === 'GET' && urlPath === '/api/workflows') {
      try {
        // Scan both ~/.smartwriter/workflows/ and project workflows/ dir
        const dirs = [WORKFLOWS_DIR, path.join(path.dirname(realpathSync(new URL(import.meta.url).pathname)), '..', 'workflows')];
        const allFiles = new Map<string, { name: string; filePath: string; displayName: string; description: string; group: string }>();
        for (const wfDir of dirs) {
          if (!existsSync(wfDir)) continue;
          const files = readdirSync(wfDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
          for (const f of files) {
            if (allFiles.has(f)) continue; // prefer first found
            try {
              const content = readFileSync(path.join(wfDir, f), 'utf-8');
              const parsed = yaml.load(content) as any;
              allFiles.set(f, { name: f, filePath: path.join(wfDir, f), displayName: parsed?.name || f.replace(/\.(yaml|yml)$/, ''), description: parsed?.description || '', group: parsed?.group || '' });
            } catch { allFiles.set(f, { name: f, filePath: path.join(wfDir, f), displayName: f, description: '', group: '' }); }
          }
        }
        const workflows = [...allFiles.values()].sort((a, b) => a.name.localeCompare(b.name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(workflows));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // API: Read a workflow YAML file
    if (req.method === 'GET' && urlPath.startsWith('/api/workflow-file')) {
      const name = new URL(urlPath, 'http://localhost').searchParams.get('name');
      if (!name) { res.writeHead(400); res.end('Missing name parameter'); return; }
      // Search in project workflows/ dir first, then ~/.smartwriter/workflows/
      const projectWfDir = path.join(path.dirname(realpathSync(new URL(import.meta.url).pathname)), '..', 'workflows');
      const searchDirs = [projectWfDir, WORKFLOWS_DIR];
      let filePath = '';
      for (const dir of searchDirs) {
        const candidate = path.join(dir, name);
        if (existsSync(candidate)) { filePath = candidate; break; }
      }
      if (!filePath) { res.writeHead(404); res.end('Not found'); return; }
      try {
        const content = readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/yaml' });
        res.end(content);
      } catch { res.writeHead(500); res.end('Error reading file'); }
      return;
    }

    // API: Save a workflow YAML file
    if (req.method === 'PUT' && urlPath === '/api/workflow-file') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { name, content } = JSON.parse(body);
          if (!name || !content) { res.writeHead(400); res.end('Missing name or content'); return; }
          const filePath = path.join(WORKFLOWS_DIR, name);
          if (!filePath.startsWith(WORKFLOWS_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
          mkdirSync(path.dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', name }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }

    // API: Run a workflow (trigger via WebSocket to extension)
    if (req.method === 'POST' && urlPath === '/api/run-workflow') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { path: wfPath, yaml: wfYaml, sessionId, name: wfName } = JSON.parse(body);
          let resolvedPath = wfPath;
          let resolvedYaml = wfYaml;
          // If name is provided, resolve it to a file path
          if (wfName && !wfPath && !wfYaml) {
            const projectWfDir = path.join(path.dirname(realpathSync(new URL(import.meta.url).pathname)), '..', 'workflows');
            for (const dir of [projectWfDir, WORKFLOWS_DIR]) {
              const candidate = path.join(dir, wfName);
              if (existsSync(candidate)) {
                resolvedPath = candidate;
                break;
              }
            }
          }
          if (!resolvedPath && !resolvedYaml) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Provide path, yaml, or name parameter' }));
            return;
          }
          const result = await runWorkflow(
            { path: resolvedPath, yaml: resolvedYaml, sessionId },
            (cmd, cmdArgs) => sendToExtension(cmd, cmdArgs)
          );
          const report = formatReport(result);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result, report }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }

    // API: Tabs (proxied from extension)
    if (req.method === 'GET' && urlPath === '/api/tabs') {
      try {
        const tabs = await sendToExtension('GET_TABS', {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tabs));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // API: Connected tab info
    if (req.method === 'GET' && urlPath === '/api/connected-tab') {
      try {
        const info = await sendToExtension('GET_CONNECTED_TAB_INFO', {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connected: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // API: Connect to a tab
    if (req.method === 'POST' && urlPath === '/api/connect-tab') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { tabId } = JSON.parse(body);
          const result = await sendToExtension('CONNECT_TAB', { tabId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }

    // API: Disconnect tab
    if (req.method === 'POST' && urlPath === '/api/disconnect-tab') {
      try {
        const result = await sendToExtension('DISCONNECT_TAB', {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    let filePath: string;
    if (urlPath === '/home' || urlPath === '/home/' || urlPath === '/home/index.html') {
      // Serve dashboard home page
      const homePagePath = path.join(path.dirname(realpathSync(new URL(import.meta.url).pathname)), '..', 'src', 'dashboard-home.html');
      if (existsSync(homePagePath)) {
        const data = readFileSync(homePagePath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
        return;
      }
      res.writeHead(404);
      res.end('Home page not found');
      return;
    } else if (urlPath === '/' || urlPath === '/index.html') {
      filePath = path.join(WORKFLOWS_DIR, 'index.html');
    } else if (urlPath.startsWith('/test/') || urlPath === '/test') {
      // Serve test/sample-app
      const testPath = urlPath === '/test' || urlPath === '/test/' ? '/index.html' : urlPath.slice('/test'.length);
      filePath = path.join(TEST_APP_DIR, testPath || '/index.html');
      if (!filePath.startsWith(TEST_APP_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = path.join(TEST_APP_DIR, 'index.html');
      }
      // Serve directly, bypass WORKFLOWS_DIR check
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      try {
        const data = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end('Internal error');
      }
      return;
    } else {
      filePath = path.join(WORKFLOWS_DIR, urlPath);
    }
    // Prevent path traversal
    if (!filePath.startsWith(WORKFLOWS_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // Serve directory listing as JSON for frames/ (for recording playback)
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        const files = execSync(`ls -1 "${filePath}"`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
        const html = files.map(f => `<a href="${path.basename(f)}">${f}</a>`).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    try {
      const data = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  const wss = new WebSocketServer({ server: httpServer });

  httpServer.listen(port, '127.0.0.1', () => {
    process.stderr.write(`[Smartwriter MCP] HTTP+WS server started on http://localhost:${port}\n`);
    process.stderr.write(`[Smartwriter MCP] Dashboard: http://localhost:${port}/\n`);
  });

  const EXTENSION_TYPES = new Set([
    'TABS_UPDATE', 'HANDSHAKE', 'START_REPORT_SERVER', 'STOP_REPORT_SERVER',
    'START_RECORDING', 'STOP_RECORDING', 'START_OBSERVE', 'STOP_OBSERVE',
    'GET_WORKFLOW_SETTINGS', 'TOGGLE_TRACKING', 'TAB_FLOW_STATE_CHANGE',
  ]);

  wss.on('connection', (ws) => {
    // Identify connection type by first message:
    // Extension sends { type: "TABS_UPDATE" | "HANDSHAKE" | ... }
    // Other WS clients send different types (e.g. { type: "RUN_WORKFLOW" })
    let identified = false;

    const identify = (data: Buffer) => {
      if (identified) return;
      identified = true;
      try {
        const parsed = JSON.parse(data.toString());
        const isExtension = EXTENSION_TYPES.has(parsed.type);
        if (isExtension) {
          process.stderr.write('[Smartwriter MCP] Chrome extension connected!\n');
          if (extensionWs && extensionWs !== ws && extensionWs.readyState === WebSocket.OPEN) extensionWs.close();
          extensionWs = ws;
          ws.on('message', (d: Buffer) => extensionMessageHandler(d, ws));
          ws.on('close', () => {
            process.stderr.write('[Smartwriter MCP] Chrome extension disconnected. Waiting for reconnect...\n');
            if (extensionWs === ws) extensionWs = null;
            for (const [id, pending] of pendingRequests) {
              clearTimeout(pending.timeout);
              pending.reject(new Error('Extension disconnected'));
              pendingRequests.delete(id);
            }
          });
          extensionMessageHandler(data, ws);
        } else if (parsed.type === 'RUN_WORKFLOW') {
          // Allow WS clients to trigger workflow runs
          process.stderr.write('[Smartwriter MCP] WS client requested RUN_WORKFLOW\n');
          ws.on('message', async (d: Buffer) => {
            try {
              const msg = JSON.parse(d.toString());
              if (msg.type !== 'RUN_WORKFLOW') return;
              const result = await runWorkflow(
                { path: msg.path, yaml: msg.yaml, sessionId: msg.sessionId },
                (cmd, cmdArgs) => sendToExtension(cmd, cmdArgs)
              );
              const report = formatReport(result);
              ws.send(JSON.stringify({ type: 'WORKFLOW_RESULT', result, report }));
            } catch (e) {
              ws.send(JSON.stringify({ type: 'WORKFLOW_ERROR', error: e instanceof Error ? e.message : String(e) }));
            }
          });
          // Process the first message too
          (async () => {
            try {
              const result = await runWorkflow(
                { path: parsed.path, yaml: parsed.yaml, sessionId: parsed.sessionId },
                (cmd, cmdArgs) => sendToExtension(cmd, cmdArgs)
              );
              const report = formatReport(result);
              ws.send(JSON.stringify({ type: 'WORKFLOW_RESULT', result, report }));
            } catch (e) {
              ws.send(JSON.stringify({ type: 'WORKFLOW_ERROR', error: e instanceof Error ? e.message : String(e) }));
            }
          })();
        } else {
          process.stderr.write('[Smartwriter MCP] Non-extension WS client connected (type=' + (parsed.type || 'unknown') + '), ignoring\n');
        }
      } catch {
        process.stderr.write('[Smartwriter MCP] Unknown client, ignoring\n');
      }
    };

    ws.once('message', identify);
  });

  function extensionMessageHandler(data: Buffer, senderWs?: WebSocket) {
    const ws = senderWs || extensionWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'TABS_UPDATE') return;

        // Handle extension-initiated commands (START/STOP_REPORT_SERVER)
        if (msg.type === 'START_REPORT_SERVER') {
          // MCP server always serves the dashboard on its own port
          // If a separate report server was spawned, prefer that port
          const serverPort = reportServerPort || port;
          ws.send(JSON.stringify({ requestId: msg.requestId, result: { url: `http://localhost:${serverPort}/`, port: serverPort, status: reportServerPort ? 'already_running' : 'running' } }));
          return;
        }

        if (msg.type === 'STOP_REPORT_SERVER') {
          // Kill separate report server child process if one was spawned
          killReportServer();
          ws.send(JSON.stringify({ requestId: msg.requestId, result: { status: 'stopped' } }));
          return;
        }

        // Handle workflow delete commands from dashboard
        if (msg.type === 'DELETE_RESULT') {
          const deleted = deleteWorkflowResult(msg.id);
          ws.send(JSON.stringify({ requestId: msg.requestId, result: { deleted, id: msg.id } }));
          return;
        }
        if (msg.type === 'DELETE_GROUP') {
          const groupPath = (msg.group || '').split('/').map((s: string) => s.trim()).filter(Boolean);
          const count = deleteWorkflowGroup(groupPath);
          ws.send(JSON.stringify({ requestId: msg.requestId, result: { deleted: count, group: msg.group } }));
          return;
        }
        if (msg.type === 'DELETE_SESSION') {
          const count = deleteWorkflowSession(msg.sessionId);
          ws.send(JSON.stringify({ requestId: msg.requestId, result: { deleted: count, sessionId: msg.sessionId } }));
          return;
        }

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
  }

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

    // Report server management — spawn/kill child process
    if (name === 'start_report_server') {
      // MCP server always serves the dashboard on its own port
      // If a separate report server was spawned, prefer that port
      const serverPort = reportServerPort || port;
      return textResponse({ url: `http://localhost:${serverPort}/`, port: serverPort, status: reportServerPort ? 'already_running' : 'running' });
    }

    if (name === 'stop_report_server') {
      try {
        if (!reportServerProcess) {
          return textResponse({ status: 'not_running' });
        }
        // Kill separate report server child process if one was spawned
        // Dashboard remains available on MCP server port
        killReportServer();
        return textResponse({ status: 'stopped', note: 'Dashboard remains available on MCP server port' });
      } catch (e) { return errorResponse(e); }
    }

    // Assertion tools — build conditions and send ASSERT command
    if (name === 'assert_url') {
      const conditions: Record<string, string> = {};
      if (args.equals) conditions.url = String(args.equals);
      if (args.contains) conditions.url_contains = String(args.contains);
      if (args.starts_with) conditions.url_starts_with = String(args.starts_with);
      if (args.matches) conditions.url_matches = String(args.matches);
      try {
        const result = await sendToExtension('ASSERT', { conditions });
        return textResponse(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResponse(e);
      }
    }
    if (name === 'assert_visible') {
      try {
        const result = await sendToExtension('ASSERT', { conditions: { visible: String(args.text) } });
        return textResponse(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResponse(e);
      }
    }
    if (name === 'assert_not_visible') {
      try {
        const result = await sendToExtension('ASSERT', { conditions: { not_visible: String(args.text) } });
        return textResponse(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResponse(e);
      }
    }
    if (name === 'assert_element') {
      try {
        const result = await sendToExtension('ASSERT', { conditions: { element: String(args.selector) } });
        return textResponse(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResponse(e);
      }
    }
    if (name === 'assert_not_element') {
      try {
        const result = await sendToExtension('ASSERT', { conditions: { not_element: String(args.selector) } });
        return textResponse(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResponse(e);
      }
    }

    // Workflow execution — runs locally, orchestrates extension commands
    if (name === 'run_workflow') {
      try {
        const result = await runWorkflow(
          { path: args.path as string | undefined, yaml: args.yaml as string | undefined, sessionId: args.sessionId as string | undefined },
          (cmd, cmdArgs) => sendToExtension(cmd, cmdArgs)
        );
        const report = formatReport(result);
        return textResponse(report);
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (name === 'delete_workflow_result') {
      try {
        const deleted = deleteWorkflowResult(args.id as string);
        return textResponse(deleted ? `Deleted result ${args.id}` : `Result ${args.id} not found`);
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (name === 'delete_workflow_group') {
      try {
        const groupPath = (args.group as string).split('/').map((s: string) => s.trim()).filter(Boolean);
        const count = deleteWorkflowGroup(groupPath);
        return textResponse(`Deleted ${count} results in group ${args.group}`);
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (name === 'delete_workflow_session') {
      try {
        const count = deleteWorkflowSession(args.sessionId as string);
        return textResponse(`Deleted ${count} results in session ${args.sessionId}`);
      } catch (e) {
        return errorResponse(e);
      }
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
              return textResponse(result, name);
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

      return textResponse(result, name);
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
