// Tests for hooks/occam.mjs. Run: node test-hook.mjs
// Uses a temporary folder as the Claude directory (OCCAM_CLAUDE_DIR); never touches the real settings.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', '..', '..', 'hooks', 'occam.mjs');
const SKILL = path.join(here, '..', 'SKILL.md');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'occam-test-'));
const env = { ...process.env, OCCAM_CLAUDE_DIR: tmp };

function runRaw(input, args = []) {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'the hook always exits 0');
  return r.stdout;
}
function run(input) {
  const out = runRaw(input);
  return out ? JSON.parse(out) : null;
}
const readLog = () =>
  fs.readFileSync(path.join(tmp, 'occam', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const writeSettings = (o, indent) => fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(o, null, indent));
const settingsText = () => fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8');
const configFile = path.join(tmp, 'occam', 'config.json');
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, typeof c === 'string' ? c : JSON.stringify(c));
}
const clearConfig = () => fs.rmSync(configFile, { force: true });

let ok = 0;
function test(name, fn) {
  fn();
  ok++;
  console.log('ok ', name);
}

// fake transcript: a larger subagent response at the end (must be ignored), main conversation before it
const transcript = path.join(tmp, 'session.jsonl');
const resp = (model, cr, side = false) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: side,
    message: { model, usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: cr } },
  });
fs.writeFileSync(
  transcript,
  [resp('claude-opus-5-5', 100000), resp('claude-opus-5-5', 310000), resp('claude-haiku-5-5', 900000, true), '{broken'].join('\n'),
);
writeSettings({ autoCompactWindow: 250000, modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } });

