// Diagnostic of the read-only classifier over the real briefs of the last N days.
// Usage: node calibrate.mjs [days=9]   (the Claude directory is ~/.claude, or OCCAM_CLAUDE_DIR when set)
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

const target = inputs.filter((e) => ['general-purpose', 'claude'].includes(e.subagent_type || 'general-purpose'));
if (!target.length) {
  console.log(`No general-purpose/claude briefs in the last ${DAYS} days (${files.length} transcripts read).`);
  process.exit(0);
}
const r = spawnSync(process.execPath, [HOOK, '--explain'], {
  input: JSON.stringify(target.map((e) => e.prompt)),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const cls = JSON.parse(r.stdout);
let noVerb = 0;
let pure = 0;
const blocked = {};
const sizes = [];
const blockedSample = [];
const pureSample = [];
target.forEach((e, i) => {
  sizes.push(e.prompt.length);
  const c = cls[i];
  const head = e.prompt.replace(/\s+/g, ' ').slice(0, 130);
  if (!c.verb) {
    noVerb++;
  } else if (!c.asks) {
    pure++;
    pureSample.push(`(${c.verb.slice(0, 14)} | ${e.model || '-'}·${e.effort || '-'} | ${e.prompt.length} chars) ${head}`);
  } else {
    blocked[c.asks] = (blocked[c.asks] || 0) + 1;
    blockedSample.push(`(${c.verb} | blocked by: ${c.asks}) ${head}`);
  }
});
sizes.sort((a, b) => a - b);
console.log(`general-purpose/claude in ${DAYS} days: ${target.length} briefs; median size ${sizes[Math.floor(sizes.length / 2)]} characters`);
console.log(`no read verb in the goal: ${noVerb} | read verb but blocked: ${target.length - noVerb - pure} | pure reading: ${pure}`);
console.log('\nWords that blocked (first one of each brief):');
console.log('  ' + Object.entries(blocked).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, n]) => `${k} ${n}`).join(', '));
const show = (title, list, n) => {
  console.log(`\n${title}`);
  const step = Math.max(1, Math.floor(list.length / n));
  for (let i = 0; i < list.length && i / step < n; i += step) console.log('  - ' + list[i]);
};
show('PURE READING (would go to Haiku):', pureSample, 30);
show('Read verb present, blocked:', blockedSample, 12);
