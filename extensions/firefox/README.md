# Smartwriter MCP Firefox Extension

A production-ready Firefox extension that acts as a bridge between the Smartwriter MCP server and Firefox tabs for Playwright-like automation.

## Features

- **WebSocket Server**: Runs on port 9223 to accept connections from the MCP server
- **Tab Management**: Tracks all open tabs and their metadata
- **DOM Automation**: Supports click, type, fill, navigate, hover, and more
- **Tab Selection**: UI to select which tab to control
- **Status Monitoring**: Shows WebSocket connection status and current tab info

## File Structure

```
extensions/firefox/
├── src/
│   ├── background.ts       # WebSocket server, tab tracking, command routing
│   ├── content.ts          # DOM command handlers injected into every tab
│   ├── popup.ts            # Popup UI logic
│   ├── popup.html          # Popup UI markup
│   ├── types.ts            # TypeScript type definitions
│   └── browser.d.ts        # Firefox WebExtensions API types
├── dist/                   # Compiled and bundled extension
├── manifest.json           # Extension configuration
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript configuration
└── build.sh               # Build script
```

## Supported Commands

The content script handles these DOM commands:

- `CLICK` - Click an element
- `TYPE` - Type text character by character
- `FILL` - Fill form field with value
- `SELECT` - Select dropdown option
- `NAVIGATE` - Navigate to URL
- `EVALUATE` - Execute JavaScript
- `HOVER` - Hover over element
- `GET_SNAPSHOT` - Get accessibility tree
- `SCREENSHOT` - Capture canvas screenshot
- `WAIT_FOR` - Wait for text to appear
- `PRESS_KEY` - Simulate key press
- `GET_TEXT` - Get element text content
- `GET_ATTRIBUTE` - Get element attribute value

## Build & Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Build for production
npm run build

# Watch for changes
npm run watch
```

## Installation

1. Run `npm run build` to compile TypeScript
2. Open Firefox Developer Edition or regular Firefox
3. Go to `about:debugging#/runtime/this-firefox`
4. Click "Load Temporary Add-on"
5. Select `dist/manifest.json`

## Architecture

### Background Script
- Initializes WebSocket server on port 9223
- Listens for MCP server connections
- Routes commands to content scripts via `browser.tabs.sendMessage`
- Maintains tab registry and current tab state
- Sends tab updates to MCP server

### Content Scripts
- Injected into every tab
- Listens for messages from background script
- Executes DOM manipulation commands
- Builds and returns accessibility trees
- Handles all interaction with page content

### Popup UI
- Lists all open Firefox tabs
- Shows current connected tab
- "Connect" button to select target tab
- WebSocket connection status indicator

## Type Safety

All TypeScript files have strict type checking enabled. Browser APIs are properly typed via `browser.d.ts`.

## Firefox Compatibility

- Uses `browser` namespace (Firefox WebExtensions API)
- Manifest V3 compatible
- Works with Firefox 109+
