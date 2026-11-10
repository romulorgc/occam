---
name: occam
description: Use on every task that reaches the main conversation, before the first tool call, to classify the task level and decide who executes it (the conversation itself, or a Haiku 5.5, Sonnet 5.5, Opus 5.5 or Fable 5.2 subagent) and at what effort. Also use when the user asks to save tokens, to use Haiku, Sonnet or Fable, or asks how much is being spent (/occam measure).
---

# Occam: who executes each task

**If you are a subagent, ignore this skill and do your job.**

**Savings cut waste, never quality.** What gets cut is context that enters and is reread without helping. The quality
of what ships comes from the **reviewer and the tests** (verification is never cut), not from raising the executor
"just in case". Count cost per finished task, not per token.

In the main conversation the expensive part is the context, more than the model: every tool call here rereads the
whole conversation, and everything that enters stays reread until compaction. A subagent starts clean.

## 1. Classify before the first tool call
Silently give the task a level (L0 to L5, section 4) and count the calls it needs **here**. On every prompt, the hook reports the context size, the cost per call and the call budget. Only when delegating, write one line:
`occam: L<level> · <executor> · <model> · <effort> · <short reason>` Skip the line when you are not delegating. Delegating itself costs a call, plus the subagent.

## 2. Do it yourself when
- the answer is already in context, or the request is conversation, a decision or a plan;
- it fits the hook's call budget (4 calls below 100K of context, 3 up to 150K, 2 above) with short output:
  `| head -40`, `--stat`, `grep -c`;
- it is a spot edit in a file you already read;
- it is judgment that stays with you: decisions, architecture, security review,
  checking the delivery, and anything that needs credentials or sensitive data.

## 3. Delegate when
- the task passes the budget, or reads a lot to return little (repo, log, PDF, docs, web, transcripts);
- it is code or tests in volume;
- the "quick edit" became the third in a row: it is a batch.

## 4. Task level to executor
| Level | The task is | subagent_type | model · effort |
|---|---|---|---|
| L0 | Format, convert, rename, no search | general-purpose | haiku · low |
| L1 | Locate, list, count, extract a literal fact, summarize (repo, log, PDF, page, command output) | scout (read-only) or general-purpose | haiku · medium |
| L2 | Understand code; apply a decided pattern across N files; tests for a defined behavior; mechanical refactor; browser journey; collect web research; code touching money, scheduling, sensitive records or an integration (the reviewer checks after) | general-purpose | sonnet · medium |
| L3 | Debug an unknown cause; test and verify; 2nd attempt; synthesize research | general-purpose | sonnet · high, with `[high: reason]` |
| L4 | Review a diff before main | reviewer | sonnet · high (opus if it touches money, security, access policies or sensitive records) |
| L5 | Architecture; real trade-off; bug that resisted 2 attempts; data migration; race condition; large refactor | architect | fable · medium; high if medium was not enough |

- **Fable 5.2** is the top step and enters through the architect (read-only: it returns the plan, Sonnet executes).
  It costs 2× Opus per token, but at high it ties Opus at max for half the cost; xhigh on Opus adds 1.4 points for
  2.5× the cost. So **Opus never goes above high**: the next step is Fable medium. No Fable quota: architect with
  `model: opus`, `effort: high`.
- Main conversation: Opus 5.5 at high coordinates. When the user turns Fable on here, it plans, decides and checks;
  heavy reading and bulk writing go to a subagent.
- One subagent at a time by default: parallel agents multiply spend; fan out only when the user asks.

## 5. The hook checks and corrects the Agent call
Pass `model` and `effort` from the table. Whatever the hook swaps comes back to you on an `[occam · swapped]` line and
goes to the log (`/occam measure`). Fork is left untouched. The type names below are the defaults; the user can
rename them in `occam/config.json`.
- **Missing `model`/`effort`:** architect gets fable · medium; general-purpose, Explore, Plan and claude get
  sonnet · medium, or haiku · medium if the brief is read-only (Explore: always haiku).
- **Haiku floor:** sonnet at medium or below becomes haiku on scout and Explore, and on general-purpose and claude when
  the brief is read-only: the goal OPENS with locate, list, count, extract, summarize, search or find (or
  discover/identify where, which, how many), asks for no judgment (analyze, review, compare, why, cause, prove, test,
  understand, explain), and the whole brief asks for no writing or web research ("do not edit" does not count).
  Haiku gets what comes back checkable: path:line, a count, a list. Keep Sonnet with `[sonnet: reason]`.
