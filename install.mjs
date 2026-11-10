#!/usr/bin/env node
// occam installer: copies the hook and skill into a Claude Code config
// folder and registers the hook in settings.json. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `occam installer

Usage: node install.mjs [options]

Options:
  --with-agents     also copy agents/*.md to <dir>/agents/ (never overwrites)
  --uninstall       remove the hook entries, hooks/occam.mjs and skills/occam/
  --dry-run         show the plan and write nothing
  --source <dir>    take files from <dir> instead of this script's folder
  --help            show this text

<dir> is ~/.claude, or the folder named by the OCCAM_CLAUDE_DIR variable.
`;

const EVENTS = [
  { name: 'SessionStart' },
  { name: 'UserPromptSubmit' },
  { name: 'PreToolUse', matcher: 'Agent|Task' },
  { name: 'PreCompact' },
];

function die(msg) {
  console.error(`occam: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { withAgents: false, uninstall: false, dryRun: false, source: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-agents') o.withAgents = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--source') {
      if (!argv[i + 1]) die('--source needs a folder');
      o.source = argv[++i];
    } else die(`unknown option: ${a} (try --help)`);
  }
  return o;
}

// A path separator must come before the name, so a hook called "myoccam.mjs" is left alone.
const isOccam = (h) => h && typeof h.command === 'string' && /[\\/]occam\.mjs/.test(h.command);

function detectIndent(text) {
  const m = text.match(/^[^\n]*\n(\t+|[ ]+)\S/);
  if (m) return m[1][0] === '\t' ? '\t' : m[1].length;
  return 2;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { data: {}, indent: 2, eol: '\n', existed: false };
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let data;
  try {
    data = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    // The parser's message can quote the file, which may hold secrets, so it is not printed.
    die(`${file} is not valid JSON. Fix it and run again. Nothing was changed.`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    die(`${file} is not a JSON object. Nothing was changed.`);
  }
  return { data, indent: detectIndent(text), eol: text.includes('\r\n') ? '\r\n' : '\n', existed: true };
}

function serialize(data, indent, eol) {
  let out = JSON.stringify(data, null, indent) + '\n';
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return out;
}

function atomicWrite(file, content) {
  const tmp = `${file}.occam-tmp-${process.pid}`;
  // Keep the permissions of the file being replaced: settings.json may be private.
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Returns the list of changes made to `data` (empty when already installed).
function addHooks(data, command) {
  const changes = [];
  if (data.hooks === undefined) data.hooks = {};
  if (data.hooks === null || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    die('"hooks" in settings.json is not an object. Nothing was changed.');
  }
  for (const ev of EVENTS) {
    if (data.hooks[ev.name] === undefined) data.hooks[ev.name] = [];
    const groups = data.hooks[ev.name];
    if (!Array.isArray(groups)) die(`hooks.${ev.name} in settings.json is not an array. Nothing was changed.`);
    let found = false;
    for (const g of groups) {
      for (const h of (g && Array.isArray(g.hooks)) ? g.hooks : []) {
        if (isOccam(h)) {
          found = true;
          if (h.command !== command) {
            h.command = command;
            changes.push(`${ev.name}: updated`);
          }
        }
      }
    }
    if (!found) {
      const group = ev.matcher ? { matcher: ev.matcher } : {};
      group.hooks = [{ type: 'command', command }];
      groups.push(group);
      changes.push(`${ev.name}: added`);
    }
  }
  return changes;
}

function removeHooks(data) {
  const changes = [];
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return changes;
  for (const name of Object.keys(hooks)) {
    const groups = hooks[name];
    if (!Array.isArray(groups)) continue;
    let removed = 0;
    const kept = [];
    for (const g of groups) {
      if (g && Array.isArray(g.hooks)) {
        const inner = g.hooks.filter((h) => !isOccam(h));
        if (inner.length !== g.hooks.length) {
          removed += g.hooks.length - inner.length;
          if (inner.length === 0) continue;
          g.hooks = inner;
        }
      }
      kept.push(g);
    }
    if (removed) {
      changes.push(`${name}: removed`);
      if (kept.length === 0) delete hooks[name];
      else hooks[name] = kept;
    }
  }
  if (changes.length && Object.keys(hooks).length === 0) delete data.hooks;
  return changes;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(opts.source || here);
  const dir = path.resolve(process.env.OCCAM_CLAUDE_DIR || path.join(os.homedir(), '.claude'));
  const abs = dir.replace(/\\/g, '/');
  const command = `node "${abs}/hooks/occam.mjs"`;
  const settingsFile = path.join(dir, 'settings.json');
  const dry = opts.dryRun;
  const tag = dry ? '[dry-run] ' : '';
  const log = (s) => console.log(`${tag}${s}`);

  console.log(`occam ${opts.uninstall ? 'uninstall' : 'install'}`);
  console.log(`  target: ${dir}`);
  if (!opts.uninstall) console.log(`  source: ${source}`);

  if (opts.uninstall) {
    const st = readSettings(settingsFile);
    const changes = st.existed ? removeHooks(st.data) : [];
    if (changes.length) {
      log(`settings.json: ${changes.join(', ')}`);
      if (!dry) {
        fs.copyFileSync(settingsFile, `${settingsFile}.occam-backup-${stamp()}`);
        atomicWrite(settingsFile, serialize(st.data, st.indent, st.eol));
      }
    } else log('settings.json: no occam entries found');
    for (const p of [path.join(dir, 'hooks', 'occam.mjs'), path.join(dir, 'skills', 'occam')]) {
      if (fs.existsSync(p)) {
        log(`remove ${p}`);
        if (!dry) fs.rmSync(p, { recursive: true, force: true });
      }
    }
    console.log(`\nKept: ${path.join(dir, 'occam')} (log and config) and any agents in ${path.join(dir, 'agents')}.`);
    console.log('Restart Claude Code to finish.');
    return;
  }

  const hookSrc = path.join(source, 'hooks', 'occam.mjs');
  const skillSrc = path.join(source, 'skills', 'occam');
  const missing = [hookSrc, skillSrc].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    if (!dry) die(`source is incomplete, missing: ${missing.join(', ')}`);
    for (const m of missing) console.log(`  warning: missing in source: ${m}`);
  }

  // Parse settings first so invalid JSON aborts before any file is copied.
  const st = readSettings(settingsFile);
  const changes = addHooks(st.data, command);

  log(`copy hooks/occam.mjs -> ${path.join(dir, 'hooks', 'occam.mjs')}`);
  log(`copy skills/occam/ -> ${path.join(dir, 'skills', 'occam')}`);
  if (!dry) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.copyFileSync(hookSrc, path.join(dir, 'hooks', 'occam.mjs'));
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.rmSync(path.join(dir, 'skills', 'occam'), { recursive: true, force: true });
    fs.cpSync(skillSrc, path.join(dir, 'skills', 'occam'), { recursive: true });
  }

  if (changes.length) {
    log(`settings.json: ${changes.join(', ')}`);
    if (!dry) {
      fs.mkdirSync(dir, { recursive: true });
      if (st.existed) fs.copyFileSync(settingsFile, `${settingsFile}.occam-backup-${stamp()}`);
      atomicWrite(settingsFile, serialize(st.data, st.indent, st.eol));
    }
  } else log('settings.json: already up to date, left untouched');

  if (opts.withAgents) {
    const agentsSrc = path.join(source, 'agents');
    const files = fs.existsSync(agentsSrc) ? fs.readdirSync(agentsSrc).filter((f) => f.endsWith('.md')) : [];
    const copied = [];
    const skipped = [];
    for (const f of files) {
      const dest = path.join(dir, 'agents', f);
      if (fs.existsSync(dest)) skipped.push(f);
      else {
        copied.push(f);
        if (!dry) {
          fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
          fs.copyFileSync(path.join(agentsSrc, f), dest);
        }
      }
    }
    log(`agents copied: ${copied.length ? copied.join(', ') : 'none'}`);
    if (skipped.length) log(`agents skipped (already exist): ${skipped.join(', ')}`);
  }

  console.log(dry ? '\nDry run: nothing was written.' : '\nDone.');
  console.log('Next steps:');
  console.log('  1. Restart Claude Code so it loads the hook.');
  console.log('  2. Run /occam measure to see it working.');
}

main();
