# Smartwriter MCP Chrome Extension API

Complete protocol documentation for communicating with the Chrome extension via the MCP server.

## Overview

The MCP server communicates with the Chrome extension via WebSocket on `ws://localhost:9223`. The extension acts as a bridge between the MCP server and browser tabs, relaying commands and returning results.

## Connection

### Establishing Connection

The extension listens for WebSocket connections on port 9223. When a connection is established:

1. Extension sends initial `TABS_UPDATE` with current tab list
2. MCP server can then send `COMMAND` messages
3. Extension responds with `result` or `error` for each command

### Example Connection Code (Node.js)

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:9223');

ws.on('open', () => {
  console.log('Connected to extension');
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received:', message);
});

ws.on('error', (error) => {
  console.error('Connection error:', error);
});
```

## Message Types

### TABS_UPDATE (from extension)

Sent when tabs change (open, close, activate, reload).

```json
{
  "type": "TABS_UPDATE",
  "currentTabId": 42,
  "tabs": [
    {
      "tabId": 42,
      "url": "https://example.com",
      "title": "Example Domain",
      "active": true
    },
    {
      "tabId": 43,
      "url": "https://google.com",
      "title": "Google",
      "active": false
    }
  ]
}
```

**Fields:**
- `type`: Always `"TABS_UPDATE"`
- `currentTabId`: Tab ID of currently controlled tab (null if none selected)
- `tabs`: Array of available tabs

### COMMAND (to extension)

Send a command to execute on a specific tab.

```json
{
  "type": "COMMAND",
  "requestId": "req-12345",
  "tabId": 42,
  "command": "CLICK",
  "args": {
    "selector": ".submit-button"
  }
}
```

**Fields:**
- `type`: Always `"COMMAND"`
- `requestId`: Unique ID to correlate response (string)
- `tabId`: Target tab ID (from `TABS_UPDATE`)
- `command`: Command name (see Commands section)
- `args`: Command-specific arguments

### Response (from extension)

Response to a COMMAND message.

```json
{
  "requestId": "req-12345",
  "result": {
    "clicked": true,
    "selector": ".submit-button"
  }
}
```

Or on error:

```json
{
  "requestId": "req-12345",
  "error": "Element not found: .submit-button"
}
```

**Fields:**
- `requestId`: Matches the request ID
- `result`: Command result (if successful)
- `error`: Error message (if failed)

## Commands

### CLICK

Click an element by CSS selector.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-1",
  "tabId": 42,
  "command": "CLICK",
  "args": {
    "selector": ".button-primary"
  }
}
```

**Response:**
```json
{
  "requestId": "req-1",
  "result": {
    "clicked": true,
    "selector": ".button-primary"
  }
}
```

**Errors:**
- `Element not found: {selector}`

### TYPE

Type text character by character with input events.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-2",
  "tabId": 42,
  "command": "TYPE",
  "args": {
    "selector": "input[type='text']",
    "text": "Hello World"
  }
}
```

**Response:**
```json
{
  "requestId": "req-2",
  "result": {
    "typed": true,
    "selector": "input[type='text']",
    "text": "Hello World"
  }
}
```

**Errors:**
- `Element not found: {selector}`
- `Element is not an input: {selector}`

**Timing:** 10ms between keystrokes

### FILL

Fill input quickly without character-by-character simulation.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-3",
  "tabId": 42,
  "command": "FILL",
  "args": {
    "selector": "input[type='email']",
    "value": "user@example.com"
  }
}
```

**Response:**
```json
{
  "requestId": "req-3",
  "result": {
    "filled": true,
    "selector": "input[type='email']",
    "value": "user@example.com"
  }
}
```

**Errors:**
- `Element not found: {selector}`
- `Element is not an input: {selector}`

### SELECT

Select option in a dropdown.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-4",
  "tabId": 42,
  "command": "SELECT",
  "args": {
    "selector": "select[name='country']",
    "options": ["US"]
  }
}
```

**Response:**
```json
{
  "requestId": "req-4",
  "result": {
    "selected": true,
    "selector": "select[name='country']",
    "option": "US"
  }
}
```

**Errors:**
- `Element not found: {selector}`
- `Element is not a select: {selector}`

**Note:** Only first option in array is selected

### NAVIGATE

Navigate to a new URL.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-5",
  "tabId": 42,
  "command": "NAVIGATE",
  "args": {
    "url": "https://example.com/page2"
  }
}
```

