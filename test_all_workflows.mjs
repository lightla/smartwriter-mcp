import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--port', '9225'],
});

const client = new Client({ name: 'wf-runner', version: '1.0.0' });

async function waitExtension() {
  for (let i = 0; i < 15; i++) {
    const info = await client.callTool({ name: 'cli_server_info', arguments: {} });
    if (info.content[0].text.includes('extensionConnected true')) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

const WORKFLOWS = [
  'workflows/wf-pass-signup.yaml',
  'workflows/wf-pass-country.yaml',
  'workflows/wf-fail-no-password.yaml',
  'workflows/wf-fail-no-agree.yaml',
  'workflows/wf-fail-bad-email.yaml',
  'workflows/wf-fail-missing-name.yaml',
];

async function runWorkflow(path) {
  const result = await client.callTool({
    name: 'run_workflow',
    arguments: { path }
  });
  return result.content[0].text;
}

try {
  await client.connect(transport);
  if (!await waitExtension()) { console.error('No extension'); process.exit(1); }
  console.log('Extension connected!');

  for (const wf of WORKFLOWS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: ${wf}`);
    console.log('='.repeat(60));
    const report = await runWorkflow(wf);
    console.log(report);
    // Small delay between workflows
    await new Promise(r => setTimeout(r, 1000));
  }

  await client.close();
} catch (e) {
  console.error('Failed:', e);
  process.exit(1);
}
process.exit(0);