- **Opus** outside reviewer and architect becomes sonnet, unless `[opus: reason]`.
- **Fable** outside the architect becomes opus (reviewer) or sonnet, unless `[fable: reason]`.
- **high** on general-purpose, implementer, scout and Explore becomes medium, unless `[high: reason]`.
- **xhigh and max** are allowed only on the architect running Fable, with the reason on the `occam:` line.
  With Opus they become fable · high; on other types, high with `[high: reason]`, else medium.

## 6. The brief (the subagent does not see this conversation)
In this order:
1. **Goal**, in one sentence that opens with the task verb (the hook reads it).
2. **Facts** you already have: paths, lines, decisions, what was ruled out. Do not make it rediscover.
3. **Delivery**, with format and cap: "table of up to 10 rows", "path:line", "up to 300 words". A long answer comes
   back into your expensive context.
4. **Done when**: the mechanical check (command, test, count) it runs before saying "done".
5. **Limits**: no secrets or `.env` contents, and nothing destructive that the task did not ask for.

The hook appends to every brief (except fork) the reading note: open by slice, filter output, do not reopen, do the
whole task. On a Haiku brief it adds: at most 15 calls, and say in the first line if the task needs more than reading
(then repeat on sonnet · medium). Multi-step task: one subagent per step, checking between them.

## 7. Go up only on a verified failure
Check the delivery with the real thing (tsc, a test, a grep of the result); a report is not proof. Failed? In order:
1. could the executor check its own work (test, build, script)? If not, give it that and repeat;
2. raise the effort one step;
3. raise the model, starting at lower effort: haiku → sonnet medium → sonnet high → fable medium → fable high.

Put what the failed attempt taught you into the next brief. Two failures on the same step: go up. Never start on the expensive step
"just in case", for any task: the reviewer and the tests catch what slips through.

## 8. Watch who is working
Do not hand off and walk away. After sending a subagent or background task, do not just wait for the end notice.
- In the same reply as the Agent call, arm `Monitor` with `bash ~/.claude/skills/occam/scripts/watch.sh <repo>
  [extra-dir] [idle-min]` and `timeout_ms: 1800000`. It looks only at outside signals (commit, branch, touched
  file) every 3 minutes and reports a new commit, a branch change, or nothing touched for 10 minutes. If the monitor expires while the agent is still running, rearm it. Agent finished: `TaskStop` its watcher before arming the next.
- Notice arrived: one short call (`git log --oneline`, `git diff --stat`). Drift or idle: correct at once with
  SendMessage. New commit: one-line progress note to the user. Never read the subagent transcript or poll in a loop.

## 9. Small context and compaction
- A whole file, log, JSON or HTML does not enter here; exploratory reading belongs to the subagent. Do not reread
  what a subagent already summarized.
- Do not switch the conversation model: it zeroes the cache and rewrites the conversation at the new price.
- The PreCompact hook tells the summary to keep requests, decisions, pending items, paths, commits and proofs, and to
  drop raw output. What must survive goes in your reply or in a file; what exists only in tool output is lost.
- End of a topic above ~200K, with the user present: suggest `/compact <what to keep>` or `/clear`.

## 10. Measure
`/occam measure`: run `node ~/.claude/skills/occam/scripts/measure.mjs 7` (or another number of days) and show the
cost per thread and model, the average context, the delegations and what the hook swapped.

## Excuses that cost money
| Excuse | Reality |
|---|---|
| "Sonnet just in case" to extract or count | That is Haiku work (2 to 12% of Opus price). Go up only if it fails. |
| "It's just one more read" (the 3rd, the 4th...) | Each one rereads the whole conversation and stays in context. Past the budget, delegate. |
| "I'll delegate to save" a 1-call task | The Agent call already costs the same as doing it. Do it yourself. |
| "Debugging at medium" | An unknown cause is high. |
| "Opus at xhigh will solve it" | Measured: +1.4 points for 2.5× the cost. The next step is Fable medium. |
| "Lower the model for what ships" | Rework costs more. Cut context, and never cut the reviewer. |
