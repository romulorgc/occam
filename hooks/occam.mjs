// occam: automatic model and effort routing for Claude Code.
//
// The main conversation cannot see the size of its own context, and every tool call it makes rereads
// that whole context. Subagents start clean. This hook makes the routing rules automatic at four points:
//
// SessionStart (startup, clear, compact): injects the body of the occam skill (skills/occam/SKILL.md),
//   so the rules are in context without the model having to remember to load the skill. SKILL.md stays
//   the single source of truth. Optionally (capStoredEffort) caps the effort stored per model in
//   settings.json.
// UserPromptSubmit: one line with the current context size, what each tool call rereads, the call budget
//   for that context and the reminder to classify the task. Warns when /effort left a high effort
//   stored for the conversation model.
// PreToolUse Agent|Task: fills in model and effort when the call omits them, enforces the guard rails
//   below, appends a reading note to every brief (except fork) and logs each delegation (never the prompt
//   or the description) to <claude dir>/occam/log.jsonl.
// PreCompact: returns, as plain text, what the compaction summary must keep and what it may drop (Claude
//   Code appends the hook stdout to the summary instructions).
//
// Guard rails (written rules are not enough, the hook enforces them):
//   - Opus in a subagent only for opusFree types, or with an "[opus: reason]" marker in the brief;
//     otherwise it becomes sonnet.
//   - Fable only for fableFree types, or with "[fable: reason]"; otherwise opus (opusFree types) or sonnet.
//   - high on highNeedsReason types only with "[high: reason]"; otherwise medium. xhigh and max only on
//     fableFree types. Opus never goes above high: on a fableFree type, opus at xhigh/max becomes
//     fable at high.
//   - Haiku floor: sonnet at medium or below becomes haiku on floorTypes, and on floorByBrief types when
//     the brief is read-only. "[sonnet: reason]" keeps sonnet. Every Haiku brief gets the Haiku note.
//   - Every swap goes back to the main conversation (additionalContext) and into the log.
//   Any error in the guard rails lets the input through unchanged.
//
// Configuration (all optional): <claude dir>/occam/config.json. A missing or invalid file means defaults.
// See docs/CONFIG.md.
//
// A hook that fails never blocks: exit 0 with no output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_DIR = process.env.OCCAM_CLAUDE_DIR || path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------- configuration

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULTS = {
  opusFree: ['reviewer', 'architect'],
  fableFree: ['architect'],
  topTier: 'architect',
  floorTypes: ['scout', 'Explore'],
  floorByBrief: ['general-purpose', 'claude'],
  highNeedsReason: ['general-purpose', 'implementer', 'scout', 'Explore'],
  fillDefaults: ['general-purpose', 'Explore', 'Plan', 'claude'],
  // Cache-read price in US$ per million tokens, matched by substring of the model name (longest key wins).
  // A number is the cache-read price. An object may carry in, cw1h, cw5m, cr, out and a `long` override
  // that applies above `longAbove` tokens of context.
  prices: {
    haiku: { in: 0.1, cw1h: 0.2, cw5m: 0.125, cr: 0.01, out: 0.5, longAbove: 100000, long: { in: 0.5, cw1h: 1, cw5m: 0.625, cr: 0.05, out: 2.5 } },
    sonnet: { in: 2, cw1h: 4, cw5m: 2.5, cr: 0.1, out: 10 },
    opus: { in: 4, cw1h: 8, cw5m: 5, cr: 0.2, out: 20 },
    fable: { in: 8, cw1h: 16, cw5m: 10, cr: 0.2, out: 40 },
  },
  callBudget: { lowBelow: 100000, lowCalls: 4, midUpTo: 150000, midCalls: 3, highCalls: 2 },
  capStoredEffort: null,
  permission: 'allow',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v, fallback) => (Array.isArray(v) && v.every((s) => typeof s === 'string' && s) ? v : fallback);

