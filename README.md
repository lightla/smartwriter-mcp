# Smartwriter MCP

Full Playwright automation via MCP, controlled through Chrome extension. Never spawns a new browser - controls your existing tabs.

## Architecture

```
AI Agent
  ↓
MCP Server (/src) ← stdio
  ↓
WebSocket (default port 9023)
  ↓
Extension Background Script
  ↓
Content Script (selected tab)
  ↓
DOM Commands
```

## Setup

### 1. Build MCP Server

```bash
npm install
npm run build
npm start
```

The server waits for extension connection on `ws://localhost:9023` by default.

You can also choose a specific port or let the server pick the next free port:

```bash
smartwriter-mcp --port=9224
smartwriter-mcp --auto-port
```

When using `npm start`, pass CLI flags after `--`:

```bash
npm start -- --port=9224
npm start -- --auto-port
```

### 2. Build & Load Extension

```bash
cd extensions/chrome
npm install
npm run build
```

Load `dist/` folder in Chrome:
- Go to `chrome://extensions/`
- Enable "Developer mode"
- Click "Load unpacked"
- Select the `dist/` folder

### 3. Connect Tab via Extension

1. Click extension icon in toolbar
2. Click "Connect" next to any tab
3. MCP server will detect the connection
4. Use `selectTab(tabId)` to make it the active target

## Usage Example

```javascript
// Python / Node.js CLI to MCP server
// Server receives stdio and relays to extension

// Tool calls:
- cli_list_tools() → List all Smartwriter MCP tools with descriptions
- tab_get_all_compact_info() → Get flow tabs in compact form: tabId|tabTitle
- go_back() → Go back in history
- go_forward() → Go forward in history
- reload() → Reload the current page
- click(selector) → Click element
- type(selector, text) → Type text
- fill(selector, value) → Fill input instantly
- select_option(selector, options) → Select an option in a dropdown
- check(selector) → Check a checkbox or radio input
- uncheck(selector) → Uncheck a checkbox input
- navigate(url) → Go to URL
- screenshot() → Take a screenshot
- snapshot(selector?) → Get accessibility tree snapshot
- evaluate(script) → Run JavaScript code in the tab
- hover(selector) → Hover over element
- press_key(key) → Press a keyboard key (e.g., "Enter")
- wait_for(text, timeout?) → Wait for text to appear on page
- get_text(selector) → Read text content from an element
- get_attribute(selector, attribute) → Read an element attribute
- get_compact_annotations(type?) → Read compact annotations for connected tab: id|pageId|type|note + pageId|url
- flow_get_compact_annotations(type?) → Read compact annotations across flow tabs: id|pageId|flowId|type|note + pageId|url (sorted by annotation id)
```

Annotation action flow keeps normal selectors working while allowing lower-token annotation markers:

```javascript
// Existing path still works:
- click({ selector: ".submit-button" })

// Compact annotation path:
- get_compact_annotations() → id|url|type|note
                               a:1|p:1|change|Note 1
                               pageLabel|url
                               p:1|https://example.com/orders
- click({ selector: "a:1" })
- clear_all_anotations() → cleared|scope|count (connected tab, all URLs in that tab)
- flow_clear_all_anotations() → cleared|scope|count (flow tabs)
                      true|https://current-page...|1
```

## Key Features

✅ **100% Real Browser** - No headless mode, controls your actual Chrome
✅ **Full Playwright API** - All methods available
✅ **No New Instances** - Uses existing tabs only
✅ **Simple Tab Selection** - Click "Connect" to switch targets
✅ **WebSocket Bridge** - Reliable communication layer

## Architecture Details

- **MCP Server** (`/src`): Exposes Playwright tools via MCP protocol
  - Connects to extension via WebSocket
  - Relays tool calls to selected tab
  - Works with Claude API / stdin

- **Chrome Extension** (`/extensions/chrome`):
  - Background script: WebSocket server that relays commands
  - Content scripts: Execute DOM operations in each tab
  - Popup UI: Select which tab to control

- **Communication Flow**:
  1. AI agent calls tool on MCP server (stdio)
  2. MCP server sends command via WebSocket to extension
  3. Extension relays to content script in selected tab
  4. Content script executes and returns result
  5. Response flows back: content → extension → MCP → AI

## Troubleshooting

**Extension doesn't show up?**
- Make sure you're on a tab with the extension loaded (not special URLs like chrome://)

**MCP server can't connect to extension?**
- Extension must be loaded first
- Check extension console: Right-click extension → "Inspect"
- Verify port 9023 is free, or start the server with `--port=...` / `--auto-port`

**Commands timeout?**
- Tab might have navigated away
- Try connecting to the tab again via popup

**Special site won't work?**
- Some sites have strict CSP that blocks extension scripts
- Try on a normal website like google.com or github.com