test('prompt: shows main-conversation context, cost per call and call budget', () => {
  const s = run({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript, prompt: 'x' });
  const t = s.hookSpecificOutput.additionalContext;
  assert.equal(s.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(t, /^\[occam\] context ≈ 312K \(opus-5-5\)/);
  assert.match(t, /rereads ≈ \$0\.062/);
  assert.match(t, /call budget here: 2 calls/);
  assert.match(t, /automatic compaction near 250K/);
  assert.match(t, /occam skill/);
  assert.match(t, /L0 to L5/);
  assert.doesNotMatch(t, /WARNING/);
  assert.doesNotMatch(t, /conversation on Fable/);
});

test('prompt: call budget follows the context (4 below 100K, 3 up to 150K)', () => {
  for (const [cr, budget] of [
    [50000, 4],
    [120000, 3],
    [147000, 3],
    [160000, 2],
  ]) {
    const file = path.join(tmp, `ctx-${cr}.jsonl`);
    fs.writeFileSync(file, resp('claude-opus-5-5', cr));
    const t = run({ hook_event_name: 'UserPromptSubmit', transcript_path: file }).hookSpecificOutput.additionalContext;
    assert.match(t, new RegExp(`call budget here: ${budget} calls`), `context ${cr}`);
    assert.doesNotMatch(t, /automatic compaction/);
  }
});

test('prompt: conversation on Fable uses the Fable 5.2 read price and reminds to delegate', () => {
  const file = path.join(tmp, 'fable.jsonl');
  fs.writeFileSync(file, resp('claude-fable-5-2', 100000));
  const t = run({ hook_event_name: 'UserPromptSubmit', transcript_path: file }).hookSpecificOutput.additionalContext;
  assert.match(t, /context ≈ 102K \(fable-5-2\)/);
  assert.match(t, /rereads ≈ \$0\.020/);
  assert.match(t, /call budget here: 3 calls/);
  assert.match(t, /conversation on Fable/);
});

test('prompt: Haiku read price steps up above 100K of context', () => {
  const lo = path.join(tmp, 'haiku-lo.jsonl');
  const hi = path.join(tmp, 'haiku-hi.jsonl');
  fs.writeFileSync(lo, resp('claude-haiku-5-5', 50000));
  fs.writeFileSync(hi, resp('claude-haiku-5-5', 200000));
  const ask = (f) => run({ hook_event_name: 'UserPromptSubmit', transcript_path: f }).hookSpecificOutput.additionalContext;
  assert.match(ask(lo), /rereads ≈ \$0\.001/);
  assert.match(ask(hi), /rereads ≈ \$0\.010/);
});

test('prompt: new session with no transcript yet only reminds of the skill', () => {
  const s = run({ hook_event_name: 'UserPromptSubmit', transcript_path: path.join(tmp, 'missing.jsonl') });
  assert.doesNotMatch(s.hookSpecificOutput.additionalContext, /context ≈/);
  assert.match(s.hookSpecificOutput.additionalContext, /occam skill/);
});

test('prompt: warns when the conversation model has xhigh or max stored (and only that model)', () => {
  writeSettings({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-sonnet-5-5': { effortLevel: 'max' } } });
  const t = run({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript }).hookSpecificOutput.additionalContext;
  assert.match(t, /WARNING: stored effort is opus-5-5=xhigh/);
  assert.doesNotMatch(t, /sonnet-5-5=/);
  // a conversation on a model with nothing high stored gets no warning
  const file = path.join(tmp, 'sonnet-conv.jsonl');
  fs.writeFileSync(file, resp('claude-haiku-5-5', 1000));
  const t2 = run({ hook_event_name: 'UserPromptSubmit', transcript_path: file }).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(t2, /WARNING/);
  // no transcript yet: every stored model is checked
  const t3 = run({ hook_event_name: 'UserPromptSubmit' }).hookSpecificOutput.additionalContext;
  assert.match(t3, /opus-5-5=xhigh/);
  assert.match(t3, /sonnet-5-5=max/);
});

test('prompt: config prices and callBudget change the cost line', () => {
  writeSettings({});
  writeConfig({ prices: { opus: 1 }, callBudget: { lowBelow: 400000, lowCalls: 7 } });
  const t = run({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript }).hookSpecificOutput.additionalContext;
  assert.match(t, /rereads ≈ \$0\.312/);
  assert.match(t, /call budget here: 7 calls/);
  clearConfig();
});

const agent = (tool_input, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  session_id: 's1',
  tool_input,
  ...extra,
});
const outOf = (tool_input) => run(agent(tool_input))?.hookSpecificOutput;
const inputOf = (tool_input) => outOf(tool_input).updatedInput;

test('delegation: general-purpose with no model/effort gets sonnet+medium and keeps the other fields', () => {
  const s = run(agent({ description: 'd', prompt: 'p', subagent_type: 'general-purpose' }));
  const { prompt, ...rest } = s.hookSpecificOutput.updatedInput;
  assert.ok(prompt.startsWith('p\n\n[occam · reading]'));
  assert.match(prompt, /not about doing less/);
  assert.doesNotMatch(prompt, /occam · haiku/);
  assert.deepEqual(rest, { description: 'd', subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium' });
  assert.equal(s.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(s.hookSpecificOutput.additionalContext, /^\[occam\] The hook filled in this delegation: general-purpose · sonnet · medium\./);
});

test('delegation: no subagent_type counts as general-purpose', () => {
  assert.equal(run(agent({ description: 'd', prompt: 'p' })).hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('delegation: Explore gets haiku and the Haiku note', () => {
  const u = inputOf({ prompt: 'p', subagent_type: 'Explore' });
  assert.equal(u.model, 'haiku');
  assert.match(u.prompt, /occam · haiku\] At most 15 tool calls/);
});

test('delegation: explicit model and effort are untouched; only the notes are added', () => {
  const s = outOf({ prompt: 'p', subagent_type: 'general-purpose', model: 'haiku', effort: 'low' });
  assert.equal(s.updatedInput.model, 'haiku');
  assert.equal(s.updatedInput.effort, 'low');
  assert.match(s.updatedInput.prompt, /occam · reading/);
  assert.match(s.updatedInput.prompt, /occam · haiku/);
  assert.ok(!('additionalContext' in s), 'no swap and no model filled: nothing goes back to the conversation');
});

test('delegation: notes are not repeated and without a prompt nothing changes', () => {
  const already = 'p\n\n[occam · reading] x';
  assert.equal(run(agent({ prompt: already, subagent_type: 'implementer' })), null);
  assert.equal(run(agent({ subagent_type: 'implementer' })), null);
  const alreadyHaiku = already + '\n\n[occam · haiku] y';
  assert.equal(run(agent({ prompt: alreadyHaiku, subagent_type: 'general-purpose', model: 'haiku', effort: 'medium' })), null);
});

test('delegation: only effort missing fills only effort', () => {
  const u = inputOf({ prompt: 'p', subagent_type: 'Plan', model: 'sonnet' });
  assert.equal(u.model, 'sonnet');
  assert.equal(u.effort, 'medium');
});

test('delegation: fork is untouched; scout with no model gets the notes and keeps its own definition', () => {
  assert.equal(run(agent({ prompt: 'list the files', subagent_type: 'fork' })), null);
  const u = inputOf({ prompt: 'p', subagent_type: 'scout' });
  assert.ok(!('model' in u) && !('effort' in u));
  assert.match(u.prompt, /occam · reading/);
  assert.match(u.prompt, /occam · haiku/);
});

test('delegation: inside a subagent the hook does nothing', () => {
  assert.equal(run(agent({ prompt: 'p' }, { agent_id: 'a1' })), null);
});

test('delegation: the old tool name Task also works', () => {
  assert.equal(run({ ...agent({ prompt: 'p' }), tool_name: 'Task' }).hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('guard: opus outside reviewer/architect becomes sonnet; with the marker or on the reviewer it stays', () => {
  const s = outOf({ prompt: 'implement x', subagent_type: 'general-purpose', model: 'opus', effort: 'medium' });
  assert.equal(s.updatedInput.model, 'sonnet');
  assert.match(s.additionalContext, /^\[occam · swapped\] The hook changed this delegation: model opus became sonnet/);
  assert.match(s.additionalContext, /\[opus: reason\], \[fable: reason\], \[high: reason\], \[sonnet: reason\]/);
  assert.doesNotMatch(s.updatedInput.prompt, /occam · swapped/);
  assert.equal(inputOf({ prompt: 'implement x [opus: touches RLS]', subagent_type: 'general-purpose', model: 'opus', effort: 'medium' }).model, 'opus');
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'reviewer', model: 'opus', effort: 'high' }).model, 'opus');
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'Plan', model: 'opus' }).model, 'sonnet');
});

test('guard: high without a marker becomes medium; xhigh and max only on the architect', () => {
  assert.equal(inputOf({ prompt: 'implement x', subagent_type: 'implementer', model: 'sonnet', effort: 'high' }).effort, 'medium');
  assert.equal(
    inputOf({ prompt: 'implement x [high: unknown cause]', subagent_type: 'implementer', model: 'sonnet', effort: 'high' }).effort,
    'high',
  );
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'reviewer', model: 'sonnet', effort: 'xhigh' }).effort, 'high');
  assert.equal(inputOf({ prompt: 'debug x', subagent_type: 'general-purpose', model: 'sonnet', effort: 'max' }).effort, 'medium');
  assert.equal(
    inputOf({ prompt: 'debug x [high: 2nd attempt]', subagent_type: 'general-purpose', model: 'sonnet', effort: 'max' }).effort,
    'high',
  );
});

test('Fable: architect with no model gets fable at medium; explicit values stay as they came', () => {
  const s = outOf({ prompt: 'design the migration', subagent_type: 'architect' });
  assert.equal(s.updatedInput.model, 'fable');
  assert.equal(s.updatedInput.effort, 'medium');
  assert.match(s.additionalContext, /architect · fable · medium/);
  const opus = inputOf({ prompt: 'p', subagent_type: 'architect', model: 'opus', effort: 'high' });
  assert.deepEqual([opus.model, opus.effort], ['opus', 'high']);
  const fx = inputOf({ prompt: 'p', subagent_type: 'architect', model: 'fable', effort: 'xhigh' });
  assert.deepEqual([fx.model, fx.effort], ['fable', 'xhigh']);
  const fh = inputOf({ prompt: 'p', subagent_type: 'architect', model: 'fable', effort: 'high' });
  assert.deepEqual([fh.model, fh.effort], ['fable', 'high']);
});

test('Fable: Opus above high on the architect becomes fable at high', () => {
  for (const e of ['xhigh', 'max']) {
    const s = outOf({ prompt: 'p', subagent_type: 'architect', model: 'opus', effort: e });
    assert.deepEqual([s.updatedInput.model, s.updatedInput.effort], ['fable', 'high']);
    assert.match(s.additionalContext, /Opus does not go above high/);
  }
});

test('Fable: outside the architect only with the marker', () => {
  assert.equal(inputOf({ prompt: 'implement x', subagent_type: 'general-purpose', model: 'fable', effort: 'medium' }).model, 'sonnet');
  assert.equal(
    inputOf({ prompt: 'synthesize the research [fable: deep research]', subagent_type: 'general-purpose', model: 'fable', effort: 'medium' }).model,
    'fable',
  );
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'reviewer', model: 'fable', effort: 'high' }).model, 'opus');
  assert.equal(
    inputOf({ prompt: 'implement x [opus: touches billing]', subagent_type: 'general-purpose', model: 'fable', effort: 'medium' }).model,
    'opus',
  );
});