// Price entries merge field by field over the default of the same model key. A field with the wrong type
// keeps that model's default for the field; with no default for the key, the field is left out.
const PRICE_FIELDS = ['in', 'cw1h', 'cw5m', 'cr', 'out'];
const okNum = (n) => Number.isFinite(n) && n >= 0;
function mergePrice(def, v) {
  const out = { ...(def || {}) };
  if (isObj(def?.long)) out.long = { ...def.long };
  for (const f of [...PRICE_FIELDS, 'longAbove']) if (okNum(v[f])) out[f] = v[f];
  if (isObj(v.long)) {
    const lg = { ...(out.long || {}) };
    for (const f of PRICE_FIELDS) if (okNum(v.long[f])) lg[f] = v.long[f];
    out.long = lg;
  }
  return out;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'occam', 'config.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return cfg;
  }
  if (!isObj(raw)) return cfg;
  try {
    for (const k of ['opusFree', 'fableFree', 'floorTypes', 'floorByBrief', 'highNeedsReason', 'fillDefaults'])
      cfg[k] = strList(raw[k], DEFAULTS[k]);
    if (raw.topTier === null || (typeof raw.topTier === 'string' && raw.topTier)) cfg.topTier = raw.topTier;
    if (isObj(raw.prices)) {
      const p = { ...DEFAULTS.prices };
      for (const [k, v] of Object.entries(raw.prices)) {
        const def = Object.hasOwn(DEFAULTS.prices, k) ? DEFAULTS.prices[k] : undefined;
        if (typeof v === 'number' && v >= 0) p[k] = mergePrice(def, { cr: v });
        else if (isObj(v)) p[k] = mergePrice(def, v);
      }
      cfg.prices = p;
    }
    if (isObj(raw.callBudget)) {
      const b = { ...DEFAULTS.callBudget };
      for (const k of Object.keys(b)) if (Number.isFinite(raw.callBudget[k]) && raw.callBudget[k] >= 0) b[k] = raw.callBudget[k];
      cfg.callBudget = b;
    }
    if (['allow', 'ask', 'none'].includes(raw.permission)) cfg.permission = raw.permission;
    if (raw.capStoredEffort === null || LEVELS.includes(raw.capStoredEffort)) cfg.capStoredEffort = raw.capStoredEffort;
  } catch {
    return { ...DEFAULTS };
  }
  return cfg;
}

const CFG = loadConfig();
const set = (k) => new Set(CFG[k]);
const OPUS_FREE = set('opusFree');
const FABLE_FREE = set('fableFree');
const FLOOR_TYPES = set('floorTypes');
const FLOOR_BY_BRIEF = set('floorByBrief');
const HIGH_NEEDS_REASON = set('highNeedsReason');
const FILL_DEFAULTS = set('fillDefaults');
// Types that may use opus but not unbounded effort (reviewer-like): xhigh and max are capped to high.
const HIGH_CAPPED = new Set([...OPUS_FREE].filter((t) => !FABLE_FREE.has(t)));

// ---------------------------------------------------------------- constants

const MARK = '[occam · reading]';
const NOTE =
  `\n\n${MARK} Every call you make rereads everything already in your context. Open files in slices (grep -n to find, ` +
  'Read with offset/limit), filter command output at the source (| head, --stat, grep -c, tail of logs) and do not ' +
  'reopen what you already read. This is about not filling the context, not about doing less: do the whole task and ' +
  'verify as you would without this note. If the brief gives no delivery format, return briefly: what changed, the ' +
  'proof you ran, what is left.';
const MARK_HAIKU = '[occam · haiku]';
const NOTE_HAIKU =
  `\n\n${MARK_HAIKU} At most 15 tool calls; read slices with offset/limit and filter output at the source with grep ` +
  '(above 100K of context you cost 5 times more). If the task needs more than locating, listing, counting, ' +
  'extracting or summarizing, say so in the first line of the reply instead of improvising.';
const MARK_OPUS = '[opus: ';
const MARK_HIGH = '[high: ';
const MARK_FABLE = '[fable: ';
const MARK_SONNET = '[sonnet: ';

