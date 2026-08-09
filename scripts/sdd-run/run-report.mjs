#!/usr/bin/env node
// Track 1 thin run-report renderer for /sdd-auto-impl (interactive path).
//
// Reads a feature's runs.jsonl (one task-result record per line, written by
// append-run.mjs) and renders a markdown table for the §5 final report.
//
// NO cost/turn/model columns — interactive mode has no per-subagent telemetry
// (see append-run.mjs header). Those columns only appear in the Track 2 headless
// renderer, which consumes `claude -p` result events.
//
// Usage:  node scripts/sdd-run/run-report.mjs <runs.jsonl path>
import { existsSync, readFileSync } from 'node:fs';

const inPath = process.argv[2];
if (!inPath) {
  console.error('usage: run-report.mjs <runs.jsonl path>');
  process.exit(2);
}
if (!existsSync(inPath)) {
  console.error(`run-report: no runs.jsonl at ${inPath} (no tasks recorded this run)`);
  process.exit(1);
}

const records = readFileSync(inPath, 'utf-8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      console.error(`run-report: skipping malformed line ${i + 1} — ${err.message}`);
      return null;
    }
  })
  .filter(Boolean);

console.log(renderReport(records));

/** Escape `|` so cell content never breaks the markdown table. */
function cell(s) {
  return String(s ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ');
}

/** Last-segment note: blocked → stop-signal title+detail; else free notes. */
function noteOf(r) {
  if (r.status === 'blocked' && r.stop_signal) {
    const { title, detail } = r.stop_signal;
    return [title, detail].filter(Boolean).join(' — ');
  }
  return r.notes ?? '';
}

function renderReport(records) {
  if (records.length === 0) return '_(no tasks recorded this run)_';

  const lines = [];
  lines.push('| Task | Status | Commit | Files | Tests | Notes / Blocked |');
  lines.push('|---|:---:|---|---:|---|---|');
  for (const r of records) {
    const status = r.status === 'done' ? '✅' : r.status === 'blocked' ? '⛔' : cell(r.status);
    const commit = r.commit_sha ? `\`${String(r.commit_sha).slice(0, 7)}\`` : '—';
    const files = Array.isArray(r.files_changed) ? r.files_changed.length : '—';
    lines.push(
      `| ${cell(r.task_id)} | ${status} | ${commit} | ${files} | ${cell(r.test_summary)} | ${cell(noteOf(r))} |`,
    );
  }

  const done = records.filter((r) => r.status === 'done').length;
  const blocked = records.filter((r) => r.status === 'blocked').length;
  lines.push('');
  lines.push(`**Tasks**: ${records.length} (done=${done}, blocked=${blocked})`);
  const blockedRows = records.filter((r) => r.status === 'blocked');
  if (blockedRows.length > 0) {
    lines.push('');
    lines.push('**待决策 (blocked)**:');
    for (const r of blockedRows) lines.push(`- \`${r.task_id}\` — ${noteOf(r)}`);
  }
  return lines.join('\n');
}