**Response:**
```json
{
  "requestId": "req-5",
  "result": {
    "navigating": true,
    "url": "https://example.com/page2"
  }
}
```

**Note:** Waits 100ms before navigating to allow proper timing

### EVALUATE

Execute JavaScript code in page context.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-6",
  "tabId": 42,
  "command": "EVALUATE",
  "args": {
    "script": "return document.title;",
    "args": []
  }
}
```

**Response:**
```json
{
  "requestId": "req-6",
  "result": "Example Domain"
}
```

**Request with arguments:**
```json
{
  "type": "COMMAND",
  "requestId": "req-7",
  "tabId": 42,
  "command": "EVALUATE",
  "args": {
    "script": "return arg0 + arg1;",
    "args": [5, 3]
  }
}
```

**Response:**
```json
{
  "requestId": "req-7",
  "result": 8
}
```

**Errors:**
- `Script evaluation failed: {error}`

**Note:** Arguments are available as `arg0`, `arg1`, etc. in the script

### HOVER

Hover over an element.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-8",
  "tabId": 42,
  "command": "HOVER",
  "args": {
    "selector": ".tooltip-trigger"
  }
}
```

**Response:**
```json
{
  "requestId": "req-8",
  "result": {
    "hovered": true,
    "selector": ".tooltip-trigger"
  }
}
```

**Errors:**
- `Element not found: {selector}`

### GET_SNAPSHOT

Get accessibility tree and HTML snapshot of page.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-9",
  "tabId": 42,
  "command": "GET_SNAPSHOT",
  "args": {}
}
```

**Response:**
```json
{
  "requestId": "req-9",
  "result": {
    "url": "https://example.com",
    "title": "Example Domain",
    "tree": {
      "tag": "html",
      "role": null,
      "text": null,
      "ariaLabel": null,
      "children": [
        {
          "tag": "body",
          "role": null,
          "text": null,
          "children": [
            {
              "tag": "h1",
              "text": "Example Domain",
              "children": []
            }
          ]
        }
      ]
    },
    "html": "<!DOCTYPE html>..."
  }
}
```

**With specific element:**
```json
{
  "type": "COMMAND",
  "requestId": "req-10",
  "tabId": 42,
  "command": "GET_SNAPSHOT",
  "args": {
    "selector": ".content"
  }
}
```

**Tree Node Fields:**
- `tag`: HTML tag name
- `role`: ARIA role (if specified)
- `text`: Element text (for leaf nodes)
- `ariaLabel`: ARIA label
- `children`: Child nodes (limited to 15)
- `selector`: CSS selector for element
- `id`: Element ID
- `className`: Class names

### SCREENSHOT

Take a screenshot of the page.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-11",
  "tabId": 42,
  "command": "SCREENSHOT",
  "args": {}
}
```

**Response:**
```json
{
  "requestId": "req-11",
  "result": {
    "dataUrl": "data:image/png;base64,...",
    "width": 1920,
    "height": 1080,
    "viewport": {
      "width": 1920,
      "height": 1080
    }
  }
}
```

**Note:** Current implementation provides basic canvas rendering

### WAIT_FOR

Wait for text to appear on page.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-12",
  "tabId": 42,
  "command": "WAIT_FOR",
  "args": {
    "text": "Loading complete",
    "timeout": 5000
  }
}
```

**Response:**
```json
{
  "requestId": "req-12",
  "result": {
    "found": true,
    "text": "Loading complete",
    "timeMs": 2150
  }
}
```

**Errors:**
- `Text not found within {timeout}ms: {text}`

**Parameters:**
- `text`: Text to search for in page body
- `timeout`: Max wait time in milliseconds (default: 5000)

### PRESS_KEY

Press a keyboard key.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-13",
  "tabId": 42,
  "command": "PRESS_KEY",
  "args": {
    "key": "Enter"
  }
}
```

