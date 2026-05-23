import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { homedir } from 'os';

export interface WorkflowStep {
  tool: string;
  args: Record<string, unknown>;
  expect?: Record<string, string>;
}

export interface ObservedEvent {
  type: 'console_error' | 'js_exception' | 'network_error' | 'console_warn';
  timestamp: string;
  message: string;
  url?: string;
  status?: number;
}

export interface WorkflowResult {
  id: string;
  sessionId: string;
  name: string;
  description?: string;
  group?: string[];
  stopOnFail: boolean;
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  passed: number;
  failed: number;
  total: number;
  reportPath?: string;
  observations?: ObservedEvent[];
  recording?: string; // path to video file
}

export interface AssertionResult {
  condition: string;
  passed: boolean;
  detail: string;
}

export interface StepResult {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  status: 'passed' | 'failed';
  error?: string;
  result?: string;
  assertions?: AssertionResult[];
  logs?: string[];
  duration: number;
  screenshot?: string; // base64 PNG or path
  screenshotPath?: string; // file path to screenshot
  observations?: ObservedEvent[];
}

export interface WorkflowManifest {
  results: WorkflowResult[];
  updatedAt: string;
}

type SendToExtension = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const STEP_MAP: Record<string, string> = {
  navigate: 'NAVIGATE',
  smart_click: 'SMART_CLICK',
  smart_type: 'SMART_TYPE',
  smart_fill: 'SMART_FILL',
  smart_hover: 'SMART_HOVER',
  smart_focus: 'SMART_FOCUS',
  smart_select_option: 'SMART_SELECT_OPTION',
  smart_check: 'SMART_CHECK',
  smart_uncheck: 'SMART_UNCHECK',
  click: 'CLICK',
  type: 'TYPE',
  fill: 'FILL',
  hover: 'HOVER',
  press_enter: 'PRESS_ENTER',
  press_key: 'PRESS_KEY',
  check: 'CHECK',
  uncheck: 'UNCHECK',
  select_option: 'SELECT_OPTION',
  wait: 'WAIT',
  expect: 'ASSERT',
};

const TARGET_TOOLS = new Set([
  'SMART_CLICK', 'SMART_TYPE', 'SMART_FILL', 'SMART_HOVER',
  'SMART_FOCUS', 'SMART_SELECT_OPTION', 'SMART_CHECK', 'SMART_UNCHECK',
]);