const READ_PT = 'Liste os arquivos em app/api que importam o middleware de autenticação e devolva caminho:linha, até 20 linhas.';
const READ_EN = 'List the files in app/api that import the auth middleware and return path:line, up to 20 lines.';

test('Haiku floor: sonnet on a read-only brief becomes haiku and gets the Haiku note (both languages)', () => {
  for (const brief of [READ_PT, READ_EN]) {
    const s = outOf({ prompt: brief, subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium' });
    assert.equal(s.updatedInput.model, 'haiku');
    assert.equal(s.updatedInput.effort, 'medium');
    assert.match(s.updatedInput.prompt, /occam · haiku/);
    assert.match(s.additionalContext, /became haiku \(read-only brief/);
    // high without a marker drops to medium, then falls on the floor
    const h = inputOf({ prompt: brief, subagent_type: 'general-purpose', model: 'sonnet', effort: 'high' });
    assert.deepEqual([h.model, h.effort], ['haiku', 'medium']);
  }
  // "do not edit" is not a write request
  assert.equal(inputOf({ prompt: READ_PT + ' Não edite nenhum arquivo, sem git add -A.', subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium' }).model, 'haiku');
  assert.equal(inputOf({ prompt: READ_EN + ' Do not edit any file, without git add -A.', subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium' }).model, 'haiku');
});

test('Haiku floor: with no model, a read-only brief is born on haiku', () => {
  const s = outOf({ prompt: READ_EN, subagent_type: 'general-purpose' });
  assert.deepEqual([s.updatedInput.model, s.updatedInput.effort], ['haiku', 'medium']);
  assert.match(s.additionalContext, /general-purpose · haiku · medium \(read-only brief\)/);
});

test('Haiku floor: not lowered with a marker, a write or judgment verb, justified high, or on the implementer', () => {
  const sonnet = (prompt, extra = {}) =>
    inputOf({ prompt, subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium', ...extra }).model;
  assert.equal(sonnet(READ_PT + ' [sonnet: needs to understand the flow]'), 'sonnet');
  assert.equal(sonnet(READ_EN + ' [sonnet: needs to understand the flow]'), 'sonnet');
  assert.equal(sonnet(READ_PT + ' Depois corrija os que usam a chave antiga.'), 'sonnet');
  assert.equal(sonnet(READ_EN + ' Then fix the ones that use the old key.'), 'sonnet');
  assert.equal(sonnet('Liste os pontos do fluxo de cobrança e explique por que duplica.'), 'sonnet');
  assert.equal(sonnet('List the points of the billing flow and explain why it duplicates.'), 'sonnet');
  assert.equal(sonnet('Implemente a lista de usuários em app/usuarios.'), 'sonnet');
  assert.equal(sonnet('Implement the user list in app/users.'), 'sonnet');
  assert.equal(sonnet(READ_EN + ' [high: 2nd attempt]', { effort: 'high' }), 'sonnet');
  assert.equal(inputOf({ prompt: READ_EN, subagent_type: 'implementer', model: 'sonnet', effort: 'medium' }).model, 'sonnet');
  assert.equal(inputOf({ prompt: READ_EN, subagent_type: 'Plan', model: 'sonnet', effort: 'medium' }).model, 'sonnet');
});

test('Haiku floor: locate-type agents (scout, Explore) do not run on sonnet without a marker', () => {
  for (const t of ['scout', 'Explore']) {
    assert.equal(inputOf({ prompt: 'quem chama createInvoice?', subagent_type: t, model: 'sonnet', effort: 'medium' }).model, 'haiku', t);
    assert.equal(inputOf({ prompt: 'who calls createInvoice?', subagent_type: t, model: 'sonnet', effort: 'medium' }).model, 'haiku', t);
    assert.equal(
      inputOf({ prompt: 'who calls createInvoice? [sonnet: long call tree]', subagent_type: t, model: 'sonnet', effort: 'medium' }).model,
      'sonnet',
      t,
    );
  }
});

test('read-only classifier: direct cases (Portuguese and English)', () => {
  const cases = [
    // Portuguese
    ['Liste os arquivos .mjs em hooks/ e devolva só os nomes.', true],
    ['Conte quantas rotas em app/api usam requireAuth.', true],
    ['Leia o log de ontem e extraia as linhas com ERROR, até 30.', true],
    ['Resuma o PDF em 5 linhas.', true],
    ['Onde está a função que monta o PDF da fatura? Devolva caminho:linha.', true],
    ['Find where the webhook signature is checked and list the files.', true],
    ['Localize as chamadas ao webhook de pagamento. Só leitura: não altere nem crie arquivo.', true],
    ['Liste os commits de ontem que tocaram app/api.', true],
    ['Liste os testes que falham e conserte o primeiro.', false],
    ['Leia o contexto do módulo e implemente o filtro por data.', false],
    ['Analise o log e ache a causa da queda.', false],
    ['Entenda como o ledger fecha o mês e explique.', false],
    ['Revise o diff de HEAD~2..HEAD.', false],
    ['Compare as duas abordagens e recomende uma.', false],
    ['Escreva os testes do comportamento descrito abaixo.', false],
    // goal-opening cases: the verb must OPEN the goal and the answer must be checkable
    ['Objetivo: descobrir, no código que está em produção (origin/main), o caminho exato na tela até o botão de exportar.', true],
    ['## Objetivo\nIdentificar em quais arquivos o webhook de pagamento é lido. Entrega: caminho:linha.', true],
    ['occam: L1 · general-purpose · haiku · medium\n\n**Objetivo:** listar as rotas de app/api sem requireAuth.', true],
    ['Objetivo: listar as rotas sem requireAuth.\n\nFatos: ' + 'x'.repeat(420) + ' a implementação antiga saiu na revisão de outubro.', true],
    ['Objetivo: descobrir, com prova, por que os robôs de acompanhamento nunca executam.', false],
    ['Objetivo: descobrir se as linhas inseridas pelo script de semente aparecem no relatório.', false],
    ['Objetivo: mapear o que o usuário vê depois do cadastro.', false],
    ['## Objetivo\nLevantar, com fontes oficiais e atuais, como um SaaS emite nota fiscal.', false],
    ['Objetivo: listar as rotas sem requireAuth.\n\nFatos: ' + 'x'.repeat(420) + '\n\nDepois corrija a primeira.', false],
    ['Objetivo: listar as rotas sem requireAuth.\n\nFatos: ' + 'x'.repeat(420) + '\n\nNo fim, recomende qual fechar primeiro.', false],
    ['Você é o implementador do lote L14a no projeto X. O lote faz parte da fundação; ache o ponto de entrada e siga o plano.', false],
    // English equivalents
    ['List the .mjs files under hooks/ and return only the names.', true],
    ['Count how many routes in app/api use requireAuth.', true],
    ["Read yesterday's log and extract the ERROR lines, up to 30.", true],
    ['Summarize the PDF in 5 lines.', true],
    ['Where is the function that builds the invoice PDF? Return path:line.', true],
    ['Locate the calls to the payment webhook. Read-only: do not change nor create any file.', true],
    ['List the commits from yesterday that touched app/api.', true],
    ['Who calls renderInvoice? Return path:line.', true],
    ['List the failing tests and fix the first one.', false],
    ['Read the module context and implement the date filter.', false],
    ['Analyze the log and find the cause of the outage.', false],
    ['Understand how the ledger closes the month and explain.', false],
    ['Review the diff of HEAD~2..HEAD.', false],
    ['Compare the two approaches and recommend one.', false],
    ['Write the tests for the behavior described below.', false],
    ['Objective: discover, in the code running in production (origin/main), which screens lead to the export button.', true],
    ['## Objective\nIdentify which files read the payment webhook. Delivery: path:line.', true],
    ['occam: L1 · general-purpose · haiku · medium\n\n**Objective:** list the API routes without requireAuth.', true],
    ['Objective: list the routes without requireAuth.\n\nFacts: ' + 'x'.repeat(420) + ' the old implementation was dropped in the October review.', true],
    ['Objective: discover, with proof, why the follow-up jobs never run.', false],
    ['Objective: discover whether the rows inserted by the seed script appear in the report.', false],
    ['Objective: map what the user sees after signup.', false],
    ['## Objective\nResearch how a SaaS issues invoices, with official sources.', false],
    ['Objective: list the routes without requireAuth.\n\nFacts: ' + 'x'.repeat(420) + '\n\nThen fix the first one.', false],
    ['Objective: list the routes without requireAuth.\n\nFacts: ' + 'x'.repeat(420) + '\n\nAt the end, recommend which to close first.', false],
    ['You are the implementer of batch L14a in project X. The batch is part of the foundation; find the entry point and follow the plan.', false],
    // degenerate input
    ['p', false],
    ['', false],
    [null, false],
  ];
  const out = JSON.parse(runRaw(cases.map((c) => c[0]), ['--read-only']));
  cases.forEach(([text, expected], i) => assert.equal(out[i], expected, String(text)));
  const why = JSON.parse(runRaw(['Count the routes and fix the first one.'], ['--explain']));
  assert.equal(why[0].verb, 'count');
  assert.match(why[0].asks, /^fix/);
});

test('log: each delegation becomes a line with no prompt and no description', () => {
  const r = readLog();
  assert.ok(r.length >= 8);
  for (const l of r) {
    assert.ok(!('prompt' in l) && !('description' in l));
    assert.ok(l.type && l.model && l.effort);
  }
  assert.deepEqual(r[0].filled, ['model', 'effort', 'note']);
  assert.ok(r.some((l) => l.readOnly === true && l.rewritten.includes('model:sonnet>haiku')));
  assert.ok(r.some((l) => l.rewritten.includes('model:opus>fable')));
});

test('session start: injects the skill body without frontmatter, within the size limit', () => {
  fs.mkdirSync(path.join(tmp, 'skills', 'occam'), { recursive: true });
  const real = fs.readFileSync(SKILL, 'utf8');
  fs.writeFileSync(path.join(tmp, 'skills', 'occam', 'SKILL.md'), real);
  const t = run({ hook_event_name: 'SessionStart', source: 'startup' }).hookSpecificOutput.additionalContext;
  assert.match(t, /^\[occam\] Routing rules/);
  assert.match(t, /Task level to executor/);
  assert.match(t, /fable · medium/);
  assert.doesNotMatch(t, /^name: occam/m);
  assert.ok(t.length < 10000, `injection has ${t.length} characters`);
  const body = real.replace(/^---[\s\S]*?\n---\r?\n/, '').trim();
  assert.ok(body.length <= 9000, `SKILL.md body has ${body.length} characters (limit 9000)`);
});

test('session start: without capStoredEffort settings.json is byte for byte identical', () => {
  clearConfig();
  const before = {
    model: 'opus',
    modelSettings: {
      'claude-opus-5-5': { effortLevel: 'xhigh' },
      'claude-sonnet-5-5': { effortLevel: 'medium' },
      'claude-fable-5-2': { effortLevel: 'max' },
    },
    autoCompactWindow: 250000,
  };
  writeSettings(before, 2);
  const snapshot = settingsText();
  const mtime = fs.statSync(path.join(tmp, 'settings.json')).mtimeMs;
  run({ hook_event_name: 'SessionStart', source: 'startup' });
  run({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(settingsText(), snapshot);
  assert.equal(fs.statSync(path.join(tmp, 'settings.json')).mtimeMs, mtime, 'the file was not even rewritten');
});

test('session start: capStoredEffort "high" lowers xhigh/max and preserves the rest of the file', () => {
  writeConfig({ capStoredEffort: 'high' });
  const before = {
    model: 'opus',
    modelSettings: {
      'claude-opus-5-5': { effortLevel: 'medium' },
      'claude-sonnet-5-5': { effortLevel: 'high' },
      'claude-fable-5-2': { effortLevel: 'xhigh' },
      'claude-haiku-5-5': { effortLevel: 'max' },
    },
    autoCompactWindow: 250000,
  };
  writeSettings(before, 2);
  run({ hook_event_name: 'SessionStart', source: 'startup' });
  const after = JSON.parse(JSON.stringify(before));
  after.modelSettings['claude-fable-5-2'].effortLevel = 'high';
  after.modelSettings['claude-haiku-5-5'].effortLevel = 'high';
  assert.equal(settingsText(), JSON.stringify(after, null, 2));
  // a second pass changes nothing and leaves no temporary file behind
  run({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(settingsText(), JSON.stringify(after, null, 2));
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes('.tmp-')), []);
  // other levels as the cap: medium lowers high too; the other keys are still untouched
  writeConfig({ capStoredEffort: 'medium' });
  run({ hook_event_name: 'SessionStart', source: 'startup' });
  const medium = JSON.parse(settingsText());
  assert.deepEqual(Object.values(medium.modelSettings).map((v) => v.effortLevel), ['medium', 'medium', 'medium', 'medium']);
  assert.equal(medium.autoCompactWindow, 250000);
  clearConfig();
});

test('session start: with a cap configured the prompt line warns about anything above it', () => {
  writeConfig({ capStoredEffort: 'medium' });
  writeSettings({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } });
  const t = run({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript }).hookSpecificOutput.additionalContext;
  assert.match(t, /WARNING: stored effort is opus-5-5=high, above the cap of medium/);
  clearConfig();
});

test('session start: SKILL.md too large or missing becomes a warning, not silence', () => {
  fs.writeFileSync(path.join(tmp, 'skills', 'occam', 'SKILL.md'), '---\nname: x\n---\n' + 'a'.repeat(9600));
  assert.match(run({ hook_event_name: 'SessionStart' }).hookSpecificOutput.additionalContext, /exceeded 9,500/);
  fs.rmSync(path.join(tmp, 'skills'), { recursive: true });
  assert.match(run({ hook_event_name: 'SessionStart' }).hookSpecificOutput.additionalContext, /unavailable this session/);
});

test('session start inside a subagent: no output', () => {
  assert.equal(run({ hook_event_name: 'SessionStart', agent_id: 'a1' }), null);
});

test('compaction: PreCompact returns instructions as plain text, not JSON', () => {
  for (const trigger of ['auto', 'manual']) {
    const t = runRaw({ hook_event_name: 'PreCompact', trigger, custom_instructions: '' });
    assert.ok(!t.trim().startsWith('{'));
    assert.match(t, /Preserve verbatim: every user request/);
    assert.match(t, /Preserve the proofs/);
    assert.match(t, /Discard: file contents/);
    assert.ok(t.length < 1500, `instructions have ${t.length} characters`);
  }
});

test('other tools and events: no output', () => {
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  assert.equal(run({ hook_event_name: 'Stop' }), null);
});

test('invalid input: exit 0 with no output', () => {
  assert.equal(run('this is not json'), null);
  assert.equal(run(''), null);
});

test('config: custom agent type names change the behavior', () => {
  writeConfig({
    opusFree: ['judge', 'chief'],
    fableFree: ['chief'],
    topTier: 'chief',
    floorTypes: ['finder'],
    floorByBrief: [],
    highNeedsReason: ['coder'],
    fillDefaults: ['coder', 'finder'],
  });
  // opus: free for judge, no longer for reviewer
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'judge', model: 'opus', effort: 'high' }).model, 'opus');
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'reviewer', model: 'opus', effort: 'high' }).model, 'sonnet');
  // top tier: chief gets fable at medium; architect is an ordinary type now
  const chief = outOf({ prompt: 'p', subagent_type: 'chief' });
  assert.deepEqual([chief.updatedInput.model, chief.updatedInput.effort], ['fable', 'medium']);
  const architect = inputOf({ prompt: 'p', subagent_type: 'architect' });
  assert.ok(!('model' in architect) && !('effort' in architect));
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'architect', model: 'fable', effort: 'medium' }).model, 'sonnet');
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'chief', model: 'fable', effort: 'xhigh' }).effort, 'xhigh');
  // opus above high on the free-fable type becomes fable at high
  const up = inputOf({ prompt: 'p', subagent_type: 'chief', model: 'opus', effort: 'max' });
  assert.deepEqual([up.model, up.effort], ['fable', 'high']);
  // floor types: finder is a floor type, Explore is not any more
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'finder', model: 'sonnet', effort: 'medium' }).model, 'haiku');
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'Explore', model: 'sonnet', effort: 'medium' }).model, 'sonnet');
  // floorByBrief is empty: a read-only brief on general-purpose stays on sonnet
  assert.equal(inputOf({ prompt: READ_EN, subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium' }).model, 'sonnet');
  // high needs a reason on coder, not on implementer
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'coder', model: 'sonnet', effort: 'high' }).effort, 'medium');
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'implementer', model: 'sonnet', effort: 'high' }).effort, 'high');
  // fillDefaults: coder and finder are filled; general-purpose is not
  const coder = inputOf({ prompt: 'p', subagent_type: 'coder' });
  assert.deepEqual([coder.model, coder.effort], ['sonnet', 'medium']);
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'finder' }).model, 'haiku');
  assert.ok(!('model' in inputOf({ prompt: 'p', subagent_type: 'general-purpose' })));
  clearConfig();
  // back to the defaults once the file is gone
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'reviewer', model: 'opus', effort: 'high' }).model, 'opus');
});

