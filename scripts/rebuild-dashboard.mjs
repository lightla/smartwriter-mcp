#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const WF_DIR = join(homedir(), '.smartwriter', 'workflows');

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

async function loadResults() {
  const entries = readdirSync(WF_DIR, { withFileTypes: true });
  const results = [];
  const { randomUUID } = await import('crypto');
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(WF_DIR, entry.name, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(resultPath, 'utf-8'));
      // Generate stable UUID for results that don't have one
      if (!raw.id) {
        raw.id = randomUUID();
        writeFileSync(resultPath, JSON.stringify(raw, null, 2), 'utf-8');
      }
      // Strip base64 screenshots from manifest copy
      const manifestResult = {
        ...raw,
        steps: raw.steps.map(s => ({
          ...s,
          screenshot: s.screenshotPath ? undefined : s.screenshot,
        })),
        reportPath: resultPath,
      };
      results.push(manifestResult);
    } catch (e) {
      console.error(`Error reading ${entry.name}:`, e.message);
    }
  }
  // Sort by startedAt
  results.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  return results;
}

function buildGroupTree(results) {
  const root = { name: 'All', children: [], results: [] };
  for (const r of results) {
    if (!r.group?.length) {
      root.results.push(r);
      continue;
    }
    let current = root;
    for (const part of r.group) {
      let child = current.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, children: [], results: [] };
        current.children.push(child);
      }
      current = child;
    }
    current.results.push(r);
  }
  return root;
}

function renderSidebar(node, depth = 0, groupPath = []) {
  const indent = depth * 16;
  const hasChildren = node.children.length > 0 || node.results.length > 0;
  let html = '';

  if (depth > 0) {
    const childCount = node.results.length;
    const failedCount = node.results.filter(r => r.failed > 0).length;
    const statusIcon = failedCount > 0 ? '&#10060;' : childCount > 0 ? '&#9989;' : '';
    const fullPath = [...groupPath, node.name].join('/');
    html += `<div class="group-item" style="padding-left:${indent}px" data-group-path="${fullPath}">
      <span class="group-toggle">${hasChildren ? '&#9660;' : ''}</span>
      <span class="group-icon">${statusIcon}</span>
      <span class="group-name">${node.name}</span>
      <span class="group-count">${childCount}</span>
      <button class="delete-btn delete-group-btn" data-group-path="${fullPath}" title="Delete group" onclick="event.stopPropagation();deleteGroup('${fullPath}')">&#128465;</button>
    </div>`;
  }

  if (hasChildren && depth > 0) {
    html += `<div class="group-children" style="display:block">`;
  }

  for (const child of node.children) {
    html += renderSidebar(child, depth + 1, [...groupPath, node.name]);
  }

  for (const r of node.results) {
    const status = r.failed === 0 ? 'passed' : 'failed';
    const icon = r.failed === 0 ? '&#9989;' : '&#10060;';
    html += `<div class="result-item ${status}" style="padding-left:${indent + 16}px" data-result-id="${r.id}">
      <span class="result-icon">${icon}</span>
      <span class="result-name">${r.name}</span>
      <span class="result-steps">${r.passed}/${r.total}</span>
      <button class="delete-btn delete-result-btn" data-result-id="${r.id}" title="Delete result" onclick="event.stopPropagation();deleteResult('${r.id}')">&#128465;</button>
    </div>`;
  }

  if (hasChildren && depth > 0) {
    html += `</div>`;
  }

  return html;
}

