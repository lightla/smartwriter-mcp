import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--port', '9225'],
});

const client = new Client({ name: 'test-smart', version: '1.0.0' });

async function waitExtension() {
  for (let i = 0; i < 15; i++) {
    const info = await client.callTool({ name: 'cli_server_info', arguments: {} });
    const text = info.content[0].text;
    if (text.includes('extensionConnected true')) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

try {
  await client.connect(transport);
  console.log('MCP connected. Waiting for extension...');

  if (!await waitExtension()) {
    console.error('Extension not connected');
    process.exit(1);
  }
  console.log('Extension connected!');

  // Test 1: smart_focus on Email
  console.log('\n--- Test 1: smart_focus on "Email" ---');
  const focusResult = await client.callTool({ name: 'smart_focus', arguments: { target: 'Email' } });
  console.log('smart_focus(Email):', focusResult.content[0].text);

  // Test 2: smart_type on Email
  console.log('\n--- Test 2: smart_type on "Email" ---');
  const typeResult = await client.callTool({ name: 'smart_type', arguments: { target: 'Email', text: 'test@example.com' } });
  console.log('smart_type(Email, test@example.com):', typeResult.content[0].text);

  // Test 3: smart_click on Submit
  console.log('\n--- Test 3: smart_click on "Submit" ---');
  const clickResult = await client.callTool({ name: 'smart_click', arguments: { target: 'Submit' } });
  console.log('smart_click(Submit):', clickResult.content[0].text);

  // Test 4: smart_check on "I agree to the terms"
  console.log('\n--- Test 4: smart_check on "I agree to the terms" ---');
  const checkResult = await client.callTool({ name: 'smart_check', arguments: { target: 'I agree to the terms' } });
  console.log('smart_check:', checkResult.content[0].text);

  // Test 5: smart_click Submit again
  console.log('\n--- Test 5: smart_click "Submit" (with data filled) ---');
  const clickResult2 = await client.callTool({ name: 'smart_click', arguments: { target: 'Submit' } });
  console.log('smart_click(Submit):', clickResult2.content[0].text);

  console.log('\nAll tests done!');
  await client.close();
} catch (e) {
  console.error('Test failed:', e);
  process.exit(1);
}
process.exit(0);