test('config: partial config only overrides the keys it names', () => {
  writeConfig({ opusFree: ['reviewer', 'architect', 'judge'] });
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'judge', model: 'opus', effort: 'high' }).model, 'opus');
  // untouched keys keep the defaults
  assert.equal(inputOf({ prompt: 'p', subagent_type: 'scout', model: 'sonnet', effort: 'medium' }).model, 'haiku');
  assert.equal(outOf({ prompt: 'p', subagent_type: 'architect' }).updatedInput.model, 'fable');
  clearConfig();
});

test('config: an invalid file falls back to the defaults without error', () => {
  const bad = [
    'not json {',
    '',
    '[]',
    'null',
    '"text"',
    JSON.stringify({ opusFree: 'reviewer', fableFree: [1, 2], topTier: 5, floorTypes: {}, capStoredEffort: 'banana', callBudget: [1], prices: 'cheap' }),
  ];
  for (const b of bad) {
    writeConfig(b);
    // defaults: reviewer may use opus, general-purpose may not
    assert.equal(inputOf({ prompt: 'p', subagent_type: 'reviewer', model: 'opus', effort: 'high' }).model, 'opus', b);
    assert.equal(inputOf({ prompt: 'p', subagent_type: 'general-purpose', model: 'opus', effort: 'medium' }).model, 'sonnet', b);
    assert.equal(outOf({ prompt: 'p', subagent_type: 'architect' }).updatedInput.model, 'fable', b);
    assert.equal(inputOf({ prompt: 'p', subagent_type: 'Explore', model: 'sonnet', effort: 'medium' }).model, 'haiku', b);
    // no cap is applied by an invalid capStoredEffort
    writeSettings({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } } }, 2);
    const snapshot = settingsText();
    run({ hook_event_name: 'SessionStart' });
    assert.equal(settingsText(), snapshot, b);
    const t = run({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript }).hookSpecificOutput.additionalContext;
    assert.match(t, /rereads ≈ \$0\.062/, b);
    assert.match(t, /call budget here: 2 calls/, b);
  }
  clearConfig();
});

