#!/usr/bin/env node
// Track 1 thin audit trail for /sdd-auto-impl (interactive path).
//
// Appends ONE task-result record (the subagent's §3 structured JSON, read from
// stdin) as a single line to a feature's runs.jsonl. Reading via stdin avoids
// shell-quoting traps for CJK content in `notes` (macOS bash 3.2 brace/CJK trap,
// per memory reference_macos_bash32_brace_var_before_cjk).
//
// Interactive mode has NO cost/token telemetry — the main agent that spawns a
// subagent only gets its final text back, never usage metrics (Claude Code
// issues #10164 / #22625). So records carry no cost/turn fields by design;
// honest-empty, not fabricated. Real cost columns only exist in the Track 2
// headless path, where `claude -p`'s result event exposes total_cost_usd.
//
// Usage:  node scripts/sdd-run/append-run.mjs <runs.jsonl path>   (JSON on stdin)
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: append-run.mjs <runs.jsonl path>   (task-result JSON on stdin)');
  process.exit(2);
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    console.error(`append-run: invalid JSON on stdin — ${err.message}`);
    process.exit(1);
  }
  // ISO timestamp stamped here (the source-of-truth wall clock for the record).
  obj.ts = new Date().toISOString();
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, JSON.stringify(obj) + '\n');
  console.log(`append-run: +1 record (${obj.task_id ?? '?'} / ${obj.status ?? '?'}) → ${outPath}`);
});
