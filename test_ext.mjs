// Test smart_focus via MCP client connected to port 9223 (where extension is)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--port', '9225'],
});

const client = new Client({ name: 'test-ext', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log('Connected. Testing smart_focus...');

  const result = await client.callTool({
    name: 'smart_focus',
    arguments: { target: 'More information' }
  });
  console.log('smart_focus result:', JSON.stringify(result, null, 2));

  await client.close();
} catch (e) {
  console.error('Test failed:', e.message);
  process.exit(1);
}
process.exit(0);