// ---------------------------------------------------------------- review fixes

const ctxLine = (file) =>
  run({ hook_event_name: 'UserPromptSubmit', transcript_path: file }).hookSpecificOutput.additionalContext;
const GP = { subagent_type: 'general-purpose', effort: 'medium' };

test('BOM: a config.json that starts with a byte order mark is still read', () => {
  writeConfig('﻿' + JSON.stringify({ opusFree: ['general-purpose'] }));
  assert.equal(inputOf({ prompt: 'implement x', ...GP, model: 'opus' }).model, 'opus');
  clearConfig();
  assert.equal(inputOf({ prompt: 'implement x', ...GP, model: 'opus' }).model, 'sonnet');
});

test('BOM: a settings.json that starts with a byte order mark is still read', () => {
  fs.writeFileSync(
    path.join(tmp, 'settings.json'),
    '﻿' + JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }),
  );
  assert.match(ctxLine(transcript), /WARNING: stored effort is opus-5-5=xhigh/);
  writeSettings({ autoCompactWindow: 250000, modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } });
});

test('context: a usage record followed by more than 600 KB of filler still gives the context line', () => {
  const file = path.join(tmp, 'filler.jsonl');
  const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(2000) });
  fs.writeFileSync(file, [resp('claude-opus-5-5', 70000), ...Array(400).fill(filler)].join('\n'));
  assert.ok(fs.statSync(file).size > 600 * 1024);
  assert.match(ctxLine(file), /^\[occam\] context ≈ 72K \(opus-5-5\)/);
  // one huge line after the last usage record
  fs.writeFileSync(file, resp('claude-opus-5-5', 70000) + '\n' + JSON.stringify({ text: 'y'.repeat(3 * 1024 * 1024) }));
  assert.match(ctxLine(file), /context ≈ 72K/);
  // no usage record at all: same as a transcript with no usage yet
  fs.writeFileSync(file, filler + '\n' + filler);
  assert.doesNotMatch(ctxLine(file), /context ≈/);
  assert.match(ctxLine(file), /occam skill/);
});

