# Smartwriter MCP Chrome Extension

A production-ready Chrome extension that acts as a bridge between the Model Context Protocol (MCP) server and Chrome tabs, enabling remote DOM automation and browser control via WebSocket.

## Architecture

### Overview

```
MCP Server (ws://localhost:9223)
         ↓ (WebSocket)
    Background Service Worker
         ↓ (chrome.runtime.sendMessage)
    Content Scripts (in tabs)
         ↓ (DOM APIs)
    Page DOM Elements
```

### Components

#### 1. Background Service Worker (`src/background.ts`)
- **WebSocket Server**: Initiates WebSocket connection to MCP server on port 9223
- **Tab Management**: Tracks all open tabs and their status
- **Command Router**: Routes MCP commands to appropriate content scripts
- **Automatic Reconnection**: Reconnects to MCP server with exponential backoff (up to 10 attempts)
- **Tab Updates**: Sends periodic updates about available tabs to MCP server

**Key Features:**
- Non-blocking WebSocket connection handling
- Proper error handling and recovery
- Tab lifecycle management (activation, update, removal)
- Request/response correlation for concurrent commands

#### 2. Content Script (`src/content.ts`)
- **DOM Manipulation**: Executes commands on the page DOM
- **Message Handler**: Listens for commands from background script
- **Accessibility Tree**: Builds semantic accessibility tree of page structure

**Supported Commands:**
- `CLICK` - Click element by selector
- `TYPE` - Type text character-by-character with events
- `FILL` - Fill input/textarea quickly
- `SELECT` - Change select dropdown value
- `NAVIGATE` - Change page location
- `EVALUATE` - Execute JavaScript code
- `HOVER` - Hover over element
- `GET_SNAPSHOT` - Get accessibility tree and HTML snapshot
- `SCREENSHOT` - Capture basic screenshot
- `WAIT_FOR` - Wait for text to appear
- `PRESS_KEY` - Press keyboard key
- `GET_TEXT` - Extract element text
- `GET_ATTRIBUTE` - Extract element attribute
- `REGISTER` - Register tab with background script

#### 3. Popup UI (`src/popup.ts` + `src/popup.html`)
- **Tab List**: Shows all open tabs with titles and URLs
- **Connection Status**: Displays connection state to MCP server
- **Tab Selection**: UI to select which tab to control
- **Auto-refresh**: Updates tab list and connection status every 2 seconds

#### 4. Type Definitions (`src/types.ts`)
- `ContentMessage` - Message types from background to content script
- `ContentResponse` - Response format from content script
- `TabInfo` - Tab metadata (id, title, url, active state)
- `McpCommand` - Command format from MCP server
- `McpResponse` - Response format to MCP server
- `TabsUpdate` - Tab list update message

## Installation & Development

### Prerequisites
- Node.js 16+
- npm or yarn
- Chrome/Chromium browser

### Setup
```bash
cd extensions/chrome
npm install
npm run build      # Build for production
npm run watch      # Watch mode for development
npm run typecheck  # Type checking
```

### Loading in Chrome
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extensions/chrome/` directory

## Communication Protocol

### MCP ↔ Background Script (WebSocket)

**MCP Server sends:**
```json
{
  "type": "COMMAND",
  "requestId": "req-123",
  "tabId": 42,
  "command": "CLICK",
  "args": {
    "selector": ".submit-button"
  }
}
```

**Extension responds:**
```json
{
  "requestId": "req-123",
  "result": {
    "clicked": true,
    "selector": ".submit-button"
  }
}
```

### Background Script ↔ Content Script (chrome.runtime.sendMessage)

**Background sends:**
```typescript
{
  type: 'CLICK',
  selector: '.submit-button'
}
```

**Content script responds:**
```typescript
{
  success: true,
  data: {
    clicked: true,
    selector: '.submit-button'
  }
}
```

### Tab Updates (Background → MCP)
```json
{
  "type": "TABS_UPDATE",
  "currentTabId": 42,
  "tabs": [
    {
      "tabId": 42,
      "url": "https://example.com",
      "title": "Example",
      "active": true
    }
  ]
}
```

## Error Handling

### Content Script Errors
- Missing elements: `"Element not found: {selector}"`
- Invalid inputs: `"Element is not an input: {selector}"`
- Script evaluation: `"Script evaluation failed: {error}"`

### Connection Errors
- WebSocket failures: Automatic retry with exponential backoff
- Tab not found: Returns error to requesting MCP command
- Command timeout: 30 second timeout per command

## Performance Considerations

1. **Accessibility Tree**: Limited to 8 levels deep and 15 children per node
2. **HTML Snapshot**: Capped at 5000 characters
3. **Delay Handling**: 10ms between keystrokes for type simulation
4. **Tab Updates**: Sent on tab activation, update, and removal
5. **Request Timeout**: 30 seconds maximum for any command

## Security Notes

⚠️ **Important**: This extension connects to a local WebSocket server (port 9223).

- Only connects to `localhost:9223` - no remote connections
- Content scripts run with page privileges
- No data is sent to external services
- Extension requires `<all_urls>` host permission for DOM access

## Debugging

### Enable Logging
The extension logs to the browser console with `[EXT]` prefix:
- Background: DevTools → Extensions page → Service Worker console
- Content: DevTools → Console on any page
- Popup: DevTools for popup.html

### Common Issues

**WebSocket not connecting:**
- Verify MCP server running on port 9223
- Check browser console for connection errors
- Ensure `localhost` resolution works

**Content script not responding:**
- Check tab URL is not about:blank or chrome:// (restricted pages)
- Verify content script injected (check page console for REGISTER message)

**No tabs appearing:**
- Try clicking extension icon to refresh
- Popup auto-refreshes every 2 seconds
- Check popup console for errors

## Build Output

The build process generates:
- `dist/background.js` - Service worker (IIFE format)
- `dist/content.js` - Content script (IIFE format)
- `dist/popup.js` - Popup UI (IIFE format)
- `dist/popup.html` - Popup UI markup
- `dist/manifest.json` - Extension manifest

All files use IIFE format for immediate execution without module loading.

## Future Enhancements

Potential improvements:
- [ ] Frame support (cross-frame DOM access)
- [ ] Multi-tab concurrent command handling
- [ ] Advanced screenshot with full rendering
- [ ] File upload/download handling
- [ ] Cookie and localStorage access
- [ ] Custom event injection
- [ ] Network request interception

## License

Same as parent project.
