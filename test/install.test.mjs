// Installer tests. Own tiny runner, temp folders, fake source tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occam-test-'));
let n = 0;

function makeSource() {
  const src = path.join(root, `src-${n}`);
  fs.mkdirSync(path.join(src, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(src, 'skills', 'occam', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(src, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'hooks', 'occam.mjs'), '// fake hook\n');
  fs.writeFileSync(path.join(src, 'skills', 'occam', 'SKILL.md'), '# fake skill\n');
  fs.writeFileSync(path.join(src, 'skills', 'occam', 'scripts', 'x.mjs'), '// fake\n');
  fs.writeFileSync(path.join(src, 'agents', 'scout.md'), 'new scout\n');
  fs.writeFileSync(path.join(src, 'agents', 'reviewer.md'), 'new reviewer\n');
  return src;
}

function setup(dirName = 'claude') {
  n++;
  const dir = path.join(root, `case-${n}`, dirName);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, src: makeSource(), settings: path.join(dir, 'settings.json') };
}

function run(ctx, ...args) {
  return spawnSync(process.execPath, [INSTALL, '--source', ctx.src, ...args], {
    env: { ...process.env, OCCAM_CLAUDE_DIR: ctx.dir },
    encoding: 'utf8',
  });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (ctx) => fs.readdirSync(ctx.dir).filter((f) => f.startsWith('settings.json.occam-backup-'));
const occamCount = (s) =>
  Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes('occam.mjs')).length;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PreCompact'];

const other = (c) => ({ type: 'command', command: c });
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('fresh install creates the four entries and copies files', () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  const s = readJson(ctx.settings);
  for (const ev of EVENTS) {
    assert.equal(s.hooks[ev].length, 1, ev);
    assert.match(s.hooks[ev][0].hooks[0].command, /^node ".*\/hooks\/occam\.mjs"$/);
  }
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Agent|Task');
  assert.ok(!s.hooks.SessionStart[0].matcher);
  assert.ok(!s.hooks.UserPromptSubmit[0].matcher);
  assert.ok(!s.hooks.PreCompact[0].matcher);
  assert.ok(!s.hooks.SessionStart[0].hooks[0].command.includes('\\'));
  assert.ok(fs.existsSync(path.join(ctx.dir, 'hooks', 'occam.mjs')));
  assert.ok(fs.existsSync(path.join(ctx.dir, 'skills', 'occam', 'scripts', 'x.mjs')));
  assert.match(r.stdout, /Restart Claude Code/);
  assert.match(r.stdout, /\/occam measure/);
});

test('no temporary file is left in the target folder after an install', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.settings, '{}\n');
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(ctx.dir).filter((f) => f.includes('.occam-tmp-')), []);
});

test('second run does not duplicate, rewrite or back up', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.settings, '{\n  "a": 1\n}\n');
  assert.equal(run(ctx).status, 0);
  const first = fs.readFileSync(ctx.settings, 'utf8');
  const nBackups = backups(ctx).length;
  assert.equal(nBackups, 1);
  const mtime = fs.statSync(ctx.settings).mtimeMs;
  assert.equal(run(ctx).status, 0);
  assert.equal(fs.readFileSync(ctx.settings, 'utf8'), first);
  assert.equal(fs.statSync(ctx.settings).mtimeMs, mtime);
  assert.equal(backups(ctx).length, nBackups);
  assert.equal(occamCount(readJson(ctx.settings)), 4);
});

test('foreign hooks stay, in order, and key order is kept', () => {
  const ctx = setup();
  const before = {
    model: 'x',
    hooks: {
      Stop: [{ hooks: [other('stop-1')] }],
      SessionStart: [{ hooks: [other('first')] }, { hooks: [other('second')] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [other('bash-guard')] }],
    },
    env: { A: '1' },
  };
  fs.writeFileSync(ctx.settings, JSON.stringify(before, null, 2));
  assert.equal(run(ctx).status, 0);
  const s = readJson(ctx.settings);
  assert.deepEqual(Object.keys(s), ['model', 'hooks', 'env']);
  assert.deepEqual(s.hooks.Stop, before.hooks.Stop);
  assert.deepEqual(s.hooks.SessionStart.slice(0, 2), before.hooks.SessionStart);
  assert.equal(s.hooks.SessionStart.length, 3);
  assert.deepEqual(s.hooks.PreToolUse[0], before.hooks.PreToolUse[0]);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(s.env, before.env);
});

test('indentation with tab is kept', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.settings, JSON.stringify({ a: { b: 1 } }, null, '\t'));
  assert.equal(run(ctx).status, 0);
  const text = fs.readFileSync(ctx.settings, 'utf8');
  assert.match(text, /\n\t"a": \{\n\t\t"b": 1/);
  assert.ok(!/\n {2}"/.test(text));
});