test('read-only classifier: "search" opens a read, but searching the web does not', () => {
  const model = (prompt) => inputOf({ prompt, ...GP, model: 'sonnet' }).model;
  assert.equal(model('Search the repo for every call to fetchUser, as path:line.'), 'haiku');
  assert.equal(model('Search the web for pricing pages.'), 'sonnet');
});

test('markers: case, spaces, closing bracket, empty and placeholder reasons', () => {
  const opus = (prompt) => inputOf({ prompt, ...GP, model: 'opus' }).model;
  assert.equal(opus('implement x [opus:billing]'), 'opus');
  assert.equal(opus('implement x [Opus: touches billing]'), 'opus');
  assert.equal(opus('implement x [ OPUS : touches billing ]'), 'opus');
  for (const bad of [
    '[opus: reason]',
    '[opus: Reason]',
    '[opus: motivo]',
    '[opus: <reason>]',
    '[opus: ...]',
    '[opus: ]',
    '[opus:]',
    '[opus: touches billing',
    '[opus touches billing]',
  ])
    assert.equal(opus('implement x ' + bad), 'sonnet', bad);
  // a brief that quotes the hook's own swap notice unlocks nothing
  const notice = run(agent({ prompt: 'implement x', ...GP, model: 'opus' })).hookSpecificOutput.additionalContext;
  assert.equal(opus('implement x ' + notice), 'sonnet');
  assert.equal(inputOf({ prompt: 'implement x ' + notice, ...GP, model: 'fable' }).model, 'sonnet');
  assert.equal(inputOf({ prompt: 'implement x ' + notice, ...GP, model: 'sonnet', effort: 'high' }).effort, 'medium');
  // the same helper serves fable, high and sonnet
  assert.equal(inputOf({ prompt: 'implement x [Fable: deep research]', ...GP, model: 'fable' }).model, 'fable');
  assert.equal(inputOf({ prompt: 'implement x [high:2nd attempt]', ...GP, model: 'sonnet', effort: 'high' }).effort, 'high');
  assert.equal(inputOf({ prompt: READ_EN + ' [sonnet:long call tree]', ...GP, model: 'sonnet' }).model, 'sonnet');
  assert.equal(inputOf({ prompt: READ_EN + ' [sonnet: reason]', ...GP, model: 'sonnet' }).model, 'haiku');
});

