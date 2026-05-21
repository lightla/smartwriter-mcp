import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--port', '9225'],
});

const client = new Client({ name: 'test-wf', version: '1.0.0' });

async function waitExtension() {
  for (let i = 0; i < 15; i++) {
    const info = await client.callTool({ name: 'cli_server_info', arguments: {} });
    if (info.content[0].text.includes('extensionConnected true')) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

try {
  await client.connect(transport);
  if (!await waitExtension()) { console.error('No extension'); process.exit(1); }
  console.log('Extension connected!');

  console.log('\n--- Testing run_workflow ---');
  const result = await client.callTool({
    name: 'run_workflow',
    arguments: { path: '/home/light/workspace/ai/smartwriter-mcp/test-workflow.yaml' }
  });
  console.log('Result:', result.content[0].text);

  await client.close();
} catch (e) {
  console.error('Failed:', e);
  process.exit(1);
}
process.exit(0);