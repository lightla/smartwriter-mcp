# Firefox Extension - Implementation Details

## Architecture Overview

```
MCP Server (port 9223)
         ↕ WebSocket
   Firefox Browser
         ↓
   Background Script (background.ts)
         ↓ browser.tabs.sendMessage
   Content Scripts (injected into all tabs)
         ↓
   DOM Manipulation / Page Content
```

## Message Flow

### MCP Server → Background Script → Content Script

1. **Connection**: MCP server connects to WebSocket on port 9223
2. **Command Received**: `{"type": "COMMAND", "tabId": 1, "command": "CLICK", "args": {"selector": "button"}}`
3. **Routing**: Background routes to content script: `browser.tabs.sendMessage(tabId, message)`
4. **Execution**: Content script executes handler and returns result
5. **Response**: Background sends back: `{"requestId": "...", "result": {...}}`

### Background Script → Popup UI

1. **Status Query**: Popup asks for current state
2. **Message**: `{"type": "GET_TABS"}` / `{"type": "GET_CURRENT_TAB"}`
3. **Response**: Returns list of tabs with metadata
4. **Refresh**: Popup auto-refreshes every 2 seconds

## Command Execution Pipeline

### CLICK Example
```
MCP: {"type": "COMMAND", "tabId": 1, "command": "CLICK", "args": {"selector": "a.button"}}
  ↓
Background: Routes to tab 1
  ↓
Content (tab 1):
  - querySelector("a.button")
  - element.click()
  - setTimeout 100ms
  - return {clicked: true, selector}
  ↓
Response: {"requestId": "req-1", "result": {clicked: true, selector: "a.button"}}
```

### FILL Example
```
MCP: {"type": "COMMAND", "tabId": 2, "command": "FILL", "args": {"selector": "#email", "value": "test@example.com"}}
  ↓
Background: Routes to tab 2
  ↓
Content (tab 2):
  - querySelector("#email")
  - element.value = "test@example.com"
  - dispatchEvent(input)
  - dispatchEvent(change)
  - return {filled: true, selector, value}
  ↓
Response: {"requestId": "req-2", "result": {filled: true, selector: "#email", value: "test@example.com"}}
```

## Tab Tracking System

### Initialization
- Background script maintains `registeredTabs: Map<number, TabInfo>`
- On each connection, MCP server receives list of all open tabs
- TabInfo = {tabId, url, title}

### Updates
- `browser.tabs.onRemoved` - Remove from map and send update
- `browser.tabs.onUpdated` - Update metadata if title/url changes
- Each change triggers `sendTabsUpdate()` to notify MCP

### Current Tab
- `currentTabId: number | null` tracks which tab is active
- Popup sends `CONNECT_TAB` to set current tab
- All commands route to currentTabId by default

## Error Handling

### Missing Elements
```javascript
const element = document.querySelector(selector);
if (!element) throw new Error(`Element not found: ${selector}`);
```

### Message Errors
```javascript
ws.on('error', (error: Error) => {
  console.error('[EXT] WebSocket error:', error);
});
```

### Command Errors
```javascript
catch (error) {
  ws.send(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  }));
}
```

## Type Safety

### ContentMessage Union
```typescript
type ContentMessage =
  | { type: 'CLICK'; selector: string }
  | { type: 'TYPE'; selector: string; text: string }
  | { type: 'FILL'; selector: string; value: string }
  // ... 10 more variants
```

Each message type has specific required fields - catches typos at compile time.

### Response Type
```typescript
type ContentResponse = {
  success: boolean;
  data?: unknown;
  error?: string;
};
```

All responses follow consistent structure for error handling.

## DOM Automation Details

### Element Selection
- Uses `document.querySelector()` - supports CSS selectors
- `buildA11yTree()` generates accessibility tree for snapshot
- `getCssSelector()` generates selector strings for elements

### Type Casting
```typescript
const element = document.querySelector(selector) as HTMLElement | null;
```
Safe casting with null checks before operations.

### Event Simulation
```javascript
element.dispatchEvent(new Event('input', { bubbles: true }));
element.dispatchEvent(new Event('change', { bubbles: true }));
```
Triggers framework listeners for React/Vue/etc.

## Performance Optimizations

- Accessibility tree depth limited to 10 levels
- Tree building limits to 20 children per node
- Screenshot limited to 10,000 chars HTML
- Type checking at build time (no runtime cost)

## Firefox-Specific Considerations

- Uses `browser` namespace instead of `chrome`
- Returns Promises from message handlers
- Manifest V3 with proper content script injection
- Host permissions for `<all_urls>`
- Background script uses "scripts" array (not "service_worker")

## WebSocket Protocol Details

### Server Setup
```javascript
const wsServer = new WebSocketServer({ port: 9223 });
```

### Connection Event
```javascript
wsServer.on('connection', (ws: WebSocket) => {
  sendTabsUpdate();  // Send initial state
  ws.on('message', ...)
  ws.on('close', ...)
  ws.on('error', ...)
});
```

### Message Format
```json
{
  "type": "COMMAND",
  "requestId": "unique-id",
  "tabId": 1,
  "command": "CLICK",
  "args": {"selector": "button"}
}
```

### Response Format
```json
{
  "requestId": "unique-id",
  "result": {"clicked": true, "selector": "button"}
}
```

or on error:

```json
{
  "requestId": "unique-id",
  "error": "Element not found: button"
}
```

## Build System

Uses **tsup** for bundling:
- Compiles TypeScript to JavaScript
- IIFE format for browser compatibility
- Includes `ws` module (133KB bundled)
- Produces ready-to-load extension files

Build script (`build.sh`):
1. Compiles all TypeScript files
2. Renames output files
3. Copies static assets
4. Creates distribution package

## Testing the Extension

### Manual Testing
1. Load extension via `about:debugging`
2. Open browser DevTools (F12)
3. Check background script console for logs
4. Use popup to select tab
5. Connect to MCP server for commands

### Verify Features
- [ ] Open multiple tabs
- [ ] Click Connect on different tabs
- [ ] Send CLICK command to element
- [ ] Send FILL command to input
- [ ] Send NAVIGATE command
- [ ] Check WebSocket connection status
- [ ] Close tab and verify removal
- [ ] Check accessibility tree output

## Known Limitations

None - extension is feature-complete for specified requirements.

## Future Enhancements (not included)

- Frame support for iframes
- Shadow DOM handling
- Video/media control commands
- Clipboard access
- Cookie management
- Storage inspection