**Response:**
```json
{
  "requestId": "req-13",
  "result": {
    "keyPressed": true,
    "key": "Enter"
  }
}
```

**Key values:**
- `"Enter"`, `"Tab"`, `"Escape"`, `"Backspace"`
- `"ArrowUp"`, `"ArrowDown"`, `"ArrowLeft"`, `"ArrowRight"`
- `"Control"`, `"Shift"`, `"Alt"`, `"Meta"`
- Single characters: `"a"`, `"1"`, `"!"`, etc.

**Errors:**
- `No active element found`

**Note:** Key is pressed on currently focused element

### GET_TEXT

Extract text content from element.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-14",
  "tabId": 42,
  "command": "GET_TEXT",
  "args": {
    "selector": ".error-message"
  }
}
```

**Response:**
```json
{
  "requestId": "req-14",
  "result": {
    "text": "Error: Invalid input",
    "selector": ".error-message"
  }
}
```

**Errors:**
- `Element not found: {selector}`

### GET_ATTRIBUTE

Extract attribute value from element.

**Request:**
```json
{
  "type": "COMMAND",
  "requestId": "req-15",
  "tabId": 42,
  "command": "GET_ATTRIBUTE",
  "args": {
    "selector": "input[type='text']",
    "attribute": "placeholder"
  }
}
```

**Response:**
```json
{
  "requestId": "req-15",
  "result": {
    "value": "Enter your name",
    "attribute": "placeholder",
    "selector": "input[type='text']"
  }
}
```

**Errors:**
- `Element not found: {selector}`

## Error Handling

### Common Error Responses

**Element not found:**
```json
{
  "requestId": "req-1",
  "error": "Element not found: .nonexistent"
}
```

**Invalid element type:**
```json
{
  "requestId": "req-2",
  "error": "Element is not an input: div.text"
}
```

**Timeout:**
```json
{
  "requestId": "req-12",
  "error": "Text not found within 5000ms: Expected Text"
}
```

**Connection errors:**
```json
{
  "requestId": "req-1",
  "error": "No tab specified"
}
```

### Error Recovery

- All errors include descriptive messages
- Connection failures trigger automatic extension reconnect
- Command timeout is 30 seconds per operation
- No automatic retries (client responsibility)

## Example: Complete Workflow

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:9223');
let currentTabId = null;

ws.on('message', async (data) => {
  const message = JSON.parse(data);

  if (message.type === 'TABS_UPDATE') {
    // Select first available tab
    if (message.tabs.length > 0) {
      currentTabId = message.tabs[0].tabId;
      console.log(`Selected tab: ${message.tabs[0].title}`);

      // Start automation
      await clickButton();
      await fillForm();
      await submitForm();
    }
  }
});

function sendCommand(command, args) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${Date.now()}`;

    // Set up response handler
    const handler = (data) => {
      const response = JSON.parse(data);
      if (response.requestId === requestId) {
        ws.removeListener('message', handler);
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.result);
        }
      }
    };

    ws.on('message', handler);

    // Send command
    ws.send(JSON.stringify({
      type: 'COMMAND',
      requestId,
      tabId: currentTabId,
      command,
      args
    }));

    // Timeout after 30 seconds
    setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Command timeout'));
    }, 30000);
  });
}

async function clickButton() {
  const result = await sendCommand('CLICK', {
    selector: '.submit'
  });
  console.log('Clicked button:', result);
}

async function fillForm() {
  await sendCommand('FILL', {
    selector: 'input[name="username"]',
    value: 'testuser'
  });
  console.log('Filled username');
}

async function submitForm() {
  await sendCommand('CLICK', {
    selector: 'button[type="submit"]'
  });
  console.log('Form submitted');
}
```

## Performance Notes

- Typical command latency: 50-200ms
- Complex DOM operations may take longer
- Concurrent commands to different tabs are supported
- Sequential commands to same tab should wait for response

## Limitations

- Cannot access restricted pages (`about:*`, `chrome://*`, etc.)
- Screenshot is canvas-based (not full rendering)
- Accessibility tree limited to 8 levels deep
- HTML snapshot limited to 5000 characters
- Content scripts run with page privileges
- Cannot access cookies or localStorage (security restriction)
