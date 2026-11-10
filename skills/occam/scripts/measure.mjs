// How much Claude Code spent in the last N days, per thread and model, in API-equivalent cost.
// Usage: node measure.mjs [days=7]
// Reads only message.model and message.usage from the transcripts (<claude dir>/projects) and the
// delegation log of the occam hook (<claude dir>/occam/log.jsonl). Prints no conversation text.
// The Claude directory is ~/.claude, or OCCAM_CLAUDE_DIR when set. Prices come from the same
// optional config as the hook (occam/config.json, key `prices`), with public defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const days = Number(process.argv[2] || 7);
const since = new Date(Date.now() - days * 864e5);
const CLAUDE_DIR = process.env.OCCAM_CLAUDE_DIR || path.join(os.homedir(), '.claude');

// US$ per million tokens: input, cache write (1 h in the main thread, 5 min in subagents), cache read, output.
// `long` overrides the entry above `longAbove` tokens of context.
const DEFAULT_PRICES = {
  haiku: { in: 0.1, cw1h: 0.2, cw5m: 0.125, cr: 0.01, out: 0.5, longAbove: 100000, long: { in: 0.5, cw1h: 1, cw5m: 0.625, cr: 0.05, out: 2.5 } },
  sonnet: { in: 2, cw1h: 4, cw5m: 2.5, cr: 0.1, out: 10 },
  opus: { in: 4, cw1h: 8, cw5m: 5, cr: 0.2, out: 20 },
  fable: { in: 8, cw1h: 16, cw5m: 10, cr: 0.2, out: 40 },
};

// Merge field by field over the default of the same model key. A field with the wrong type keeps that model's
// default for the field; with no default for the key, the field is left out.
const FIELDS = ['in', 'cw1h', 'cw5m', 'cr', 'out'];
const okNum = (n) => Number.isFinite(n) && n >= 0;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function mergePrice(def, v) {
  const out = { ...(def || {}) };
  if (isObj(def?.long)) out.long = { ...def.long };
  for (const f of [...FIELDS, 'longAbove']) if (okNum(v[f])) out[f] = v[f];
  if (isObj(v.long)) {
    const lg = { ...(out.long || {}) };
    for (const f of FIELDS) if (okNum(v.long[f])) lg[f] = v.long[f];
    out.long = lg;
  }
  return out;
}

function loadPrices() {
  const prices = { ...DEFAULT_PRICES };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'occam', 'config.json'), 'utf8').replace(/^﻿/, ''));
    if (raw && typeof raw.prices === 'object' && !Array.isArray(raw.prices))
      for (const [k, v] of Object.entries(raw.prices)) {
        const def = Object.hasOwn(DEFAULT_PRICES, k) ? DEFAULT_PRICES[k] : undefined;
        if (typeof v === 'number' && v >= 0) prices[k] = mergePrice(def, { cr: v });
        else if (v && typeof v === 'object' && !Array.isArray(v)) prices[k] = mergePrice(def, v);
      }
  } catch {}
  return prices;
}
const PRICES = loadPrices();

function priceFor(model, ctx) {
  let best = null;
  for (const k of Object.keys(PRICES)) if (model.includes(k) && (best === null || k.length > best.length)) best = k;
  if (best === null) return null;
  const e = PRICES[best];
  const lg = ctx > (Number.isFinite(e.longAbove) ? e.longAbove : 100_000) && e.long ? e.long : {};
  const pick = (f) => (Number.isFinite(lg[f]) ? lg[f] : Number.isFinite(e[f]) ? e[f] : 0);
  return { in: pick('in'), cw1h: pick('cw1h'), cw5m: pick('cw5m'), cr: pick('cr'), out: pick('out') };
}

function* transcripts(dir) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of items) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(p);
    else if (e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtime >= since) yield p;
      } catch {}
    }
  }
}

const sum = {};
const seen = new Set();
for (const file of transcripts(path.join(CLAUDE_DIR, 'projects'))) {
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  for await (const l of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!l.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const m = o.message;
    if (!m?.usage || !m.model || m.model.startsWith('<')) continue;
    if (o.timestamp && new Date(o.timestamp) < since) continue;
    const id = (m.id || '') + '|' + (o.requestId || '');
    if (seen.has(id)) continue;
    seen.add(id);
    const u = m.usage;
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const p = priceFor(m.model, ctx);
    if (!p) continue;
    const thread = isSub || o.isSidechain ? 'subagent' : 'main';
    const k = `${thread} · ${m.model.replace(/^claude-/, '')}`;
    const s = (sum[k] ||= { resp: 0, ctx: 0, read: 0, write: 0, out: 0 });
    s.resp++;
    s.ctx += ctx;
    s.read += ((u.cache_read_input_tokens || 0) * p.cr) / 1e6;
    s.write +=
      ((u.input_tokens || 0) * p.in + (u.cache_creation_input_tokens || 0) * (thread === 'main' ? p.cw1h : p.cw5m)) / 1e6;
    s.out += ((u.output_tokens || 0) * p.out) / 1e6;
  }
}

const rows = Object.entries(sum).map(([k, s]) => ({ k, ...s, tot: s.read + s.write + s.out }));
const total = rows.reduce((a, r) => a + r.tot, 0);
console.log(`Last ${days} days · API-equivalent cost: US$ ${total.toFixed(2)}\n`);
console.log('thread · model | US$ | % | responses | average context | read + write + output');
for (const r of rows.sort((a, b) => b.tot - a.tot)) {
  if (r.tot < 0.005) continue;
  console.log(
    `${r.k} | ${r.tot.toFixed(2)} | ${total ? ((100 * r.tot) / total).toFixed(0) : 0}% | ${r.resp} | ${Math.round(r.ctx / r.resp / 1000)}K | ` +
      `${r.read.toFixed(2)} + ${r.write.toFixed(2)} + ${r.out.toFixed(2)}`,
  );
}

const logFile = path.join(CLAUDE_DIR, 'occam', 'log.jsonl');
if (fs.existsSync(logFile)) {
  const count = {};
  let filled = 0;
  const swaps = {};
  let rewrites = 0;
  for (const l of fs.readFileSync(logFile, 'utf8').split('\n')) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (new Date(o.ts) < since) continue;
    const k = `${o.type} · ${o.model} · ${o.effort}`;
    count[k] = (count[k] || 0) + 1;
    if (o.filled?.some((p) => !p.endsWith('note'))) filled++;
    if (Array.isArray(o.rewritten) && o.rewritten.length) {
      rewrites++;
      const kt = `${o.type}: ${o.rewritten.join(', ')}`;
      swaps[kt] = (swaps[kt] || 0) + 1;
    }
  }
  const n = Object.values(count).reduce((a, b) => a + b, 0);
  console.log(`\nDelegations logged by the hook: ${n} (${filled} with model/effort filled in by the hook; ${rewrites} rewritten by the hook)`);
  for (const [k, v] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
  if (rewrites) {
    console.log('\nRewritten by the hook (Opus and Fable guards, high without a reason marker; Haiku floor on pure reading):');
    for (const [k, v] of Object.entries(swaps).sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
  }
} else {
  console.log('\nNo delegation log yet (occam/log.jsonl in the Claude directory).');
}
