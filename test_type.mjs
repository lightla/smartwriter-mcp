import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--port', '9225'],
});

const client = new Client({ name: 'test-type', version: '1.0.0' });

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
  console.log('MCP connected. Waiting for extension...');

  if (!await waitExtension()) {
    console.error('Extension not connected');
    process.exit(1);
  }
  console.log('Extension connected!');

  // Test 1: smart_focus on Email
  console.log('\n--- Test 1: smart_focus(Email) ---');
  const focusResult = await client.callTool({ name: 'smart_focus', arguments: { target: 'Email' } });
  console.log('smart_focus:', focusResult.content[0].text);

  // Test 2: smart_type on Password
  console.log('\n--- Test 2: smart_type(Password, secret123) ---');
  const stResult = await client.callTool({ name: 'smart_type', arguments: { target: 'Password', text: 'secret123' } });
  console.log('smart_type:', stResult.content[0].text);

  // Test 3: smart_fill on Email
  console.log('\n--- Test 3: smart_fill(Email, test@example.com) ---');
  const sfResult = await client.callTool({ name: 'smart_fill', arguments: { target: 'Email', value: 'test@example.com' } });
  console.log('smart_fill:', sfResult.content[0].text);

  // Test 4: smart_select_option
  console.log('\n--- Test 4: smart_select_option(Country, Vietnam) ---');
  const soResult = await client.callTool({ name: 'smart_select_option', arguments: { target: 'Country', options: 'Vietnam' } });
  console.log('smart_select_option:', soResult.content[0].text);

  // Test 5: smart_check
  console.log('\n--- Test 5: smart_check("I agree to the terms") ---');
  const scResult = await client.callTool({ name: 'smart_check', arguments: { target: 'I agree to the terms' } });
  console.log('smart_check:', scResult.content[0].text);

  // Test 6: smart_click Submit
  console.log('\n--- Test 6: smart_click(Submit) ---');
  const clkResult = await client.callTool({ name: 'smart_click', arguments: { target: 'Submit' } });
  console.log('smart_click:', clkResult.content[0].text);

  console.log('\nAll tests done!');
  await client.close();
} catch (e) {
  console.error('Test failed:', e);
  process.exit(1);
}
process.exit(0);