function generateDashboard(results) {
  const tree = buildGroupTree(results);
  const sidebarHtml = renderSidebar(tree, 0, []);

  // Build sessions sidebar
  const sessions = {};
  for (const r of results) {
    const sid = r.sessionId || 'legacy';
    if (!sessions[sid]) sessions[sid] = { id: sid, results: [], startedAt: r.startedAt };
    sessions[sid].results.push(r);
  }
  const sessionList = Object.values(sessions).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  let sessionsHtml = '';
  for (const s of sessionList) {
    const failedCount = s.results.filter(r => r.failed > 0).length;
    const icon = failedCount > 0 ? '&#10060;' : '&#9989;';
    const shortId = s.id.length > 8 ? s.id.substring(0, 8) + '...' : s.id;
    const label = s.id === 'legacy' ? 'Legacy' : shortId;
    const date = new Date(s.startedAt).toLocaleDateString() + ' ' + new Date(s.startedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    sessionsHtml += `<div class="group-item session-item" data-session-id="${s.id}" style="padding-left:16px">
      <span class="group-icon">${icon}</span>
      <span class="group-name">${label}</span>
      <span class="group-count">${s.results.length}</span>
      <button class="delete-btn" onclick="event.stopPropagation();deleteSession('${s.id}')" title="Delete session">&#128465;</button>
    </div>
    <div class="session-children" data-session-children="${s.id}">`;
    for (const r of s.results) {
      const rstatus = r.failed === 0 ? 'passed' : 'failed';
      const ricon = r.failed === 0 ? '&#9989;' : '&#10060;';
      sessionsHtml += `<div class="result-item ${rstatus}" style="padding-left:32px" data-result-id="${r.id}">
        <span class="result-icon">${ricon}</span>
        <span class="result-name">${r.name}</span>
        <span class="result-steps">${r.passed}/${r.total}</span>
        <button class="delete-btn delete-result-btn" data-result-id="${r.id}" title="Delete result" onclick="event.stopPropagation();deleteResult('${r.id}')">&#128465;</button>
      </div>`;
    }
    sessionsHtml += '</div>';
  }

  const resultsJson = JSON.stringify(results);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Smartwriter Workflow Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; }
  .sidebar { width: 300px; background: #1e293b; border-right: 1px solid #334155; overflow-y: auto; flex-shrink: 0; padding: 1rem 0; }
  .sidebar h2 { padding: 0 1rem 0.75rem; font-size: 1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .tab-bar { display: flex; border-bottom: 1px solid #334155; padding: 0 0.5rem; }
  .tab-btn { flex: 1; padding: 0.5rem 0; background: none; border: none; border-bottom: 2px solid transparent; color: #64748b; font-size: 0.8rem; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; }
  .tab-btn.active { color: #3b82f6; border-bottom-color: #3b82f6; }
  .tab-btn:hover { color: #e2e8f0; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .group-item { padding: 0.5rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.4rem; font-size: 0.875rem; border-left: 2px solid transparent; transition: background 0.15s; }
  .group-item:hover { background: #334155; }
  .group-item.active { background: #334155; border-left-color: #3b82f6; }
  .group-toggle { color: #64748b; font-size: 0.7rem; width: 12px; }
  .group-icon { font-size: 0.8rem; }
  .group-name { flex: 1; }
  .group-count { color: #64748b; font-size: 0.75rem; }
  .result-item { padding: 0.4rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; border-left: 2px solid transparent; transition: background 0.15s; }
  .result-item:hover { background: #334155; }
  .result-item.active { background: #334155; border-left-color: #3b82f6; }
  .result-item.failed { border-left-color: #ef4444; }
  .delete-btn { opacity: 0; background: none; border: none; color: #64748b; cursor: pointer; font-size: 0.75rem; padding: 0 0.25rem; transition: opacity 0.15s, color 0.15s; }
  .delete-btn:hover { color: #ef4444; }
  .result-item:hover .delete-btn, .group-item:hover .delete-btn { opacity: 1; }
  .result-icon { font-size: 0.75rem; }
  .result-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-steps { color: #64748b; font-size: 0.7rem; }
  .content { flex: 1; overflow-y: auto; padding: 2rem; }
  .content h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .content .group-path { color: #64748b; font-size: 0.85rem; margin-bottom: 1rem; }
  .summary { display: flex; gap: 1.5rem; margin: 1rem 0 1.5rem; flex-wrap: wrap; }
  .summary .card { background: #1e293b; border-radius: 8px; padding: 0.75rem 1.25rem; }
  .summary .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; }
  .summary .value { font-size: 1.25rem; font-weight: 600; }
  .status-badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 600; }
  .status-badge.passed { background: #22c55e20; color: #22c55e; }
  .status-badge.failed { background: #ef444420; color: #ef4444; }
  .step { background: #1e293b; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
  .step.failed { border-left: 3px solid #ef4444; }
  .step.passed { border-left: 3px solid #22c55e; }
  .step-header { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; cursor: pointer; }
  .step-icon { font-size: 1rem; }
  .step-num { color: #94a3b8; font-size: 0.8rem; }
  .step-label { flex: 1; }
  .step-duration { color: #64748b; font-size: 0.8rem; }
  .step-detail { display: block; margin-top: 0.5rem; }
  .step-detail.open { display: block; }
  .log-line { font-family: monospace; font-size: 0.8rem; color: #94a3b8; padding: 0.15rem 0.5rem; border-left: 2px solid #334155; margin: 0.1rem 0; }
  .log-line.error { border-left-color: #ef4444; color: #fca5a5; }
  .error-box { background: #7f1d1d33; color: #fca5a5; padding: 0.5rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem; margin-top: 0.25rem; }
  .screenshot-container { margin-top: 0.5rem; }
  .screenshot-container img { max-width: 100%; border-radius: 4px; border: 1px solid #334155; }
  .obs-item { padding: 0.25rem 0.5rem; margin: 0.15rem 0; border-radius: 4px; font-size: 0.85rem; }
  .obs-console_error, .obs-js_exception { background: #7f1d1d33; }
  .obs-network_error, .obs-console_warn { background: #78350f33; }
  .obs-type { font-weight: 600; text-transform: uppercase; font-size: 0.7rem; padding: 0.1rem 0.3rem; border-radius: 2px; margin-right: 0.5rem; }
  .obs-url { color: #64748b; font-size: 0.75rem; word-break: break-all; }
  .obs-status { color: #f59e0b; font-weight: 600; }
  .recording { margin-top: 0.5rem; }
  .recording video { max-width: 100%; border-radius: 4px; border: 1px solid #334155; }
  .rec-controls { margin-bottom: 0.5rem; }
  .rec-controls button { background: #3b82f6; color: #fff; border: none; padding: 0.4rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  .rec-controls button:disabled { opacity: 0.5; cursor: not-allowed; }
  #rec-status { color: #94a3b8; font-size: 0.85rem; }
  .empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: #475569; font-size: 1.1rem; }
  .timestamp { color: #475569; font-size: 0.75rem; }
  h2.section-title { margin-top: 1.5rem; font-size: 1rem; color: #f1f5f9; }
</style>
</head>
<body>
<div class="sidebar">
  <div class="nav-links" style="display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #334155;">
    <a href="/home/" style="color:#38bdf8;text-decoration:none;font-size:12px;font-weight:600;">Home</a>
    <a href="/test/" style="color:#94a3b8;text-decoration:none;font-size:12px;font-weight:600;">Sample App</a>
  </div>
  <div class="tab-bar">
    <button class="tab-btn active" onclick="switchTab('groups')">Groups</button>
    <button class="tab-btn" onclick="switchTab('sessions')">Sessions</button>
  </div>
  <div id="tab-groups" class="tab-content active">
    ${sidebarHtml}
  </div>
  <div id="tab-sessions" class="tab-content">
    ${sessionsHtml}
  </div>
</div>
<div class="content" id="content">
  <div class="empty-state">Select a workflow to view details</div>
</div>
<script>
const RESULTS = ${resultsJson};

function findResult(id) {
  return RESULTS.find(r => r.id === id);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getRunDir(r) {
  if (r.reportPath) {
    return r.reportPath.split('/').slice(0, -1).pop();
  }
  // Fallback: derive from name + startedAt
  const name = r.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const ts = r.startedAt.replace(/[:.]/g, '-');
  return name + '_' + ts;
}

function renderResult(r) {
  if (!r) return '<div class="empty-state">Result not found</div>';
  const status = r.failed === 0 ? 'passed' : 'failed';
  const statusText = r.failed === 0 ? 'PASSED' : 'FAILED';
  const duration = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
  const groupPath = r.group ? r.group.join(' / ') : '';
  const runDir = getRunDir(r);

  let stepsHtml = '';
  for (const s of r.steps) {
    const icon = s.status === 'passed' ? '&#10004;' : '&#10008;';
    const iconColor = s.status === 'passed' ? '#22c55e' : '#ef4444';
    const label = s.tool === 'wait' ? 'wait ' + s.args.ms + 'ms'
      : s.tool === 'navigate' ? 'navigate &rarr; ' + esc(s.args.url || '')
      : s.tool === 'expect' ? 'expect ' + JSON.stringify(s.args.conditions || {})
      : s.tool.startsWith('smart_') ? esc(s.tool) + ' &rarr; ' + esc(s.args.target || s.args.selector || '')
      : esc(s.tool) + ' &rarr; ' + esc(s.args.selector || '');

    let detailHtml = '';
    if (s.error) detailHtml += '<div class="error-box">' + esc(s.error) + '</div>';
    if (s.assertions?.length) {
      detailHtml += '<div class="assertions" style="margin-top:0.3rem"><div style="font-size:0.7rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem">Expect</div>';
      for (const a of s.assertions) {
        const aIcon = a.passed ? '&#10004;' : '&#10008;';
        const aColor = a.passed ? '#22c55e' : '#ef4444';
        detailHtml += '<div class="assertion-item" style="padding:0.25rem 0.5rem;border-left:3px solid ' + aColor + ';margin:0.15rem 0;font-size:0.85rem;background:' + (a.passed ? '#22c55e10' : '#ef444410') + ';border-radius:2px"><span style="color:' + aColor + ';font-weight:bold">' + aIcon + '</span> <strong>' + esc(a.condition) + '</strong>: ' + esc(a.detail) + '</div>';
      }
      detailHtml += '</div>';
    }
    if (s.logs?.length) {
      detailHtml += '<div class="logs">';
      for (const l of s.logs) {
        const isErr = l.includes('ERROR') || l.includes('Error');
        detailHtml += '<div class="log-line' + (isErr ? ' error' : '') + '">' + esc(l) + '</div>';
      }
      detailHtml += '</div>';
    }
    if (s.screenshot) {
      detailHtml += '<div class="screenshot-container"><img src="data:image/png;base64,' + s.screenshot + '" /></div>';
    } else if (s.screenshotPath) {
      detailHtml += '<div class="screenshot-container"><img src="' + esc(runDir) + '/' + esc(s.screenshotPath) + '" loading="lazy" /></div>';
    }
    if (s.observations?.length) {
      detailHtml += '<div>';
      for (const o of s.observations) {
        detailHtml += '<div class="obs-item obs-' + o.type + '"><span class="obs-type">' + o.type + '</span> ' + esc(o.message) + (o.url ? ' <span class="obs-url">' + esc(o.url) + '</span>' : '') + (o.status ? ' <span class="obs-status">' + o.status + '</span>' : '') + '</div>';
      }
      detailHtml += '</div>';
    }

    stepsHtml += '<div class="step ' + s.status + '"><div class="step-header" onclick="this.nextElementSibling.classList.toggle(\\'open\\')"><span class="step-icon" style="color:' + iconColor + '">' + icon + '</span><span class="step-num">Step ' + s.step + '</span><span class="step-label">' + label + '</span><span class="step-duration">' + s.duration + 'ms</span></div><div class="step-detail">' + detailHtml + '</div></div>';
  }

  let obsHtml = '';
  if (r.observations?.length) {
    obsHtml = '<h2 class="section-title">Global Observations</h2>';
    for (const o of r.observations) {
      obsHtml += '<div class="obs-item obs-' + o.type + '"><span class="obs-type">' + o.type + '</span> ' + esc(o.message) + (o.url ? ' <span class="obs-url">' + esc(o.url) + '</span>' : '') + (o.status ? ' <span class="obs-status">' + o.status + '</span>' : '') + '</div>';
    }
  }

  // Recording section: video playback
  let recHtml = '';
  if (r.recording) {
    const isVideo = r.recording.endsWith('.webm') || r.recording.endsWith('.mp4');
    if (isVideo) {
      const videoFile = r.recording.split('/').pop();
      recHtml = '<h2 class="section-title">Recording</h2><div class="recording"><video controls style="max-width:100%;border-radius:4px;border:1px solid #334155" src="' + esc(runDir) + '/' + esc(videoFile) + '">Your browser does not support video.</video></div>';
    } else {
      recHtml = '<h2 class="section-title">Recording</h2><div class="recording"><div class="rec-controls"><button onclick="playRecording(\\'' + esc(runDir) + '\\', this)">Play</button> <span id="rec-status">Click Play to view recording</span></div><canvas id="rec-canvas" style="max-width:100%;border-radius:4px;border:1px solid #334155;display:none"></canvas></div>';
    }
  }

  // Collect all assertions across steps
  let allAssertions = [];
  for (const s of r.steps) {
    if (s.assertions) allAssertions = allAssertions.concat(s.assertions);
  }
  // STOP ON FAILURE card
  const stopOnFail = r.stopOnFail !== false;
  const stopBadge = stopOnFail ? 'passed' : 'failed';
  const stopText = stopOnFail ? 'ENABLED' : 'DISABLED';
  let stopHtml = '<div class="card"><div class="label">Stop on Failure</div><div class="value"><span class="status-badge ' + stopBadge + '">' + stopText + '</span></div></div>';
  // Test Cases card (first) with detailed list
  let expectHtml = '';
  if (allAssertions.length > 0) {
    const expectPassed = allAssertions.filter(a => a.passed).length;
    const expectFailedCount = allAssertions.length - expectPassed;
    const expectBadge = expectFailedCount > 0 ? 'failed' : 'passed';
    const expectText = expectFailedCount > 0 ? 'FAILED' : 'PASSED';
    let expectDetail = expectPassed + '/' + allAssertions.length;
    let testCaseList = '<div style="margin-top:0.5rem;font-size:0.8rem;color:#94a3b8">';
    for (const a of allAssertions) {
      const aColor = a.passed ? '#22c55e' : '#ef4444';
      const aIcon = a.passed ? '&#10004;' : '&#10008;';
      testCaseList += '<div style="padding:0.15rem 0"><span style="color:' + aColor + '">' + aIcon + '</span> [' + esc(a.condition) + '] ' + esc(a.detail) + '</div>';
    }
    testCaseList += '</div>';
    expectHtml = '<div class="card"><div class="label">Test Cases</div><div class="value"><span class="status-badge ' + expectBadge + '">' + expectText + '</span> <span style="font-size:0.8rem;color:#94a3b8">' + expectDetail + '</span>' + testCaseList + '</div></div>';
  }
  // Tool Call card (second)
  const ran = r.steps.length;
  const toolFailed = ran - r.passed;
  let toolBadge = toolFailed > 0 ? 'failed' : 'passed';
  let toolText = toolFailed > 0 ? 'FAILED' : 'PASSED';
  let toolDetail = r.passed + '/' + ran;

  return '<h1>' + esc(r.name) + '</h1>'
    + (r.description ? '<div style="color:#94a3b8;font-size:0.9rem;margin-bottom:0.5rem">' + esc(r.description) + '</div>' : '')
    + (r.sessionId ? '<div style="color:#475569;font-size:0.75rem;margin-bottom:0.5rem">Session: ' + esc(r.sessionId.substring(0, 8)) + '... <button class="delete-btn" style="opacity:1;font-size:0.7rem;color:#ef4444;background:none;border:none;cursor:pointer;padding:0.1rem 0.3rem;border-radius:2px" onclick="deleteSession(\\\'' + esc(r.sessionId) + '\\\')">Delete Session</button></div>' : '')
    + (groupPath ? '<div class="group-path">' + esc(groupPath) + '</div>' : '')
    + '<div class="summary">' + stopHtml + expectHtml + '<div class="card"><div class="label">Tool Call</div><div class="value"><span class="status-badge ' + toolBadge + '">' + toolText + '</span> <span style="font-size:0.8rem;color:#94a3b8">' + toolDetail + '</span></div></div><div class="card"><div class="label">Duration</div><div class="value">' + duration + 'ms</div></div></div>'
    + '<div class="timestamp">' + esc(r.startedAt) + ' &rarr; ' + esc(r.finishedAt) + '</div>'
    + '<div style="margin-top:1rem">' + stepsHtml + '</div>'
    + obsHtml
    + recHtml;
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector('.tab-btn[onclick*="' + tab + '"]').classList.add('active');
}

document.addEventListener('click', (e) => {
  const item = e.target.closest('.result-item');
  if (item) {
    document.querySelectorAll('.result-item.active').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    const id = item.dataset.resultId;
    const r = findResult(id);
    document.getElementById('content').innerHTML = renderResult(r);
    history.replaceState(null, '', '#' + encodeURIComponent(id));
    return;
  }
  const group = e.target.closest('.group-item');
  if (group) {
    // Toggle session children
    const sessionChildren = group.nextElementSibling;
    if (sessionChildren && sessionChildren.classList.contains('session-children')) {
      const isHidden = sessionChildren.style.display === 'none';
      sessionChildren.style.display = isHidden ? 'block' : 'none';
      return;
    }
    const children = group.nextElementSibling;
    if (children && children.classList.contains('group-children')) {
      const isHidden = children.style.display === 'none';
      children.style.display = isHidden ? 'block' : 'none';
      const toggle = group.querySelector('.group-toggle');
      if (toggle) toggle.textContent = isHidden ? '\\u25BC' : '\\u25B6';
    }
  }
});

// Load from URL hash on page load
(function() {
  const hash = location.hash.slice(1);
  if (hash) {
    const id = decodeURIComponent(hash);
    const r = findResult(id);
    if (r) {
      const item = document.querySelector('.result-item[data-result-id="' + CSS.escape(id) + '"]');
      if (item) {
        document.querySelectorAll('.result-item.active').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        document.getElementById('content').innerHTML = renderResult(r);
      }
    }
  }
})();

async function playRecording(runDir, btn) {
  const statusEl = document.getElementById('rec-status');
  const canvas = document.getElementById('rec-canvas');
  const ctx = canvas.getContext('2d');
  btn.disabled = true;
  statusEl.textContent = 'Loading frames...';
  canvas.style.display = 'block';

  let frames;
  try {
    const res = await fetch(runDir + '/frames/');
    const text = await res.text();
    const matches = text.match(/frame-\\d+\\.png/g);
    if (!matches || matches.length === 0) throw new Error('No frames found');
    frames = matches.sort();
  } catch (e) {
    statusEl.textContent = 'No recording frames found';
    btn.disabled = false;
    return;
  }

  statusEl.textContent = 'Playing ' + frames.length + ' frames...';

  const img = new Image();
  let i = 0;
  function drawFrame() {
    if (i >= frames.length) {
      statusEl.textContent = frames.length + ' frames played';
      btn.disabled = false;
      return;
    }
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      i++;
      setTimeout(drawFrame, 500);
    };
    img.onerror = () => {
      i++;
      drawFrame();
    };
    img.src = runDir + '/frames/' + frames[i];
  }
  drawFrame();
}

async function deleteResult(id) {
  if (!confirm('Delete this result?')) return;
  const res = await fetch('/api/result/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await res.json();
  if (data.deleted) {
    location.reload();
  } else {
    alert('Result not found');
  }
}

async function deleteGroup(groupPath) {
  if (!confirm('Delete all results in group: ' + groupPath + '?')) return;
  const res = await fetch('/api/group/' + encodeURIComponent(groupPath), { method: 'DELETE' });
  const data = await res.json();
  alert('Deleted ' + data.deleted + ' results');
  location.reload();
}

async function deleteSession(sessionId) {
  if (!confirm('Delete all results in this session?')) return;
  const res = await fetch('/api/session/' + encodeURIComponent(sessionId), { method: 'DELETE' });
  const data = await res.json();
  alert('Deleted ' + data.deleted + ' results');
  location.reload();
}
</script>
</body>
</html>`;
}

// Main
(async () => {
console.log('Loading results from', WF_DIR);
const results = await loadResults();
console.log(`Found ${results.length} results`);

// Save manifest
const manifest = { results, updatedAt: new Date().toISOString() };
writeFileSync(join(WF_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
console.log('Saved manifest.json');

// Generate dashboard
const html = generateDashboard(results);
writeFileSync(join(WF_DIR, 'index.html'), html, 'utf-8');
console.log('Saved index.html');

// Calculate total size
const totalSize = Buffer.byteLength(html);
console.log(`Dashboard size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`\nDashboard ready at: ${join(WF_DIR, 'index.html')}`);
})();