// A marker is "[name: reason]": case-insensitive, optional spaces after "[" and around ":", the closing "]" is
// required, and the reason cannot be empty or a placeholder (reason, motivo, <reason>, only dots).
const PLACEHOLDER = /^(?:<\s*(?:reason|motivo)\s*>|reason|motivo|\.+)$/i;
function hasMarker(prompt, name) {
  const re = new RegExp('\\[\\s*' + name + '\\s*:\\s*([^\\]]*)\\]', 'gi');
  for (const m of prompt.matchAll(re)) {
    const reason = m[1].trim();
    if (reason && !PLACEHOLDER.test(reason)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- read-only brief classifier
//
// Bilingual on purpose (English and Portuguese verbs): briefs are written in either. It only lowers to
// Haiku what returns a checkable answer (path:line, a count, a literal list). Three conditions:
//  1. the goal (text after the "Objective" label, or the start of the brief) OPENS with a read verb;
//  2. the goal does not ask for judgment (analyze, review, why, cause, prove...);
//  3. the whole brief asks for no writing, no web research and no imperative judgment.
// "do not edit" and similar negations do not count.
const TARGET =
  '[^.;:]{0,160}?\\b(?:onde|qual|quais|quant[oa]s|o caminho|em que arquivo|que arquivos?|where|which|how many|the path)\\b';
const READ_VERB = new RegExp(
  '\\b(?:localiz\\w*|list[ae]\\w*|cont(?:e|ar|em|agem)\\b|quant[oa]s\\b|extrai\\w*|resum\\w*|inventari\\w*|' +
    'levant[ea]\\w*|procur[ea]\\w*|encontr[ea]\\w*|ach[ea]r?\\b|enumer\\w*|transcrev\\w*|' +
    'onde (?:esta|estao|fica|ficam|mora|moram)\\b|quem chama|(?:descobr|identifi|discover|identify|determin)\\w*' +
    TARGET +
    '|diz(?:er|a)\\s+(?:onde|qual|quais|quant[oa]s)\\b|find\\b|locate\\b|count\\b|extract\\b|summari[sz]e\\b|list\\b|' +
    'search\\b|where (?:is|are)\\b|who calls\\b|how many\\b|inventory\\b)',
);
const OPENING = 80; // the read verb must start within the first 80 characters of the goal
const ZONE = 400; // size of the goal
const WRITES_SRC =
  'edit\\w*|alter[ea]r?\\b|mud[ea]r?\\b|modif\\w*|corrij\\w*|corrig\\w*|consert\\w*|implement[ea]r?\\b|implemente\\w*|' +
  'escrev\\w*|cri[ea]r?\\b|adicion\\w*|remov\\w*|apag\\w*|refator\\w*|depur\\w*|debug\\w*|migr[ea]r?\\b|' +
  'commit(?:e|ar|em)\\b|git\\s+(?:commit|push|add|reset|merge|rebase|checkout|stash)\\b|deploy\\w*|' +
  'publi(?:que|car)\\w*|instal\\w*|pesquis\\w*|websearch|webfetch|na web\\b|na internet\\b|com fontes\\b|fontes oficiais|' +
  'fix\\w*|writ[ei]\\w*|rewrit\\w*|creat\\w*|delet\\w*|chang\\w*|updat\\w*|research\\w*|refactor\\w*|' +
  'add\\b|publish\\w*|on the web\\b|(?:the|a) web\\b|web search|official sources|' +
  // imperative judgment (forms that cannot be mistaken for nouns)
  'revise\\b|audite\\b|decida\\b|avalie\\b|compare\\b|investigue\\b|recomende\\b|sugira\\b|explique\\b|sintetize\\b|' +
  'diagnostique\\b|planeje\\b|recommend\\b|investigate\\b|synthesi[sz]e\\b';
const JUDGES_SRC =
  'revis\\w*|audit\\w*|decid\\w*|avali\\w*|analis\\w*|compar\\w*|por que\\b|porque\\b|causa\\w*|diagnos\\w*|' +
  'investig\\w*|planej\\w*|desenh\\w*|arquitet\\w*|recomend\\w*|sugir\\w*|sugest\\w*|prov[ea]r?\\b|valid\\w*|' +
  'test[ea]r?\\b|entend\\w*|expli\\w*|sintetiz\\w*|implement\\w*|migr\\w*|review\\w*|evaluat\\w*|analy[sz]\\w*|' +
  'why\\b|design\\w*|suggest\\w*|understand\\w*|explain\\w*|recommend\\w*|root cause|cause\\b|prove\\b';
const WRITES = new RegExp('\\b(?:' + WRITES_SRC + ')');
const JUDGES = new RegExp('\\b(?:' + JUDGES_SRC + ')');
const NEGATED = new RegExp(
  "\\b(?:nao|sem|nunca|nem|jamais|not|nor|never|without|don'?t)\\b(?:\\s+[\\w-]+){0,2}?\\s+(?:" +
    WRITES_SRC +
    '|' +
    JUDGES_SRC +
    ')',
  'g',
);
const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// The goal is what follows the "Objective" label; with no label, it is the start of the brief.
function goalOf(t) {
  const m = /\b(?:objetivo|objective|goal)\b[\s:.*#_-]*/.exec(t.slice(0, 600));
  const start = m ? m.index + m[0].length : 0;
  return t.slice(start, start + ZONE);
}

// Returns the read verb that opens the goal and the first word that asks for more than reading.
function classify(prompt) {
  try {
    if (typeof prompt !== 'string' || !prompt.trim()) return { verb: null, asks: null };
    const t = plain(prompt);
    const v = READ_VERB.exec(goalOf(t));
    const clean = t.replace(NEGATED, ' ');
    const p = JUDGES.exec(goalOf(clean)) || WRITES.exec(clean);
    return { verb: v && v.index < OPENING ? v[0].slice(0, 40) : null, asks: p ? p[0] : null };
  } catch {
    return { verb: null, asks: null };
  }
}

function isReadOnly(prompt) {
  const c = classify(prompt);
  return Boolean(c.verb) && !c.asks;
}

// ---------------------------------------------------------------- cost line

function priceEntry(model) {
  let best = null;
  for (const k of Object.keys(CFG.prices)) if (model.includes(k) && (best === null || k.length > best.length)) best = k;
  return best === null ? null : CFG.prices[best];
}

// US$ per million cache-read tokens for this model at this context size.
function readPrice(model, ctx) {
  const e = priceEntry(model);
  if (typeof e === 'number') return e;
  if (isObj(e)) {
    const above = Number.isFinite(e.longAbove) ? e.longAbove : 100_000;
    if (ctx > above && Number.isFinite(e.long?.cr)) return e.long.cr;
    if (Number.isFinite(e.cr)) return e.cr;
  }
  return 0.2;
}

// How many tool calls fit in the main conversation before delegating.
function callBudget(ctx) {
  const b = CFG.callBudget;
  if (ctx < b.lowBelow) return b.lowCalls;
  return ctx <= b.midUpTo ? b.midCalls : b.highCalls;
}

// The last main-conversation response carries the context size.
function lastContext(transcript) {
  const fd = fs.openSync(transcript, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // Read the tail; with no usage record in it, grow the window 4 times per step up to 16 MB or the whole file.
    const limit = Math.min(size, 16 * 1024 * 1024);
    for (let n = Math.min(size, 512 * 1024); ; n = Math.min(limit, n * 4)) {
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) continue;
        let o;
        try {
          o = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const m = o.message;
        if (o.isSidechain || !m?.usage || !m.model || m.model.startsWith('<')) continue;
        const u = m.usage;
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        return { model: m.model.replace(/^claude-/, ''), ctx };
      }
      if (n >= limit) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

// ---------------------------------------------------------------- settings.json (read; written only with capStoredEffort)

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const rank = (e) => LEVELS.indexOf(e);

// Stored effort levels above the ceiling (the cap, or high when no cap is set), as "model=level".
// With a known conversation model only that model is checked; otherwise every stored model is.
function storedEffortTooHigh(s, model) {
  try {
    const ceiling = rank(CFG.capStoredEffort ?? 'high');
    return Object.entries(s?.modelSettings || {})
      .filter(([k, v]) => rank(v?.effortLevel) > ceiling && (!model || k.replace(/^claude-/, '') === model))
      .map(([k, v]) => `${k.replace(/^claude-/, '')}=${v.effortLevel}`);
  } catch {
    return [];
  }
}

function onPrompt(j) {
  const parts = [];
  const s = readSettings();
  let c = null;
  try {
    c = j.transcript_path && fs.existsSync(j.transcript_path) ? lastContext(j.transcript_path) : null;
  } catch {}
  if (c) {
    const cost = ((c.ctx * readPrice(c.model, c.ctx)) / 1e6).toFixed(3);
    parts.push(
      `context ≈ ${Math.round(c.ctx / 1000)}K (${c.model}) · each tool call here rereads ≈ $${cost}` +
        ` · call budget here: ${callBudget(c.ctx)} calls, beyond that delegate`,
    );
    if (c.ctx >= 200_000) {
      const win = Number(s?.autoCompactWindow);
      parts.push(
        (win > 0
          ? `automatic compaction near ${Math.round(win / 1000)}K`
          : 'automatic compaction has no window configured') +
          '; at the end of a topic, suggest /compact <what to keep> or /clear',
      );
    }
    if (c.model.includes('fable'))
      parts.push(
        'conversation on Fable (output costs 2× Opus): here only plan, decide and verify; heavy reading and bulk writing go to a subagent',
      );
  }
  parts.push(
    'classify the task level (L0 to L5) with the occam skill before the first tool call; write the `occam:` line only when delegating (the rules load at session start; if they are not in context, load the skill)',
  );
  const high = storedEffortTooHigh(s, c?.model);
  if (high.length)
    parts.push(
      CFG.capStoredEffort
        ? `WARNING: stored effort is ${high.join(', ')}, above the cap of ${CFG.capStoredEffort}; tell the user (the hook lowers it at the start of the next session)`
        : `WARNING: stored effort is ${high.join(', ')}, which makes every response slower and costlier; tell the user (lower it with /effort, or set capStoredEffort in occam/config.json to cap it at session start)`,
    );
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[occam] ' + parts.join(' · ') } };
}

// additionalContext limit: 10,000 characters (above that it becomes a 2,000 character preview).
function onStart() {
  let text;
  try {
    const skill = fs.readFileSync(path.join(CLAUDE_DIR, 'skills', 'occam', 'SKILL.md'), 'utf8');
    const body = skill.replace(/^---[\s\S]*?\n---\r?\n/, '').trim();
    text =
      '[occam] Routing rules for this session (occam skill already loaded; no need to call it through the Skill tool):\n\n' +
      body;
    if (text.length > 9500)
      text =
        '[occam] skills/occam/SKILL.md exceeded 9,500 characters and was not injected. Load the occam skill through the Skill tool and tell the user to trim it.';
  } catch {
    text = '[occam] Could not read skills/occam/SKILL.md in the Claude directory. Tell the user: the occam skill is unavailable this session.';
  }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

// PreCompact: plain text. Claude Code appends the stdout to the summary instructions.
function onCompact() {
  return [
    'occam instructions for this summary (in addition to those of the /compact request, if any):',
    '1. Preserve verbatim: every user request still open, in the user\'s words; the decisions and authorizations given, with dates; the corrections the user made to how the work is done in this session.',
    '2. Preserve the work state: current task and next step; numbered pending items; file paths with line numbers, branches, commit and deploy hashes; subagents and background tasks still running, with their identifiers.',
    '3. Preserve the proofs: each check that was run and its result (passed or failed, with the number), what was discarded and why, and what has NOT been proven yet.',
    '4. Discard: file contents, raw tool output, logs, HTML, JSON and repeated attempts. Keep only the path, to reread from disk if needed.',
    '5. Do not invent state: anything not confirmed in the conversation goes in as "to verify".',
  ].join('\n');
}

// SessionStart, opt-in (capStoredEffort): lowers any effort stored in modelSettings above the cap. Touches
// only those values; atomic write (temporary file + rename). With no cap configured it writes nothing.
function capEffort() {
  try {
    const cap = CFG.capStoredEffort;
    if (!cap) return;
    const file = path.join(CLAUDE_DIR, 'settings.json');
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const s = JSON.parse(text);
    if (!isObj(s) || !isObj(s.modelSettings)) return;
    const change = {};
    for (const [k, v] of Object.entries(s.modelSettings)) if (rank(v?.effortLevel) > rank(cap)) change[k] = cap;
    if (!Object.keys(change).length) return;
    const expected = JSON.parse(text);
    for (const [k, e] of Object.entries(change)) expected.modelSettings[k].effortLevel = e;
    const target = JSON.stringify(expected);
    // 1) surgical swap of each value (the rest of the file stays byte for byte identical)
    let next = text;
    for (const [k, e] of Object.entries(change)) {
      const key = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      next = next.replace(
        new RegExp('("' + key + '"\\s*:\\s*\\{[^{}]*?"effortLevel"\\s*:\\s*)"[^"]*"'),
        (_m, head) => head + '"' + e + '"',
      );
    }
    let ok = false;
    try {
      ok = next !== text && JSON.stringify(JSON.parse(next)) === target;
    } catch {}
    // 2) otherwise rewrite the whole file with the same indentation
    if (!ok) {
      const indent = (text.match(/^([ \t]+)"/m) || [])[1] || '  ';
      const crlf = text.includes('\r\n');
      next = JSON.stringify(expected, null, indent) + (/\n$/.test(text) ? '\n' : '');
      if (crlf) next = next.replace(/\n/g, '\r\n');
      if (JSON.stringify(JSON.parse(next)) !== target) return;
    }
    // Same mode as the original, exclusive create, random name: an existing path is never reused.
    const mode = fs.statSync(file).mode & 0o777;
    const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(tmp, next, { flag: 'wx', mode });
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw e;
    }
  } catch {}
}

// ---------------------------------------------------------------- PreToolUse guard rails

// Returns the swaps made, or [] if nothing changed (or on error).
// `readOnly` = the brief was classified as read-only.
function applyGuards(type, input, next, readOnly) {
  try {
    if (type === 'fork') return { rewritten: [], notice: '' };
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const has = (mark) => hasMarker(prompt, mark.slice(1, mark.indexOf(':')));
    const rewritten = [];
    const notices = [];
    let model = next.model;
    let effort = next.effort;
    const is = (re) => typeof model === 'string' && re.test(model);

    // Fable: only on fableFree types, or with the reason marker.
    if (is(/fable/i) && !FABLE_FREE.has(type) && !has(MARK_FABLE)) {
      const target = OPUS_FREE.has(type) || has(MARK_OPUS) ? 'opus' : 'sonnet';
      rewritten.push(`model:${model}>${target}`);
      notices.push(
        `model ${model} became ${target} (Fable is limited to ${CFG.fableFree.join('/') || 'no type'}; elsewhere it needs a ${MARK_FABLE}reason] marker)`,
      );
      model = target;
    }
    // Opus: only on opusFree types, or with the reason marker.
    if (is(/opus/i) && !OPUS_FREE.has(type) && !has(MARK_OPUS)) {
      rewritten.push(`model:${model}>sonnet`);
      notices.push(`model ${model} became sonnet (no ${MARK_OPUS}reason] marker for opus)`);
      model = 'sonnet';
    }
    // Effort: high is controlled; xhigh and max only on fableFree types.
    if (typeof effort === 'string' && ['high', 'xhigh', 'max'].includes(effort) && !FABLE_FREE.has(type)) {
      let target = effort;
      if (effort === 'high') {
        if (HIGH_NEEDS_REASON.has(type) && !has(MARK_HIGH)) target = 'medium';
      } else if (HIGH_CAPPED.has(type)) {
        target = 'high';
      } else {
        target = has(MARK_HIGH) ? 'high' : 'medium';
      }
      if (target !== effort) {
        rewritten.push(`effort:${effort}>${target}`);
        notices.push(
          `effort ${effort} became ${target} (${target === 'medium' ? `no ${MARK_HIGH}reason] marker for high` : `xhigh and max are reserved for ${CFG.fableFree.join('/') || 'no type'}`})`,
        );
        effort = target;
      }
    }
    // Opus never goes above high: on a fableFree type the next step up is Fable at high.
    if (FABLE_FREE.has(type) && is(/opus/i) && ['xhigh', 'max'].includes(effort)) {
      rewritten.push(`model:${model}>fable`, `effort:${effort}>high`);
      notices.push(`${model} at ${effort} became fable at high (Opus does not go above high; the next step up is Fable)`);
      model = 'fable';
      effort = 'high';
    }
    // Haiku floor: pure reading does not run on Sonnet.
    if (
      is(/sonnet/i) &&
      !has(MARK_SONNET) &&
      (effort === undefined || effort === 'low' || effort === 'medium') &&
      (FLOOR_TYPES.has(type) || (FLOOR_BY_BRIEF.has(type) && readOnly))
    ) {
      rewritten.push(`model:${model}>haiku`);
      notices.push(
        `model ${model} became haiku (${FLOOR_TYPES.has(type) ? 'locate-type agent' : 'read-only brief'}; to keep it, add a ${MARK_SONNET}reason] marker)`,
      );
      model = 'haiku';
    }
    if (!rewritten.length) return { rewritten: [], notice: '' };
    next.model = model;
    if (effort !== undefined) next.effort = effort;
    return {
      rewritten,
      notice: `[occam · swapped] The hook changed this delegation: ${notices.join('; ')}. Markers in the brief: ${MARK_OPUS}reason], ${MARK_FABLE}reason], ${MARK_HIGH}reason], ${MARK_SONNET}reason].`,
    };
  } catch {
    return { rewritten: [], notice: '' };
  }
}

function record(entry) {
  try {
    const dir = path.join(CLAUDE_DIR, 'occam');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n');
  } catch {}
}

function onDelegation(j) {
  const input = j.tool_input || {};
  const type = input.subagent_type || 'general-purpose';
  const next = { ...input };
  const filled = [];
  const readOnly = type !== 'fork' && isReadOnly(input.prompt);
  if (FILL_DEFAULTS.has(type)) {
    if (!input.model) {
      next.model = FLOOR_TYPES.has(type) || (FLOOR_BY_BRIEF.has(type) && readOnly) ? 'haiku' : 'sonnet';
      filled.push('model');
    }
    if (!input.effort) {
      next.effort = 'medium';
      filled.push('effort');
    }
  } else if (CFG.topTier && type === CFG.topTier) {
    // Top step: Fable starting at medium (the agent definition's own model/effort stays as a fallback).
    if (!input.model) {
      next.model = 'fable';
      filled.push('model');
    }
    if (!input.effort) {
      next.effort = 'medium';
      filled.push('effort');
    }
  }
  const guard = applyGuards(type, input, next, readOnly);
  if (type !== 'fork' && typeof input.prompt === 'string') {
    if (!input.prompt.includes(MARK)) {
      next.prompt = input.prompt + NOTE;
      filled.push('note');
    }
    const goesToHaiku =
      (typeof next.model === 'string' && /haiku/i.test(next.model)) || (!next.model && FLOOR_TYPES.has(type));
    if (goesToHaiku && !input.prompt.includes(MARK_HAIKU)) {
      next.prompt = (next.prompt ?? input.prompt) + NOTE_HAIKU;
      filled.push('haiku-note');
    }
  }
  const entry = {
    ts: new Date().toISOString(),
    session: j.session_id,
    type,
    model: next.model || '(agent default)',
    effort: next.effort || '(agent default)',
    filled,
    rewritten: guard.rewritten,
    fields: Object.keys(input),
  };
  if (readOnly) entry.readOnly = true;
  record(entry);
  if (!filled.length && !guard.rewritten.length) return null;
  const parts = [];
  if (filled.length) parts.push(`added ${filled.join(' and ')}`);
  if (guard.rewritten.length) parts.push(`swapped ${guard.rewritten.join(', ')}`);
  const out = {
    hookEventName: 'PreToolUse',
    updatedInput: next,
  };
  if (CFG.permission !== 'none') {
    out.permissionDecision = CFG.permission === 'ask' ? 'ask' : 'allow';
    out.permissionDecisionReason = `occam ${parts.join('; ')}`;
  }
  const toConversation = [];
  if (guard.notice) toConversation.push(guard.notice);
  else if (filled.includes('model'))
    toConversation.push(
      `[occam] The hook filled in this delegation: ${type} · ${next.model} · ${next.effort || 'agent default effort'}${readOnly ? ' (read-only brief)' : ''}.`,
    );
  if (toConversation.length) out.additionalContext = toConversation.join(' ');
  return { hookSpecificOutput: out };
}

// ---------------------------------------------------------------- entry point

// No process.exit() after a write: a write to a pipe can still be pending, and exiting cuts it.
// Seen on macOS, where the SessionStart payload arrived cut near 8 KB and was no longer valid JSON.
// The exit code is set and the process ends on its own once stdout has flushed.
process.stdout.on('error', () => {});
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  // Test and measurement use: a JSON array of briefs comes in; --read-only returns booleans,
  // --explain returns the read verb and the word that blocked each one.
  if (process.argv[2] === '--read-only' || process.argv[2] === '--explain') {
    try {
      const list = JSON.parse(raw);
      process.stdout.write(JSON.stringify(list.map((p) => (process.argv[2] === '--explain' ? classify(p) : isReadOnly(p)))));
    } catch {}
  } else {
    const j = JSON.parse(raw);
    if (j?.hook_event_name === 'PreCompact') {
      process.stdout.write(onCompact());
    } else {
      let out = null;
      if (j?.hook_event_name === 'SessionStart' && !j.agent_id) {
        capEffort();
        out = onStart();
      } else if (j?.hook_event_name === 'UserPromptSubmit') out = onPrompt(j);
      else if (j?.hook_event_name === 'PreToolUse' && ['Agent', 'Task'].includes(j.tool_name) && !j.agent_id)
        out = onDelegation(j);
      if (out) process.stdout.write(JSON.stringify(out));
    }
  }
} catch {}
process.exitCode = 0;
