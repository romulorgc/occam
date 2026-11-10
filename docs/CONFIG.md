# Configuration

occam works with no configuration. To change a default, create `occam/config.json` inside your Claude directory
(`~/.claude`, or the folder named by `OCCAM_CLAUDE_DIR`). Every key is optional. A missing file, invalid JSON or a
key with the wrong type falls back to the default for that key, with no error (inside `prices`, the fallback is per
field, see below). A leading UTF-8 byte order mark is ignored. The hook reads the file on every
event, so a change takes effect on the next prompt.

```json
{
  "opusFree": ["reviewer", "architect"],
  "capStoredEffort": "high"
}
```

## Keys

| Key | Default | What it does |
|---|---|---|
| `opusFree` | `["reviewer", "architect"]` | Agent types that may run on Opus. Elsewhere Opus becomes sonnet unless the brief carries `[opus: reason]`. |
| `fableFree` | `["architect"]` | Agent types that may run on Fable and use xhigh or max. Elsewhere Fable becomes opus (if the type is in `opusFree` or the brief has `[opus: reason]`) or sonnet, unless the brief carries `[fable: reason]`. On these types, Opus at xhigh or max becomes Fable at high. |
| `topTier` | `"architect"` | The type that receives `fable` at `medium` when the call omits model and effort. `null` turns this off. |
| `floorTypes` | `["scout", "Explore"]` | Locate-type agents: sonnet at medium or below becomes haiku, unless the brief carries `[sonnet: reason]`. A call that omits the model on a type listed in `fillDefaults` gets haiku. |
| `floorByBrief` | `["general-purpose", "claude"]` | Types that drop from sonnet to haiku only when the brief is classified as read-only. |
| `highNeedsReason` | `["general-purpose", "implementer", "scout", "Explore"]` | Types where `high` without `[high: reason]` becomes `medium`. |
| `fillDefaults` | `["general-purpose", "Explore", "Plan", "claude"]` | Types that receive `model` and `effort` (sonnet and medium, or haiku and medium for floor types and read-only briefs) when the call omits them. Without this, such calls would inherit the conversation model. |
| `prices` | see below | Cache-read price, in US$ per million tokens, by model, used by the cost line and by `measure.mjs`. |
| `callBudget` | see below | How many tool calls fit in the main conversation before the hook says to delegate. |
| `capStoredEffort` | `null` | Opt-in. See below. |

Types in `opusFree` but not in `fableFree` (the reviewer by default) have xhigh and max capped to `high`. Every other
type that is not in `fableFree` has xhigh and max lowered to `medium`, or to `high` with `[high: reason]`.

### `prices`

An object keyed by a substring of the model name (the longest matching key wins). A number is the cache-read price.
An object may carry `in`, `cw1h`, `cw5m`, `cr` and `out` (input, cache write for 1 hour and 5 minutes, cache read,
output), and a `long` object of overrides that applies above `longAbove` tokens of context (default 100000).
Entries you give merge field by field over the default of the same model key: a field you leave out keeps its default.
A field with the wrong type (not a number of at least 0) keeps that model's default for the field; if the key has no
default, that field is ignored.

```json
{ "prices": { "opus": 0.2, "haiku": { "cr": 0.01, "longAbove": 100000, "long": { "cr": 0.05 } } } }
```

Defaults for the cache-read price: haiku 0.01 (0.05 above 100K), sonnet 0.10, opus 0.20, fable 0.20. A model that
matches no key is priced at 0.20.

### `callBudget`

| Field | Default | Meaning |
|---|---|---|
| `lowBelow` | `100000` | Context below this (exclusive) gets `lowCalls`. |
| `lowCalls` | `4` | Budget below `lowBelow`. |
| `midUpTo` | `150000` | Context up to this (inclusive) gets `midCalls`. |
| `midCalls` | `3` | Budget between the two limits. |
| `highCalls` | `2` | Budget above `midUpTo`. |

### `capStoredEffort`

`/effort` stores an effort level per model in the `modelSettings` section of `settings.json`, and it stays there
across sessions. A high stored level makes every response slower and costlier.

- `null` (default): occam never writes to `settings.json`. It only adds a warning to the per-prompt line when the
  stored effort of the conversation model is `xhigh` or `max`.
- `"low"`, `"medium"`, `"high"` or `"xhigh"`: at SessionStart, any stored level above this one is lowered to it.
  Only those values change (a surgical text swap, so the rest of the file stays byte for byte identical), and the
  write is atomic (temporary file, then rename).

## Markers

A marker goes anywhere in the subagent brief, in the form `[name: reason]`. The match is case-insensitive, with
optional spaces after `[` and around `:`. The closing `]` is required, and the reason cannot be empty or a
placeholder (the single word `reason` or `motivo`, `<reason>`, or only dots). So `[opus: reason]` unlocks nothing
(a brief that quotes the hook's own swap notice stays locked), while `[opus:billing]` and `[Opus: touches billing]`
do. Beyond that the reason is for whoever reads the brief.

| Marker | Effect |
|---|---|
| `[opus: reason]` | Allows Opus on a type outside `opusFree`. |
| `[fable: reason]` | Allows Fable on a type outside `fableFree`. |
| `[high: reason]` | Allows `high` on a `highNeedsReason` type, and lets xhigh or max drop to `high` instead of `medium`. |
| `[sonnet: reason]` | Keeps Sonnet where the Haiku floor would lower it. |

The hook adds two notes itself, `[occam · reading]` (to every brief except fork) and `[occam · haiku]` (to briefs
that go to Haiku). It does not add them twice.

## Files

| Path (inside the Claude directory) | Purpose |
|---|---|
| `occam/config.json` | The optional configuration above. |
| `occam/log.jsonl` | One line per delegation: time, session, type, model, effort, what the hook filled in and what it rewrote. Never the prompt or the description. |
| `skills/occam/SKILL.md` | The rules; its body is injected at SessionStart (limit 9,500 characters in total). |
