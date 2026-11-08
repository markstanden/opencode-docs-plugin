---
name: placement-trials
description: Run and score the behavioural placement-guidance trials (tests/fixtures/placement-cases.json) through tests/fixtures/placement-harness/harness.mts. Use for /placement, "placement trials", or when asked to evaluate the placement guidance against real model sessions.
---

# Placement trials

`tests/fixtures/placement-harness/harness.mts` runs the cases in
`tests/fixtures/placement-cases.json` (E01–E18) through real headless
OpenCode sessions against pristine fixture trees.

Subcommands: `generate` (materialise prompts to `~/tmp/docs-placement/prompts/`
and fixtures to `~/test-dir/docs-placement/`), `run` (sandboxed session per
case), `judge` (score answers against each rubric), `summary` (results table),
`export` (one `dossier.md` for a stronger reviewer), `all` (the full loop).
Per-case wrappers live in `~/tmp/docs-placement/E01.sh`…`E18.sh`.

## Models

- **Trials — the behaviour under test:** the workhorse default
  `opencode-go/deepseek-v4.1-flash`. Change it only when the Guv requests a
  model (`--model provider/model`); the trial model is the variable being
  compared, so hold it constant within a comparison.
- **Judging — the reasoning:** the **current session model**, passed
  explicitly as `--judge-model <this session's provider/model>` — but only
  when that model is free-tier; otherwise fall back to the trial's free
  workhorse tier. Judging with yourself makes the default UX sense; say
  which model judged when reporting. Judges run **host-side**
  (`node …/harness.mts judge …`): provider keys live with the host session,
  and judging reads local result artefacts, so it needs no sandbox.
- **Cost policy — free by default:** trials and judging must stay on
  free/flash-tier models unless the Guv explicitly names a paid one. The
  strong-model pass is always deliberate: `--judge-model <paid model>`, or
  the exported `dossier.md` handed to an external frontier account.
- **Deep scan:** `export` writes `results/<stamp>/dossier.md`; hand it to a
  frontier model (in OpenCode or external) when the Guv wants a second,
  stronger opinion on a whole sweep.

## Running

- Trials run in the **trial container** (`tests/fixtures/placement-harness/container-run.sh`):
  Debian slim, Node LTS, the current `@opencode/cli`, a read-only root
  filesystem and the repo mounted read-only — only prompts, fixtures and
  results are writable, and provider routing passes through from the host
  environment at runtime. Nothing about this machine is baked into the repo.
- One case: `container-run.sh run E01 --judge-model <session model>`
  (wrappers: `~/tmp/docs-placement/E01.sh`).
- A sweep: `container-run.sh all`. Eighteen trials plus judging costs real
  minutes and tokens — ask before starting one.
- Host invocation (`node …/harness.mts …`) works for development, but fixture
  configs embed the plugin path from generation time — generate and run from
  the same environment, or regenerate (`generate --force`) when switching.
- Name stamps for comparisons: `--stamp <plugin-version-or-topic>`; diff
  `summary.md` across stamps rather than trusting a single cell.
- Trials are sandboxed: the container mount is the boundary, and the session
  is configured to deny shell, edits and external reads on top — but trails
  have shown those denials are not guaranteed, and no rubric ever enters the
  sandbox. Check the `Exposure` column in `summary.md` rather than trusting
  the permission set. Do not weaken any of it to make a case pass;
  regenerate fixtures (`generate --force`) only when the fixture JSON or
  sandbox policy genuinely changed.

## Tool-availability diagnostic

`tests/fixtures/diagnostic-cases.json` (A01) is a report-only probe through
the same child path. Point `PLACEMENT_CASES` at it, generate, then run `A01`;
it is never semantically judged. `summary.md` and the dossier render separate
registration, advertisement, dispatch, help-result and observability facts,
plus invocation/timestamps. A host that exposes the first request's tool
definitions can save them as `tool-definitions.json` in the result directory;
without that capture, advertisement is unknown and a model's inventory answer
is supporting evidence only. Code Mode wrapper completion is never counted as
verified docs use. This is not a behavioural gate for the other cases.

## Reading results

- `summary.md` per stamp: verdict, destination, writes, docs-tool call count,
  and the trail `Exposure` classification (guidance / case list / rubric-case
  / repo cases).
- `writes.txt` must say `none`; anything else is a trial-integrity finding
  before it is a guidance finding.
- Borderline cases (E05, E07, E16) flicker between sweeps — the model is the
  uncontrolled variable; compare distributions, not single runs.
- A guidance wording that keeps failing is durable knowledge: record it under
  `docs/` at the narrowest scope, with the stamp that showed it.
