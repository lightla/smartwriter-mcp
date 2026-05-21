import { WebSocket } from 'ws';

const PORT = 9224;
const WORKFLOWS = [
  'workflows/wf-fail-empty-submit.yaml',
  'workflows/wf-fail-short-password.yaml',
  'workflows/wf-fail-bad-email-expect.yaml',
  'workflows/wf-fail-missing-name-expect.yaml',
  'workflows/wf-fail-no-agree-expect.yaml',
  'workflows/wf-pass-full-signup-expect.yaml',
  'workflows/wf-pass-all-fields-expect.yaml',
  'workflows/wf-pass-reset-form.yaml',
];

function runWorkflow(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout for ${path}`));
    }, 120000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'RUN_WORKFLOW', path }));
    });

    ws.on('message', (data) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'WORKFLOW_RESULT') {
          console.log(`\n===== ${path} =====`);
          console.log(msg.report);
          resolve(msg.result);
        } else if (msg.type === 'WORKFLOW_ERROR') {
          console.error(`\n===== ${path} =====`);
          console.error('ERROR:', msg.error);
          resolve(null);
        }
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
      ws.close();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

async function main() {
  const results = [];
  for (const wf of WORKFLOWS) {
    console.log(`\n>>> Running: ${wf}`);
    try {
      const result = await runWorkflow(wf);
      results.push({ workflow: wf, result });
    } catch (e) {
      console.error(`Failed: ${wf}: ${e.message}`);
      results.push({ workflow: wf, error: e.message });
    }
    // Small delay between workflows
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  for (const r of results) {
    const name = r.workflow.split('/').pop();
    if (r.result) {
      const { passed, failed, total, recording } = r.result;
      console.log(`${name}: ${passed}/${total} passed, ${failed} failed, recording: ${recording || 'none'}`);
    } else {
      console.log(`${name}: ERROR - ${r.error}`);
    }
  }
}

main().catch(console.error);