function parseStep(raw: Record<string, unknown>): WorkflowStep {
  const keys = Object.keys(raw);
  const expectValue = raw.expect;
  const toolKeys = keys.filter(k => k !== 'expect');

  if (toolKeys.length !== 1) {
    if (keys.length === 1 && keys[0] === 'expect') {
      // Standalone expect step: { expect: { ... } }
      const conditions = typeof expectValue === 'object' && expectValue !== null ? expectValue as Record<string, string> : {};
      return { tool: 'expect', args: { conditions }, expect: conditions };
    }
    throw new Error(`Each step must have exactly one tool key (plus optional "expect"), got: ${keys.join(', ')}`);
  }

  const tool = toolKeys[0];
  const value = raw[tool];
  const expectConditions = (typeof expectValue === 'object' && expectValue !== null) ? expectValue as Record<string, string> : undefined;

  if (tool === 'wait') {
    const ms = typeof value === 'number' ? value : parseInt(String(value), 10);
    return { tool: 'wait', args: { ms }, expect: expectConditions };
  }

  if (tool === 'expect') {
    const conditions = typeof value === 'object' && value !== null ? value as Record<string, string> : {};
    return { tool: 'expect', args: { conditions }, expect: conditions };
  }

  const command = STEP_MAP[tool];
  if (!command) {
    throw new Error(`Unknown step tool: "${tool}". Available: ${Object.keys(STEP_MAP).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (command === 'NAVIGATE') return { tool, args: { url: value }, expect: expectConditions };
    if (TARGET_TOOLS.has(command)) return { tool, args: { target: value }, expect: expectConditions };
    return { tool, args: { selector: value }, expect: expectConditions };
  }

  if (typeof value === 'object' && value !== null) {
    return { tool, args: value as Record<string, unknown>, expect: expectConditions };
  }

  throw new Error(`Invalid step value for "${tool}": expected string or object`);
}

export function parseWorkflow(yamlContent: string): { name: string; description?: string; group?: string[]; stopOnFail: boolean; steps: WorkflowStep[] } {
  const parsed = yaml.load(yamlContent) as any;
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('Workflow must have a "steps" array');
  }
  const name = parsed.name || 'Untitled';
  const description = parsed.description || undefined;
  const group = Array.isArray(parsed.group)
    ? parsed.group.map(String)
    : typeof parsed.group === 'string'
      ? parsed.group.split('/').map((s: string) => s.trim()).filter(Boolean)
      : undefined;
  const stopOnFail = parsed.stopOnFail !== false;
  const steps = parsed.steps.map((s: Record<string, unknown>) => parseStep(s));
  return { name, description, group, stopOnFail, steps };
}

function getWorkflowDir(): string {
  return join(homedir(), '.smartwriter', 'workflows');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function saveScreenshot(dir: string, stepNum: number, tool: string, data: string): string {
  const filename = `step-${stepNum}-${sanitizeName(tool)}.png`;
  const filepath = join(dir, filename);
  const buffer = Buffer.from(data, 'base64');
  writeFileSync(filepath, buffer);
  return filename;
}

function loadManifest(dir: string): WorkflowManifest {
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return { results: [], updatedAt: new Date().toISOString() };
    }
  }
  return { results: [], updatedAt: new Date().toISOString() };
}

function saveManifest(dir: string, manifest: WorkflowManifest): void {
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

export async function runWorkflow(
  yamlSource: { path?: string; yaml?: string },
  sendToExtension: SendToExtension,
  onStepComplete?: (stepResult: StepResult, stepIndex: number, totalSteps: number) => void
): Promise<WorkflowResult> {
  let yamlContent: string;
  if (yamlSource.path) {
    yamlContent = readFileSync(resolve(yamlSource.path), 'utf-8');
  } else if (yamlSource.yaml) {
    yamlContent = yamlSource.yaml;
  } else {
    throw new Error('Provide either "path" or "yaml" parameter');
  }

  const { name, description, group, stopOnFail, steps } = parseWorkflow(yamlContent);
  const sessionId = (yamlSource as any)?.sessionId || crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const results: StepResult[] = [];
  let passed = 0;
  let failed = 0;

  // Get connected tab origin for resolving relative URLs
  let tabOrigin = '';
  try {
    const tabInfo = await sendToExtension('GET_CONNECTED_TAB_INFO', {}) as { url?: string };
    if (tabInfo.url) {
      const u = new URL(tabInfo.url);
      tabOrigin = u.origin;
    }
  } catch { /* no connected tab info */ }

  // Resolve relative navigate URLs against connected tab origin
  // Supports: /test (relative path) → http://localhost:9225/test
  //           localhost:9225/test (domain only, no protocol) → http://localhost:9225/test
  for (const step of steps) {
    if (step.tool === 'navigate' && step.args.url && typeof step.args.url === 'string') {
      const url = step.args.url;
      if (url.startsWith('/')) {
        step.args.url = tabOrigin + url;
      } else if (!url.startsWith('http://') && !url.startsWith('https://') && url.includes('/')) {
        // Looks like "domain/path" without protocol — prepend http://
        step.args.url = 'http://' + url;
      }
    }
  }

  // Fetch workflow settings from extension
  let screenshotEnabled = true;
  let recordingEnabled = true;
  try {
    const settings = await sendToExtension('GET_WORKFLOW_SETTINGS', {}) as { screenshot?: boolean; recording?: boolean };
    screenshotEnabled = settings.screenshot !== false;
    recordingEnabled = settings.recording !== false;
  } catch { /* defaults */ }

  // Start observation (console errors, network errors, JS exceptions)
  let observing = false;
  try {
    await sendToExtension('START_OBSERVE', {});
    observing = true;
  } catch { /* best-effort */ }

  // Start video recording
  let recordingPath: string | undefined;
  if (recordingEnabled) {
    try {
      await sendToExtension('START_RECORDING', {});
    } catch { /* best-effort */ }
  }

  // Create workflow result directory
  const dir = getWorkflowDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = sanitizeName(name);
  const runDir = join(dir, `${slug}_${ts}`);
  mkdirSync(runDir, { recursive: true });

  // Track last reported step index for streaming callback
  let lastReportedIndex = -1;
  const reportSteps = async () => {
    if (!onStepComplete) return;
    for (let j = lastReportedIndex + 1; j < results.length; j++) {
      onStepComplete(results[j], j, steps.length);
      // Yield to event loop so SSE events are flushed individually
      await new Promise(r => setTimeout(r, 30));
    }
    lastReportedIndex = results.length - 1;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();
    const stepLogs: string[] = [];
    stepLogs.push(`[${new Date().toISOString()}] Starting: ${step.tool} ${JSON.stringify(step.args)}${step.expect ? ` expect: ${JSON.stringify(step.expect)}` : ''}`);

    try {
      if (step.tool === 'wait') {
        const ms = (step.args.ms as number) || 1000;
        stepLogs.push(`Waiting ${ms}ms...`);
        await new Promise<void>((r) => setTimeout(r, ms));
        stepLogs.push(`Wait complete`);

        // Evaluate expect after wait
        if (step.expect) {
          stepLogs.push(`Evaluating expect conditions...`);
          let waitAssertions: AssertionResult[] | undefined;
          try {
            const assertResult = await sendToExtension('ASSERT', { conditions: step.expect }) as { passed: boolean; results?: Array<{ condition: string; passed: boolean; detail: string }> };
            waitAssertions = assertResult.results;
            if (assertResult.results) {
              for (const r of assertResult.results) {
                stepLogs.push(`  ${r.passed ? '✓' : '✗'} ${r.condition}: ${r.detail}`);
              }
            }
          } catch (assertErr) {
            const assertMsg = assertErr instanceof Error ? assertErr.message : String(assertErr);
            stepLogs.push(`Assertion failed: ${assertMsg}`);
            const failAssertions: AssertionResult[] = Object.entries(step.expect || {}).map(([cond, detail]) => ({
              condition: cond, passed: false, detail: assertMsg,
            }));
            const duration = Date.now() - stepStart;
            results.push({
              step: i + 1, tool: 'wait', args: step.args, status: 'failed',
              duration, error: `Assertion failed: ${assertMsg}`,
              logs: stepLogs, assertions: failAssertions,
            });
            failed++;
            if (stopOnFail) break;
            await reportSteps();
            continue;
          }
          const allPassed = !waitAssertions?.some(r => !r.passed);
          results.push({ step: i + 1, tool: 'wait', args: step.args, status: allPassed ? 'passed' : 'failed', duration: ms, result: `waited ${ms}ms`, assertions: waitAssertions, logs: stepLogs, ...(allPassed ? {} : { error: `Assertion failed: ${waitAssertions?.filter(r => !r.passed).map(r => r.detail).join('; ') || 'some conditions not met'}` }) });
          if (allPassed) { passed++; } else { failed++; if (stopOnFail) break; }
        } else {
          results.push({ step: i + 1, tool: 'wait', args: step.args, status: 'passed', duration: ms, result: `waited ${ms}ms`, logs: stepLogs });
          passed++;
        }
        await reportSteps();
        continue;
      }

      if (step.tool === 'expect') {
        // Standalone expect step - just evaluate conditions
        const conditions = (step.args.conditions as Record<string, string>) || step.expect || {};
        stepLogs.push(`Evaluating expect conditions: ${JSON.stringify(conditions)}`);
        try {
          const assertResult = await sendToExtension('ASSERT', { conditions }) as { passed: boolean; results?: Array<{ condition: string; passed: boolean; detail: string }> };
          if (assertResult.results) {
            for (const r of assertResult.results) {
              stepLogs.push(`  ${r.passed ? '✓' : '✗'} ${r.condition}: ${r.detail}`);
            }
          }
          const allPassed = assertResult.passed !== false && !(assertResult.results?.some(r => !r.passed));
          const duration = Date.now() - stepStart;
          results.push({
            step: i + 1, tool: 'expect', args: { conditions }, status: allPassed ? 'passed' : 'failed',
            duration, result: JSON.stringify(assertResult.results || []), logs: stepLogs,
            assertions: assertResult.results,
            ...(allPassed ? {} : { error: `Assertion failed: ${assertResult.results?.filter(r => !r.passed).map(r => r.detail).join('; ') || 'some conditions not met'}` }),
          });
          if (allPassed) { passed++; } else { failed++; if (stopOnFail) break; }
        } catch (assertErr) {
          const assertMsg = assertErr instanceof Error ? assertErr.message : String(assertErr);
          stepLogs.push(`Assertion failed: ${assertMsg}`);
          // Create assertion results from conditions even on failure
          const failAssertions: AssertionResult[] = Object.entries(conditions).map(([cond, detail]) => ({
            condition: cond, passed: false, detail: assertMsg,
          }));
          const duration = Date.now() - stepStart;
          results.push({
            step: i + 1, tool: 'expect', args: { conditions }, status: 'failed',
            duration, error: assertMsg, logs: stepLogs,
            assertions: failAssertions,
          });
          failed++;
          if (stopOnFail) break;
        }
        await reportSteps();
        continue;
      }

      const command = STEP_MAP[step.tool];
      if (!command) throw new Error(`Unknown tool: ${step.tool}`);

      stepLogs.push(`Sending command: ${command}`);
      const result = await sendToExtension(command, step.args);
      const duration = Date.now() - stepStart;
      stepLogs.push(`Command completed in ${duration}ms`);
      if (typeof result === 'object' && result !== null) {
        stepLogs.push(`Result: ${JSON.stringify(result)}`);
      } else if (typeof result === 'string') {
        stepLogs.push(`Result: ${result}`);
      }

      // Capture step-level observations
      let stepObservations: ObservedEvent[] | undefined;
      if (observing) {
        try {
          const obsResult = await sendToExtension('FLUSH_OBSERVE', {}) as { events?: ObservedEvent[] };
          stepObservations = obsResult?.events;
          if (stepObservations?.length) {
            stepLogs.push(`${stepObservations.length} observation(s) captured`);
          }
        } catch { /* best-effort */ }
      }

      // Highlight target before screenshot (for tools that target an element)
      const isTargetTool = TARGET_TOOLS.has(command) || ['CLICK', 'TYPE', 'FILL', 'HOVER', 'SELECT', 'CHECK', 'UNCHECK', 'PRESS_KEY', 'PRESS_ENTER'].includes(command);
      if (isTargetTool && screenshotEnabled) {
        try {
          const highlightArgs: Record<string, unknown> = {};
          if (step.args.selector) highlightArgs.selector = step.args.selector;
          if (step.args.elementRef) highlightArgs.elementRef = step.args.elementRef;
          if (step.args.target) {
            // For SMART_* tools, resolve the target first — highlight uses CSS selector or elementRef
            // We'll send target as selector for now, the content script's getElement will resolve it
            highlightArgs.selector = step.args.target;
          }
          await sendToExtension('HIGHLIGHT_TARGET', highlightArgs);
          await new Promise<void>((r) => setTimeout(r, 100)); // Brief pause for highlight to render
        } catch { /* best-effort — highlight not critical */ }
      }

      // Capture screenshot
      let screenshot: string | undefined;
      let screenshotPath: string | undefined;
      if (screenshotEnabled) {
        try {
          const ssResult = await sendToExtension('SCREENSHOT_STEP', {}) as { screenshot?: string; error?: string };
          if (ssResult?.screenshot) {
            screenshotPath = saveScreenshot(runDir, i + 1, step.tool, ssResult.screenshot);
            screenshot = ssResult.screenshot;
            stepLogs.push(`Screenshot saved: ${screenshotPath}`);
          }
        } catch { /* best-effort */ }
      }

      // Remove highlight after screenshot
      if (isTargetTool && screenshotEnabled) {
        try {
          await sendToExtension('REMOVE_HIGHLIGHT', {});
        } catch { /* best-effort */ }
      }

      // Evaluate expect conditions after successful step
      let expectError: string | undefined;
      let stepAssertions: AssertionResult[] | undefined;
      if (step.expect) {
        stepLogs.push(`Evaluating expect conditions: ${JSON.stringify(step.expect)}`);
        try {
          const assertResult = await sendToExtension('ASSERT', { conditions: step.expect }) as { passed: boolean; results?: Array<{ condition: string; passed: boolean; detail: string }> };
          stepAssertions = assertResult.results;
          if (assertResult.results) {
            for (const r of assertResult.results) {
              stepLogs.push(`  ${r.passed ? '✓' : '✗'} ${r.condition}: ${r.detail}`);
            }
          }
        } catch (assertErr) {
          expectError = assertErr instanceof Error ? assertErr.message : String(assertErr);
          stepLogs.push(`Assertion failed: ${expectError}`);
          // Create assertion results from conditions even on failure
          stepAssertions = Object.entries(step.expect || {}).map(([cond, detail]) => ({
            condition: cond, passed: false, detail: expectError,
          }));
        }
      }

      if (expectError) {
        results.push({
          step: i + 1, tool: step.tool, args: step.args, status: 'failed',
          duration: Date.now() - stepStart, error: expectError,
          screenshot, screenshotPath, observations: stepObservations?.length ? stepObservations : undefined,
          assertions: stepAssertions, logs: stepLogs,
        });
        failed++;
        if (stopOnFail) break;
      } else {
        // Check if any assertions failed
        const assertionsFailed = stepAssertions?.some(r => !r.passed);
        results.push({
          step: i + 1, tool: step.tool, args: step.args, status: assertionsFailed ? 'failed' : 'passed',
          duration, result: typeof result === 'string' ? result : JSON.stringify(result),
          screenshot, screenshotPath, observations: stepObservations?.length ? stepObservations : undefined,
          assertions: stepAssertions, logs: stepLogs,
          ...(assertionsFailed ? { error: `Assertion failed: ${stepAssertions?.filter(r => !r.passed).map(r => r.detail).join('; ') || 'some conditions not met'}` } : {}),
        });
        if (assertionsFailed) { failed++; if (stopOnFail) break; } else { passed++; }
      }
    } catch (error: unknown) {
      const duration = Date.now() - stepStart;
      const message = error instanceof Error ? error.message : String(error);
      stepLogs.push(`ERROR: ${message}`);

      let stepObservations: ObservedEvent[] | undefined;
      if (observing) {
        try {
          const obsResult = await sendToExtension('FLUSH_OBSERVE', {}) as { events?: ObservedEvent[] };
          stepObservations = obsResult?.events;
        } catch { /* best-effort */ }
      }

      let screenshot: string | undefined;
      let screenshotPath: string | undefined;
      if (screenshotEnabled) {
        try {
          const ssResult = await sendToExtension('SCREENSHOT_STEP', {}) as { screenshot?: string; error?: string };
          if (ssResult?.screenshot) {
            screenshotPath = saveScreenshot(runDir, i + 1, step.tool, ssResult.screenshot);
            screenshot = ssResult.screenshot;
            stepLogs.push(`Error screenshot saved: ${screenshotPath}`);
          }
        } catch { /* best-effort */ }
      }

      results.push({
        step: i + 1, tool: step.tool, args: step.args, status: 'failed',
        duration, error: message, screenshot, screenshotPath,
        observations: stepObservations?.length ? stepObservations : undefined,
        logs: stepLogs,
      });
      failed++;
      if (stopOnFail) break;
    }

    // Ensure highlight is always removed after each step
    try {
      await sendToExtension('REMOVE_HIGHLIGHT', {});
    } catch { /* best-effort */ }

    // Report all new steps for streaming
    await reportSteps();
  }

  // Stop observation
  let allObservations: ObservedEvent[] = [];
  if (observing) {
    try {
      const obsResult = await sendToExtension('STOP_OBSERVE', {}) as { events?: ObservedEvent[] };
      allObservations = obsResult?.events || [];
    } catch { /* best-effort */ }
  }

  // Stop recording
  if (recordingEnabled) {
    try {
      const recResult = await sendToExtension('STOP_RECORDING', {}) as { frames?: string[]; webm?: string; error?: string };
      if (recResult?.webm) {
        // Direct webm recording from MediaRecorder (no ffmpeg needed)
        const videoPath = join(runDir, 'recording.webm');
        writeFileSync(videoPath, Buffer.from(recResult.webm, 'base64'));
        recordingPath = 'recording.webm';
        console.log(`[workflow] Recording saved as webm (${(Buffer.from(recResult.webm, 'base64').length / 1024).toFixed(1)}KB)`);
      } else if (recResult?.frames?.length) {
        // Fallback: save raw frames and use ffmpeg
        const framesDir = join(runDir, 'frames');
        mkdirSync(framesDir, { recursive: true });
        for (let f = 0; f < recResult.frames.length; f++) {
          writeFileSync(join(framesDir, `frame-${String(f).padStart(5, '0')}.png`), Buffer.from(recResult.frames[f], 'base64'));
        }
        const videoPath = join(runDir, 'recording.webm');
        recordingPath = 'frames/';
        spawnRecordingMerge(framesDir, videoPath, resultPath);
      }
    } catch { /* best-effort */ }
  }

  const finishedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const workflowResult: WorkflowResult = {
    id, sessionId, name, description, group, stopOnFail, startedAt, finishedAt, steps: results, passed, failed, total: steps.length,
    observations: allObservations.length ? allObservations : undefined,
    recording: recordingPath,
  };

  // Save result JSON (with base64 screenshots for full detail)
  const resultPath = join(runDir, 'result.json');
  writeFileSync(resultPath, JSON.stringify(workflowResult, null, 2), 'utf-8');
  workflowResult.reportPath = resultPath;

  // For manifest/dashboard: strip base64 screenshots (too large to embed in HTML)
  // Keep screenshotPath so dashboard can load images from files
  const manifestResult: WorkflowResult = {
    ...workflowResult,
    steps: workflowResult.steps.map(s => ({
      ...s,
      screenshot: s.screenshotPath ? undefined : s.screenshot,
    })),
    reportPath: resultPath,
  };

  // Update manifest
  const manifest = loadManifest(dir);
  manifest.results.push(manifestResult);
  saveManifest(dir, manifest);

  // Regenerate dashboard
  rebuildDashboard();

  return workflowResult;
}

export function formatReport(result: WorkflowResult): string {
  const lines: string[] = [];
  lines.push(`Workflow: ${result.name}`);
  if (result.description) lines.push(`Description: ${result.description}`);
  if (result.group?.length) lines.push(`Group: ${result.group.join(' / ')}`);
  lines.push(`STOP ON FAILURE: ${result.stopOnFail ? 'ENABLED' : 'DISABLED'}`);
  // Expect first - show each test case
  const allAssertions = result.steps.flatMap(s => s.assertions || []);
  if (allAssertions.length > 0) {
    const expectPassed = allAssertions.filter(a => a.passed).length;
    const expectFailedCount = allAssertions.length - expectPassed;
    lines.push(`Expect: ${expectFailedCount > 0 ? 'FAILED' : 'PASSED'}: ${expectPassed}/${allAssertions.length}`);
    for (const a of allAssertions) {
      lines.push(`  ${a.passed ? '✓' : '✗'} [${a.condition}] ${a.detail}`);
    }
  }
  // Tool Call second
  const ran = result.steps.length;
  const toolFailed = ran - result.passed;
  lines.push(`Tool Call: ${toolFailed > 0 ? 'FAILED' : 'PASSED'}: ${result.passed}/${ran}`);
  lines.push(`Time: ${result.startedAt} → ${result.finishedAt}`);
  if (result.reportPath) lines.push(`Report: ${result.reportPath}`);
  if (result.recording) lines.push(`Recording: ${result.recording}`);
  lines.push('');

  for (const step of result.steps) {
    const icon = step.status === 'passed' ? '✅' : '❌';
    const label = step.tool === 'wait'
      ? `wait ${step.args.ms}ms`
      : step.tool === 'navigate'
        ? `navigate → ${step.args.url || ''}`
        : step.tool === 'expect'
          ? `expect ${JSON.stringify(step.args.conditions || step.expect || {})}`
          : TARGET_TOOLS.has(STEP_MAP[step.tool] || '') || step.tool.startsWith('smart_')
            ? `${step.tool} → ${step.args.target || step.args.selector || ''}`
            : `${step.tool} → ${step.args.selector || JSON.stringify(step.args)}`;

    lines.push(`  ${icon} Step ${step.step}: ${label} (${step.duration}ms)`);
    if (step.error) lines.push(`     Error: ${step.error}`);
    if (step.result && step.tool !== 'expect') lines.push(`     Result: ${step.result}`);
    if (step.assertions?.length) {
      lines.push(`     Expect:`);
      for (const a of step.assertions) {
        lines.push(`       ${a.passed ? '✓' : '✗'} ${a.condition}: ${a.detail}`);
      }
    }
    if (step.screenshotPath) lines.push(`     Screenshot: ${step.screenshotPath}`);
    if (step.observations?.length) {
      for (const obs of step.observations) {
        lines.push(`     [${obs.type}] ${obs.message}${obs.status ? ` (${obs.status})` : ''}${obs.url ? ` ${obs.url}` : ''}`);
      }
    }
  }

  if (result.failed > 0) {
    lines.push('');
    lines.push(`⚠️  Workflow stopped at step ${result.steps[result.steps.length - 1]?.step} due to error`);
  }

  if (result.observations?.length) {
    lines.push('');
    lines.push(`Observations (${result.observations.length}):`);
    for (const obs of result.observations) {
      lines.push(`  [${obs.type}] ${obs.message}${obs.status ? ` (${obs.status})` : ''}${obs.url ? ` ${obs.url}` : ''}`);
    }
  }

  lines.push('');
  lines.push(`Dashboard: ${join(getWorkflowDir(), 'index.html')}`);

  return lines.join('\n');
}

// ==================== DASHBOARD REBUILD ====================

function rebuildDashboard(): void {
  try {
    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rebuild-dashboard.mjs');
    execSync(`node "${scriptPath}"`, { encoding: 'utf-8', timeout: 10000 });
  } catch (e) {
    console.error('[workflow] Failed to rebuild dashboard:', e instanceof Error ? e.message : String(e));
  }
}

function spawnRecordingMerge(framesDir: string, videoPath: string, resultPath: string): void {
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-framerate', '10',
    '-i', join(framesDir, 'frame-%05d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuv420p',
    '-b:v', '1M',
    '-an',
    videoPath,
  ], { stdio: 'pipe' });

  const stderr: string[] = [];
  ffmpeg.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));

  const timer = setTimeout(() => {
    ffmpeg.kill();
    console.error('[workflow] ffmpeg recording timed out after 60s');
  }, 60000);

  ffmpeg.on('close', (code: number) => {
    clearTimeout(timer);
    if (code === 0) {
      try {
        const raw = readFileSync(resultPath, 'utf-8');
        const result = JSON.parse(raw);
        result.recording = 'recording.webm';
        writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');
        // Regenerate dashboard to reflect video
        rebuildDashboard();
        console.log('[workflow] recording.webm created and result.json updated');
      } catch (e) {
        console.error('[workflow] failed to update result.json:', e instanceof Error ? e.message : String(e));
      }
    } else {
      console.error(`[workflow] ffmpeg exited with code ${code}: ${stderr.join('').slice(-200)}`);
    }
  });

  ffmpeg.on('error', (err: Error) => {
    clearTimeout(timer);
    console.error('[workflow] ffmpeg spawn error:', err.message);
  });
}

// ==================== DELETE FUNCTIONS ====================

export function deleteWorkflowResult(id: string): boolean {
  const dir = getWorkflowDir();
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(dir, entry.name, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(resultPath, 'utf-8'));
      if (raw.id === id) {
        rmSync(join(dir, entry.name), { recursive: true, force: true });
        return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

export function deleteWorkflowGroup(groupPath: string[]): number {
  const dir = getWorkflowDir();
  const entries = readdirSync(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(dir, entry.name, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(resultPath, 'utf-8'));
      const rGroup = raw.group || [];
      if (rGroup.length === groupPath.length && rGroup.every((g: string, i: number) => g === groupPath[i])) {
        rmSync(join(dir, entry.name), { recursive: true, force: true });
        count++;
      }
    } catch { /* skip */ }
  }
  return count;
}

export function deleteWorkflowSession(sessionId: string): number {
  const dir = getWorkflowDir();
  const entries = readdirSync(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(dir, entry.name, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(resultPath, 'utf-8'));
      if (raw.sessionId === sessionId) {
        rmSync(join(dir, entry.name), { recursive: true, force: true });
        count++;
      }
    } catch { /* skip */ }
  }
  return count;
}