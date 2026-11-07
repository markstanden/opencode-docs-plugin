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
| `generate` | Write prompts, pristine fixture trees and out-of-band rubrics     |
| `run`      | Copy one case into a stamped results dir, run an isolated session |
| `judge`    | Score each recorded answer against its rubric (second model call) |
| `summary`  | Render the per-stamp results table                                |
| `export`   | Bundle a sweep into one `dossier.md` for an external deep review  |
| `all`      | generate → run → judge → summary → export                         |

Common flags: `--model` (trial model), `--judge-model` (judge model),
`--stamp` (result label — name sweeps by plugin version or topic),
`--prompts/--fixtures/--rubrics/--results` (output roots), `--allow-writes`
(judge a run that changed files; decision-only trials must leave
`writes: none`). `TRIAL_TIMEOUT_MS` bounds each model call (default ten
minutes).

### The container

`container-run.sh` runs the harness inside the trial container
(`Containerfile`): Debian slim, Node LTS, the current `@opencode/cli`
installed at build time so trials test what users run. The root filesystem is
read-only. `generate` mounts the repository read-only and writes prompts,
fixtures and rubrics; `run` starts **one container per case**, mounting only a
curated plugin package (`package.json`, `src`, `node_modules`), that case's
sandbox, its prompt and its result directory. Rubrics and case JSON are
copied into the result only after the container exits, so a trial cannot read
its own or another case's expectations. The container shares the host network
namespace, so provider traffic uses the host's loopback proxy overlay
unchanged — no routes or credentials live in this repository.

Default output roots (overridable with `PLACEMENT_PROMPTS`,
`PLACEMENT_FIXTURES`, `PLACEMENT_RUBRICS`, `PLACEMENT_RESULTS`,
`PLACEMENT_RUN_FIXTURES`): prompts, rubrics and results under
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

### Trial runs and results

Runs live outside the repository (per-user results roots); this section is
the scoping record so sweeps stay comparable.

A stamp is immutable evidence: rerunning a case into an existing stamp is
refused, so a comparison always gets a fresh stamp. Every judge attempt is
stored separately under `judge/attempt-NNN/` with the answer hash, rubric
hash, judge model and timings; the top-level `verdict.json` is only a pointer
to the latest attempt. Judging refuses an incomplete run — missing answer,
non-zero exit, or writes in a decision-only trial — and records `invalid`
without calling the judge model. Preserve every judge's verdict by keeping the
attempt directories, which are never overwritten.

| Stamp     | Date       | Trial model                       | Setup                                                                                                                          | Judges and result                                                                    |
| --------- | ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `sweep-1` | 2026-11-07 | `opencode-go/deepseek-v4.1-flash` | decision-only prompts; `docs` skill present in the sessions; zero docs-tool calls; zero writes; plugin 0.12.0 (main `f5a5882`) | workhorse judge 14/17; `zai-coding-plan/glm-5.3-flash` (host, current session) 17/17 |

sweep-1 notes: the three workhorse-judge failures (E06, E09, E16) are all
judge-disagreement cases resolved by manual review of the raw answers —
E09 is a fixture defect (reusing an existing organisation policy page is
correct, so the expected "linked: Organisation + Repository" overstates the
requirement), E06 exposes a rubric gap (the stated destination and the
operative action must agree), and E16 is genuinely borderline (focused
questions were asked, but a destination was still named). Guidance prose was
not changed on the strength of this sweep.

### What a run produces

Per case, under `results/<stamp>/<case>/`:

- `final.md` — the trial model's answer; `tools.jsonl` — its tool trail
  (counting docs-tool calls is part of scoring); `writes.txt` — files added,
  modified or removed, detected by content hash (must say `none` for a
  decision-only trial); `prompt.md`, `rubric.md`, `case.json`, `meta.json`
  (model, CLI, image, fixture and plugin hashes, args, answer hash, timing),
  `exit-code`, `live/` (the exact sandbox that ran); plus `verdict.json` and a
  `judge/attempt-NNN/` trail once judged.
- Per sweep: `summary.md`, `dossier.md` and the provenance-bearing
  `manifest.json` under the fixture root.

### Sandbox guarantees

Trials judge placement from the supplied finding, so the session gets no
shell, no edits and no reads outside the workspace (the `docs` tool serves
the lakes itself). A run container mounts only the current case's sandbox,
prompt and result directory plus a curated plugin package; rubrics, case JSON
and every other case's results are outside its mount namespace. The rubric
and case are copied into the result only after the container exits. The
container is the physical boundary and the reason trials stay controlled; the
permission rules are defence in depth and have proven unreliable to enforce
in every run context, so do not rely on them — and treat host-side trial runs
as development, never as the safety mechanism.

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
