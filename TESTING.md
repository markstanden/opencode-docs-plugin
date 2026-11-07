# Testing

This repository is tested on two layers, answering two different questions:

1. **Contract tests** — does the plugin _do_ what it promises? Node's built-in
   test runner pins the tool, command and skill behaviour: ranking, write
   contracts, refusals, concurrency, lake resolution.
2. **Behavioural placement trials** — does a _model_ _follow_ the placement
   guidance the plugin ships? Real headless OpenCode sessions answer synthetic
   placement cases; a fixture asserting expected answers in Node cannot prove
   that.

## Quick start

```sh
npm install
npm test                      # contract suite
npm run typecheck
defined comply                # the gate: lint, typecheck, tests, coverage
tests/fixtures/placement-harness/container-run.sh run E01   # one behavioural trial
tests/fixtures/placement-harness/container-run.sh all       # full sweep
```

## Contract tests

```sh
npm test          # node --test
npm run typecheck # tsc --noEmit
npm run test:coverage
defined comply    # bootstrap, repair and verify in one pass
```

Conventions (kept so the file OpenCode loads is the file under test):

- Node's built-in runner, assertions from `node:assert/strict`.
- The plugin source runs under Node's type-stripping (`noEmit`,
  `erasableSyntaxOnly`) — no build step, no mirror to drift.
- `tests/docs.test.ts` imports the plugin statically, so the tests are
  typechecked too.
- `tests/fixtures/docs-corpus.json` is a hand-authored synthetic corpus for
  the ranking harness — invent paths and summaries, never snapshot a real
  docs tree.
- Every bug fix ships a test that fails against the pre-fix code.

Run `defined comply` after a coherent batch of edits and before proposing a
commit; its JSON verdict is authoritative, and repairs it makes are real
working-tree changes.

## Behavioural placement trials

`tests/fixtures/placement-cases.json` holds seventeen cases (E01–E17): each
has a claim, evidence, the available destinations, an expected scope or
action, acceptable rationale, and tempting wrong answers. The guidance text
these cases evaluate lives in the registered `docs` skill and
`CONVENTION.md`; when guidance wording changes, rerun the trials.

### The harness

`tests/fixtures/placement-harness/harness.mjs` materialises and runs the
trials:

| Subcommand | What it does                                                      |
| ---------- | ----------------------------------------------------------------- |
| `generate` | Write one prompt per case and one pristine fixture tree per case  |
| `run`      | Copy a fixture into a stamped results dir, run a headless session |
| `judge`    | Score each recorded answer against its rubric (second model call) |
| `summary`  | Render the per-stamp results table                                |
| `export`   | Bundle a sweep into one `dossier.md` for an external deep review  |
| `all`      | generate → run → judge → summary → export                         |

Common flags: `--model` (trial model), `--judge-model` (judge model),
`--stamp` (result label — name sweeps by plugin version or topic),
`--prompts/--fixtures/--results` (output roots).

### The container

`container-run.sh` runs the harness inside the trial container
(`Containerfile`): Debian slim, Node LTS, the current `@opencode/cli`
installed at build time so trials test what users run. The root filesystem is
run at build time so trials test what users run. The root filesystem is
read-only; the repository mounts read-only and only prompts, fixtures and
results are writable, so a wandering model has nothing of yours to find. The
container shares the host network namespace, so provider traffic uses the
host's loopback proxy overlay unchanged — no routes or credentials live in
this repository.

Default output roots (overridable with `PLACEMENT_PROMPTS`,
`PLACEMENT_FIXTURES`, `PLACEMENT_RESULTS`): prompts and results under
`~/tmp/docs-placement/`, fixtures under `~/test-dir/docs-placement/`.

The harness can also run directly on the host for development, but fixture
configs embed the plugin path from generation time — generate and run from
the same environment, or `generate --force` when switching.

### Models

Trials are the behaviour under test: they use the workhorse default
(`opencode-go/deepseek-v4.1-flash`, a free/flash-tier first-party model) and
stay constant within a comparison. Judging is the reasoning: pass
`--judge-model` with a stronger model — the `/placement` command and
`placement-trials` skill default it to the current session model when that
model is free-tier, otherwise the free workhorse tier. Judges run host-side,
because provider keys live with the host session; trials need no keys at
all, which is why they run in the container.

**Cost policy: free by default.** Trials and judging stay on free/flash-tier
models; a paid model enters only when someone names it explicitly
(`--judge-model <paid>`) or takes the exported `dossier.md` to an external
frontier account. Strong-model review is always a deliberate act.

### What a run produces

Per case, under `results/<stamp>/<case>/`:

- `final.md` — the trial model's answer; `tools.jsonl` — its tool trail
  (counting docs-tool calls is part of scoring); `writes.txt` — files added
  or removed (must say `none`); `prompt.md`, `rubric.md`, `case.json`,
  `meta.json` (model, CLI version, timing), `exit-code`, `live/` (the exact
  sandbox that ran); plus `verdict.json` once judged and a `judge/` trail.
- Per sweep: `summary.md` and `dossier.md`.

### Sandbox guarantees

Trials judge placement from the supplied finding, so the session gets no
shell, no edits and no reads outside the workspace (the `docs` tool serves
the lakes itself), and the rubric is never inside the sandbox. The container
is the physical boundary and the reason trials stay controlled; the
permission rules are defence in depth and have proven unreliable to enforce
in every run context, so do not rely on them — and treat host-side trial
runs as development, never as the safety mechanism.

### Reading results

Treat a sweep as a sample, not a verdict: sampling means borderline cases
(E05, E07, E16 are judgement-heavy) flicker between sweeps. Compare
distributions across stamps; a single red cell is a question, not a finding.
`writes.txt` saying anything but `none` is a trial-integrity issue before it
is a guidance issue. A guidance wording that keeps failing is durable
knowledge — record it under `docs/` at the narrowest scope, with the stamp
that showed it.

### Fixture notes

- E11 configures two personal lakes; E17 nests a repo lake inside a wider
  repo lake with an unrelated personal lake beside it; E06 and E17 get small
  code-shaped work trees matching their evidence.
- E13 and E16 list no repository destination, so their fixtures pin a
  read-only placeholder at `work/docs`: the plugin otherwise adds an implicit
  _writable_ repo lake at `<location>/docs`, which would offer a destination
  the case does not list.

## Where the workflow lives

In this repository, `/placement` (implemented by
`.opencode/commands/placement.md`, workflow in
`.opencode/skills/placement-trials/SKILL.md`) drives everything above,
including the model policy and the ask-before-a-full-sweep rule.