test('indentation with 4 spaces is kept', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.settings, JSON.stringify({ a: { b: 1 } }, null, 4));
  assert.equal(run(ctx).status, 0);
  const text = fs.readFileSync(ctx.settings, 'utf8');
  assert.match(text, /\n {4}"a": \{\n {8}"b": 1/);
});

test('invalid JSON aborts without touching the file', () => {
  const ctx = setup();
  const bad = '{ "a": 1, ';
  fs.writeFileSync(ctx.settings, bad);
  const r = run(ctx);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(ctx.settings, 'utf8'), bad);
  assert.equal(backups(ctx).length, 0);
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'hooks')));
});

test('settings content is never printed', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { TOKEN: 'sekret-value-123' } }, null, 2));
  const r = run(ctx);
  assert.ok(!r.stdout.includes('sekret-value-123') && !r.stderr.includes('sekret-value-123'));
  fs.writeFileSync(ctx.settings, '{ "token": "sekret-value-123", ');
  const r2 = run(ctx);
  assert.ok(!r2.stdout.includes('sekret-value-123') && !r2.stderr.includes('sekret-value-123'));
});

test('--dry-run writes nothing', () => {
  const ctx = setup();
  const r = run(ctx, '--dry-run', '--with-agents');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(ctx.dir), []);
  assert.match(r.stdout, /dry-run/);
  fs.writeFileSync(ctx.settings, '{"a":1}');
  assert.equal(run(ctx, '--dry-run').status, 0);
  assert.equal(fs.readFileSync(ctx.settings, 'utf8'), '{"a":1}');
  assert.equal(backups(ctx).length, 0);
});

test('--uninstall restores the settings and removes files, keeps occam/ and agents', () => {
  const ctx = setup();
  const before = {
    model: 'x',
    hooks: {
      SessionStart: [{ hooks: [other('first')] }],
      Stop: [{ hooks: [other('stop-1')] }],
    },
    env: { A: '1' },
  };
  fs.writeFileSync(ctx.settings, JSON.stringify(before, null, 2));
  assert.equal(run(ctx, '--with-agents').status, 0);
  fs.mkdirSync(path.join(ctx.dir, 'occam'));
  fs.writeFileSync(path.join(ctx.dir, 'occam', 'config.json'), '{}');
  const r = run(ctx, '--uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJson(ctx.settings), before);
  assert.deepEqual(Object.keys(readJson(ctx.settings).hooks), ['SessionStart', 'Stop']);
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'hooks', 'occam.mjs')));
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'skills', 'occam')));
  assert.ok(fs.existsSync(path.join(ctx.dir, 'occam', 'config.json')));
  assert.ok(fs.existsSync(path.join(ctx.dir, 'agents', 'scout.md')));
  assert.match(r.stdout, /Kept/);
});

test('--uninstall drops hooks object when it ends empty', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.settings, JSON.stringify({ model: 'x' }, null, 2));
  assert.equal(run(ctx).status, 0);
  assert.equal(run(ctx, '--uninstall').status, 0);
  assert.deepEqual(readJson(ctx.settings), { model: 'x' });
});

test('--with-agents never overwrites and lists skipped files', () => {
  const ctx = setup();
  fs.mkdirSync(path.join(ctx.dir, 'agents'));
  fs.writeFileSync(path.join(ctx.dir, 'agents', 'scout.md'), 'mine\n');
  const r = run(ctx, '--with-agents');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'agents', 'scout.md'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'agents', 'reviewer.md'), 'utf8'), 'new reviewer\n');
  assert.match(r.stdout, /skipped.*scout\.md/);
});

test('a folder name with space and accent works', () => {
  const ctx = setup('tëst dir');
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  const s = readJson(ctx.settings);
  assert.ok(s.hooks.SessionStart[0].hooks[0].command.includes('tëst dir/hooks/occam.mjs'));
  assert.ok(fs.existsSync(path.join(ctx.dir, 'hooks', 'occam.mjs')));
});

test('a moved folder updates the command instead of duplicating', () => {
  const ctx = setup();
  const old = { hooks: { SessionStart: [{ hooks: [other('node "/old/place/hooks/occam.mjs"')] }] } };
  fs.writeFileSync(ctx.settings, JSON.stringify(old, null, 2));
  assert.equal(run(ctx).status, 0);
  const s = readJson(ctx.settings);
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.ok(!s.hooks.SessionStart[0].hooks[0].command.includes('/old/place'));
  assert.equal(occamCount(s), 4);
});

let ok = 0;
try {
  for (const [name, fn] of cases) {
    try {
      fn();
      ok++;
    } catch (e) {
      console.error(`FAIL: ${name}\n${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
if (process.exitCode !== 1) console.log(`${ok} cases ok`);