test('prices: entries merge field by field and a bad field keeps the default of that model', () => {
  const file = path.join(tmp, 'sonnet-price.jsonl');
  fs.writeFileSync(file, resp('claude-sonnet-5-5', 100000));
  assert.match(ctxLine(file), /rereads ≈ \$0\.010/);
  writeConfig({ prices: { sonnet: { in: 3 } } }); // cr is not given: it keeps the default 0.1
  assert.match(ctxLine(file), /rereads ≈ \$0\.010/);
  writeConfig({ prices: { sonnet: { cr: 'cheap', in: 'x' } } }); // wrong type: default 0.1, not 0.20
  assert.match(ctxLine(file), /rereads ≈ \$0\.010/);
  writeConfig({ prices: { sonnet: { cr: 0.3 } } });
  assert.match(ctxLine(file), /rereads ≈ \$0\.031/);
  writeConfig({ prices: { zzz: { cr: 'bad' } } }); // no default for the key: the field is ignored, no crash
  assert.match(ctxLine(file), /rereads ≈ \$0\.010/);
  clearConfig();
});

test('measure.mjs: BOM in config.json, merge by field, wrong type falls back to the default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'occam-measure-'));
  try {
    fs.mkdirSync(path.join(dir, 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'occam'), { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 0, cache_read_input_tokens: 1e8 } },
    });
    fs.writeFileSync(path.join(dir, 'projects', 'p', 's.jsonl'), line + '\n');
    const total = (cfg) => {
      fs.writeFileSync(path.join(dir, 'occam', 'config.json'), cfg);
      const r = spawnSync(process.execPath, [path.join(here, 'measure.mjs'), '7'], {
        env: { ...process.env, OCCAM_CLAUDE_DIR: dir },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      return /US\$ ([\d.]+)/.exec(r.stdout)[1];
    };
    assert.equal(total('{}'), '10.00'); // 1e8 tokens at the default cache read of 0.1
    assert.equal(total(JSON.stringify({ prices: { sonnet: { cr: 'cheap' } } })), '10.00');
    assert.equal(total(JSON.stringify({ prices: { sonnet: { in: 3 } } })), '10.00');
    assert.equal(total('﻿' + JSON.stringify({ prices: { sonnet: { cr: 0.2 } } })), '20.00');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('permission: default is allow, ask returns ask, none omits both fields, invalid is allow', () => {
  const call = { description: 'd', prompt: 'p' };
  clearConfig();
  let o = outOf(call);
  assert.equal(o.permissionDecision, 'allow');
  assert.match(o.permissionDecisionReason, /^occam /);
  writeConfig({ permission: 'ask' });
  o = outOf(call);
  assert.equal(o.permissionDecision, 'ask');
  assert.match(o.permissionDecisionReason, /^occam /);
  assert.ok(o.updatedInput);
  writeConfig({ permission: 'none' });
  o = outOf(call);
  assert.ok(!('permissionDecision' in o));
  assert.ok(!('permissionDecisionReason' in o));
  assert.equal(o.updatedInput.model, 'sonnet');
  for (const bad of ['deny', 'ALLOW', 5, null, {}]) {
    writeConfig({ permission: bad });
    assert.equal(outOf(call).permissionDecision, 'allow');
  }
  clearConfig();
});

test('capStoredEffort keeps the file mode (POSIX) and leaves no temporary file', () => {
  writeConfig({ capStoredEffort: 'high' });
  writeSettings({ modelSettings: { 'claude-fable-5-2': { effortLevel: 'xhigh' } } }, 2);
  if (process.platform !== 'win32') fs.chmodSync(path.join(tmp, 'settings.json'), 0o600);
  run({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(settingsText(), /"high"/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(tmp, 'settings.json')).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes('.tmp-')), []);
  clearConfig();
});

test('output larger than a pipe buffer arrives whole (the hook does not exit before stdout flushes)', () => {
  // Regression: process.exit() right after the write cut the SessionStart payload near 8 KB on macOS.
  const n = 100000;
  const out = JSON.parse(runRaw(JSON.stringify(Array(n).fill('List the files.')), ['--read-only']));
  assert.equal(out.length, n);
  fs.mkdirSync(path.join(tmp, 'skills', 'occam'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'skills', 'occam', 'SKILL.md'), fs.readFileSync(SKILL, 'utf8'));
  const start = runRaw({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.ok(start.length > 8192, 'the SessionStart payload is larger than the smallest pipe buffer');
  assert.ok(JSON.parse(start).hookSpecificOutput.additionalContext.length > 8000);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ok} cases ok`);
