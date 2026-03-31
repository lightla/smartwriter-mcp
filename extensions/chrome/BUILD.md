# Build Guide - Smartwriter MCP Chrome Extension

## Prerequisites

- Node.js 16.0 or higher
- npm 7.0 or higher
- Chrome/Chromium 90+ (for MV3 support)

## Installation

```bash
cd extensions/chrome
npm install
```

## Build Commands

### Production Build
Minified and optimized for distribution:
```bash
npm run build
```

Output:
- `dist/background.js` - Minified service worker
- `dist/content.js` - Minified content script
- `dist/popup.js` - Minified popup UI
- `dist/popup.html` - Popup HTML
- `dist/manifest.json` - Extension manifest

### Development Build
With source maps for debugging:
```bash
npm run build:dev
```

### Watch Mode
Rebuilds on file changes:
```bash
npm run watch
```

### Type Checking
Verify TypeScript types:
```bash
npm run typecheck
```

### Clean
Remove build artifacts:
```bash
npm run clean
```

## Loading in Chrome

1. **Build the extension:**
   ```bash
   npm run build
   ```

2. **Open Chrome Extensions page:**
   - URL: `chrome://extensions/`

3. **Enable Developer Mode:**
   - Toggle "Developer mode" in top-right corner

4. **Load unpacked:**
   - Click "Load unpacked" button
   - Select the `extensions/chrome/` directory

5. **Verify installation:**
   - Extension appears in list as "Smartwriter MCP"
   - Icon appears in Chrome toolbar

## Development Workflow

### Hot Reload During Development

1. Start watch mode:
   ```bash
   npm run watch
   ```

2. Open `chrome://extensions/`

3. Click refresh icon on extension after file changes

4. Open popup (extension icon → click it)

5. Check console for logs:
   - **Background Service Worker**: Extensions page → "Service Worker" link
   - **Popup UI**: Popup → right-click → "Inspect"
   - **Content Script**: Page DevTools → Console tab

## Debugging

### Background Service Worker

1. Navigate to `chrome://extensions/`
2. Find "Smartwriter MCP" extension
3. Click on "Service Worker" link to open DevTools
4. View logs with `[EXT]` prefix
5. Check Network tab to see WebSocket connection

### Content Script

1. Open any web page
2. Right-click → "Inspect" (or press F12)
3. Go to Console tab
4. You should see messages when extension injects
5. All DOM commands will log here

### Popup UI

1. Click extension icon in toolbar
2. Right-click on popup
3. Select "Inspect"
4. View popup.js console and network activity
5. See tab list updates in real-time

## File Structure

```
extensions/chrome/
├── src/
│   ├── background.ts        # Service worker (main logic)
│   ├── content.ts           # Content script (DOM access)
│   ├── popup.ts             # Popup UI controller
│   ├── popup.html           # Popup markup
│   └── types.ts             # Shared TypeScript types
├── dist/                    # Build output (gitignored)
│   ├── background.js
│   ├── content.js
│   ├── popup.js
│   ├── popup.html
│   └── manifest.json
├── manifest.json            # Extension manifest (source)
├── package.json             # NPM config
├── tsconfig.json            # TypeScript config
├── README.md                # Extension documentation
└── BUILD.md                 # This file
```

## TypeScript Configuration

The `tsconfig.json` is configured for:
- **Target**: ES2022 (modern JavaScript)
- **Module**: ESNext (handled by bundler)
- **Lib**: ES2022 + DOM + WebWorker (for service workers)
- **Strict**: Enabled for type safety
- **Source Maps**: Enabled for development debugging

## Bundling

The build uses **tsup** with IIFE (Immediately Invoked Function Expression) format:

- **No splitting**: All code in single file per script
- **IIFE format**: Works in service workers and content scripts
- **No external dependencies**: All code bundled (no node_modules in dist)
- **Module-free**: No module system overhead

## Performance Tips

### Build Optimization
- Production builds are minified (~30-40KB gzipped)
- Source maps available in dev builds for debugging
- Watch mode rebuilds only changed files

### Runtime Optimization
- Content script uses CSS selectors efficiently
- Accessibility tree limited to 8 levels deep
- Snapshot HTML capped at 5000 characters
- Minimal DOM queries and reflows

## Troubleshooting

### Build fails with TypeScript errors
```bash
npm run typecheck
# Fix any reported errors
npm run build
```

### Extension doesn't load
1. Check `dist/manifest.json` exists
2. Verify manifest version is 3
3. Check console for manifest parsing errors
4. Try loading from different directory

### Service Worker crashes
1. Check DevTools console for errors
2. Look for uncaught Promise rejections
3. Verify all imports are bundled

### Content script not injecting
1. Check manifest permissions
2. Verify `dist/content.js` is readable
3. Page must not be restricted (about:*, chrome://*, etc.)
4. Check browser console for injection errors

### WebSocket connection failing
1. Verify MCP server running on `localhost:9223`
2. Check browser console for connection errors
3. Check if firewall blocks local port
4. Try `nc -zv localhost 9223` to test port

## CI/CD Integration

For continuous deployment:

```yaml
# Example: GitHub Actions
- name: Build Chrome Extension
  run: |
    cd extensions/chrome
    npm install
    npm run typecheck
    npm run build

- name: Create Release
  uses: actions/create-release@v1
  with:
    files: extensions/chrome/dist/**/*
```

## Version Management

Update version in:
1. `package.json` - npm version
2. `manifest.json` - Chrome extension version
3. Keep them in sync

```bash
# Bump version
npm version patch|minor|major
# Then update manifest.json with same version
```

## Publishing to Chrome Web Store

1. Build extension: `npm run build`
2. Create zip: `zip -r smartwriter-mcp.zip dist/`
3. Upload to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
4. Fill in required fields and submit for review

Note: Current setup is for development/local use. Web Store requires privacy policy and additional validation.

## Additional Resources

- [Chrome Extension Docs](https://developer.chrome.com/docs/extensions/)
- [MV3 Migration Guide](https://developer.chrome.com/docs/extensions/migrating/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [tsup Documentation](https://tsup.egoist.dev/)
