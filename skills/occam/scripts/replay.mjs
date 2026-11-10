// Runs the REAL delegations of the last N days (read from the transcripts) through the current hook and
// shows what it would have done. Uses a temporary folder as the Claude directory: it touches neither the
// log nor the settings. The occam/config.json of the real directory is copied so the replay uses your config.
// Usage: node replay.mjs [days=9]   (the Claude directory is ~/.claude, or OCCAM_CLAUDE_DIR when set)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DAYS = Number(process.argv[2] || 9);
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks', 'occam.mjs');
const CLAUDE_DIR = process.env.OCCAM_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const root = path.join(CLAUDE_DIR, 'projects');
const since = Date.now() - DAYS * 864e5;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'occam-replay-'));
try {
  fs.mkdirSync(path.join(tmp, 'occam'), { recursive: true });
  fs.copyFileSync(path.join(CLAUDE_DIR, 'occam', 'config.json'), path.join(tmp, 'occam', 'config.json'));
} catch {}

const files = [];
(function walk(d, level) {
  let items = [];
  try {
    items = fs.readdirSync(d, { withFileTypes: true });
  } catch {}
  for (const e of items) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (level < 3) walk(p, level + 1);
    } else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= since) files.push(p);
  }
})(root, 0);

const inputs = [];
for (const file of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"tool_use"') || !(line.includes('"name":"Agent"') || line.includes('"name":"Task"'))) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain || o.type !== 'assistant') continue;
    if (o.timestamp && Date.parse(o.timestamp) < since) continue;
    for (const c of o.message?.content || [])
      if (c?.type === 'tool_use' && ['Agent', 'Task'].includes(c.name) && c.input && typeof c.input.prompt === 'string')
        inputs.push(c.input);
  }
}

const key = (m, e) => `${m || '(agent)'}·${e || '(agent)'}`;
const after = {};
const swaps = {};
const sample = [];
let toHaiku = 0;
for (const input of inputs) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'replay', tool_input: input }),
    env: { ...process.env, OCCAM_CLAUDE_DIR: tmp },
    encoding: 'utf8',
  });
  let next = input;
  try {
    if (r.stdout) next = JSON.parse(r.stdout).hookSpecificOutput.updatedInput;
  } catch {}
  const type = input.subagent_type || 'general-purpose';
  after[key(next.model, next.effort)] = (after[key(next.model, next.effort)] || 0) + 1;
  if (input.model !== next.model || input.effort !== next.effort) {
    const k = `${type}: ${key(input.model, input.effort)} > ${key(next.model, next.effort)}`;
    swaps[k] = (swaps[k] || 0) + 1;
    if (/haiku/.test(next.model || '') && !/haiku/.test(input.model || '')) {
      toHaiku++;
      sample.push(`[${type}] ` + input.prompt.replace(/\s+/g, ' ').slice(0, 150));
    }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

const sorted = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
console.log(`Real delegations in ${DAYS} days: ${inputs.length} (from ${files.length} transcripts)`);
console.log('\nHow they would come out with the current hook (model·effort):');
for (const [k, n] of sorted(after)) console.log(`  ${n}× ${k}`);
console.log('\nSwaps the current hook would make:');
for (const [k, n] of sorted(swaps)) console.log(`  ${n}× ${k}`);
console.log(`\nLowered to Haiku: ${toHaiku}. Sample of the start of each brief:`);
const step = Math.max(1, Math.floor(sample.length / 24));
for (let i = 0; i < sample.length; i += step) console.log('  - ' + sample[i]);
