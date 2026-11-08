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

`tests/fixtures/placement-cases.json` holds eighteen cases (E01–E18): each
has a claim, evidence, the available destinations, an expected scope or
action, acceptable rationale, and tempting wrong answers. The guidance text
these cases evaluate lives in the registered `docs` skill and
`CONVENTION.md`; when guidance wording changes, rerun the trials.

### The harness

`tests/fixtures/placement-harness/harness.mts` materialises and runs the
trials:

| Subcommand | What it does                                                      |
| ---------- | ----------------------------------------------------------------- |
| `generate` | Write prompts, pristine fixture trees and out-of-band rubrics     |
| `run`      | Copy one case into a stamped results dir, run an isolated session |
| `judge`    | Score each recorded answer against its rubric (second model call) |
| `summary`  | Render the per-stamp results table                                |
| `export`   | Bundle a sweep into one `dossier.md` for an external deep review  |
| `describe` | Write the stamp's immutable run description once (host-side)      |
| `all`      | generate → run → judge → summary → export                         |

Common flags: `--model` (trial model), `--judge-model` (judge model),
`--stamp` (result label — name sweeps by plugin version or topic),
`--fixture FILE` (the case corpus: the single source for generation,
selection, the redacted run list, the frozen run description and
rendering — `all` phases must share one corpus; the wrapper mounts it at
one stable path), `--prompts/--fixtures/--rubrics/--results` (output
roots), `--plugin` (the plugin package the trials load),
`--opencode` (the CLI binary), `--jobs` and `--judge-jobs` (bounded
worker counts for trials and judging respectively; `1` = serial default),
`--allow-writes` (legacy baseline only: judge a decision-only run that
changed files — a case with its own mutation policy is never widened by
this flag; out-of-policy writes invalidate regardless), `--discovery`
(the discovery variant: prompts carry no destinations, so lakes are
reachable only through `docs help`; the summary gains a `Discovery`
column measuring help use per case, kept separate from the placement
verdict). `TRIAL_TIMEOUT_MS` bounds each model call (default ten
minutes); `TRIAL_JOBS`/`TRIAL_JUDGE_JOBS` default the worker counts.

A stamp is one immutable experiment. `judge`, `summary` and `export`
either take an explicit `--stamp` or resolve the most recently CREATED
run (from the stamp's frozen `run.json`, else directory mtime for legacy
evidence) — never lexicographic name order, so arbitrary stamp names are
safe. A missing results root, an empty root or an unknown stamp name fail
loudly with the path in the message.

### Frozen provenance

Every `run`/`all` first freezes `results/<stamp>/run.json` (`describe`
behaves identically): written atomically, a versioned schema-v2 description
recording the selected case ids and their full definitions, the model and
variant, the timeout, the trials' execution boundary (`trialBoundary` —
the wrapper passes the trial container image/id to it, so a containerised
sweep is described as one), the host orchestration identity
(`orchestration`: fixture/plugin content hashes, lockfile hash, plugin
commit and dirty state, CLI version — of the _describing_ process), each
case's criteria (`mutationPolicy`, `docsCriterion`, `expectedDocs`) and the
harness version. Re-invoking `run` on an existing stamp verifies the whole
identity — corpus edits, a different plugin or changed settings refuse
instead of relabelling; inside a staged container the per-case `frozen.json`
freeze receipt proves the host freeze (the description itself is never
mounted into a case). The record is validated at its boundary: each frozen
v2 case definition must be a complete full case (same validator as corpus
input), each nested consumed field must be well-formed, and a legacy v1
record is validated for what is present without v2-only demands — a v1
record without usable definitions refuses judging explicitly.

`summary` and `export` render ONLY from that saved description and the
per-case artefacts: run a reporting command today against yesterday's stamp
and yesterday's model, variant, expected labels and case selection come
back intact. A stamp without `run.json` (pre-freeze legacy evidence)
renders with visible `unknown (legacy)` labels instead of silently adopting
current inputs; mixed evidence renders a per-case `[model: …]` suffix.
Rendering time is always shown apart from run time.

### Judging answers the frozen experiment

`judge` scores each case against the SAVED run.json definitions: selection,
policy, docs criterion and recorded-rubric identity all come from the
stamp, never from the reporting CLI's current corpus — a corpus edit cannot
change a historical grade. Before any semantic judge call the harness
verifies the recorded identity: an edited `final.md` (answer hash mismatch)
or an edited `rubric.md` (does not match the saved definition's own
deterministic rubric) is refused as altered evidence, not adopted. Explicit
case ids must belong to the experiment. Legacy stamps without run.json warn
openly and use the current corpus (a documented limitation, not a pass).

### Generation fingerprints

`generate` (and `describe`) validate the corpus in FULL mode at their
command boundary: an entry missing the claim/evidence/destinations/
accepts/temptingWrong a prompt renders from is refused with its case name
and the missing field, instead of being silently filtered into an
incomplete selected set. The redacted container staging list keeps its
own validated shared shape.

`generate` records a `generation.json` fingerprint per case — a hash over
the case definition, the model, the plugin identity, the variant flags
and the generator version — the identity of the outputs it wrote
(prompt/config/rubric hashes), and a prepared-tree certificate: a
deterministic identity of every generated sandbox file (relative path,
kind, content hash or symlink target; no timestamps, no modes, `.git`
excluded). Reuse requires a matching fingerprint AND intact outputs AND an
unmutated prepared tree; anything else refuses with `stale` or
`incomplete` and points at `--force`, leaving the recorded fixtures
untouched. A `run` never regenerates: it validates the prepared
generation — output hashes, the recomputed inputs fingerprint on full
corpus flows (a changed case, model, plugin or variant refuses rather than
executing the stale prompt), the redacted corpus's embedded generation
hash in container flows, and the tree certificate (an edited seed, a
missing file or an added stray refuses the run) — so a mid-run corpus or
fixture edit can never silently rewrite a shared fixture.

### Mutation policy

The write-detection snapshot covers `work`, `lakes` and `config-home`
with lstat: regular-file contents, directories (including permission
bits), symlink targets, kind changes (a file replaced by a link) and
permission-only changes (`chmod` with no content change is a modification,
labelled `(mode)`). An unreadable directory is recorded as an explicit
`dir-unreadable` entry — never silently documented as an empty, readable
inventory. Git-state changes reported separately NEVER count as trial
writes. The snapshot proves final-state changes only — a transient write
that reverts is invisible without execution instrumentation — and the run
records a final-state digest that judging re-verifies, so mutation
evidence edited after the run is refused rather than graded. The `Writes`
column reports structured counts (`N file(s) + M violation(s)`); each case
may declare an explicit `mutationPolicy` (allowed path globs plus optional
`runtimeAllow` for genuine CLI-owned state). A policy-bearing case with
out-of-policy writes is invalid for judging even with `--allow-writes`;
`--allow-writes` only widens the legacy decision-only baseline, which is
otherwise any-write-is-a-failure.

### Recording reproducibility (`expectedDocs`)

`minWrites` counts mutations, not knowledge, so recording cases can also
declare `expectedDocs` — the deterministic gate the semantic judge sees
behind: the expected create/replace target, structural validity of the
produced doc (front-matter Area/Keywords/Summary, an H1, a claim section),
required and absent content (`retains`/`omits` — lost unrelated claims or
surviving stale claims fail), required references (`link`), untouched
preservation paths (`preserve`), and a single-document surface rule. An
empty directory, a junk or non-Markdown file, a wrong target, an
unrelated in-policy edit, or deleting the target cannot satisfy a
recording case. The gate also includes bounded excerpts of the verified
artefacts in the judge prompt (clearly marked as truncated, with the
recorded tree stated authoritative). Definitions without `expectedDocs`
skip the gate — a stated limitation of those recorded runs, never
rendered as verified.

### Telemetry and verdict gating

The trail (`tools.jsonl`) is deduplicated by the CLI's call id (one
operation, several events). The `Docs` column separates native `docs`
calls, the twin registration name `docs_search`, and Code Mode `execute`
calls whose code attempts `tools.docs.docs_search(…)` — a nested attempt
is counted as attempted, never as a verified nested execution, because
the CLI emits no separate event for it. Discoverable help use is likewise
reported as verified completions apart from attempts (`no help (N
attempted)`); dead code mentioning the tool proves nothing.

Docs criteria are deterministic and answer to two pinned semantics, keyed
by which field the SAVED definition uses:

- `minVerifiedCalls` (current): a floor on SUCCESSFUL observable docs
  operations. A read proves success through the plugin's own result
  envelope (`metadata.read` — the retrieved document's address; wiki
  reads carry it without a revision token) or, in older trails without
  the envelope, trailing revision text in the complete pre-truncation
  output; a completed refusal, not-found, blank or failed call counts as
  an attempt only, as does a code-mode attempt. Required verbs must have
  one successful operation; `paths` narrows to read targets — only a
  typed read of the required fragment that successfully retrieved it
  counts. An unmet floor reports every unmet path alongside it rather
  than hiding the detail. Code-mode-only attempts render the case
  INCONCLUSIVE at the gate — recorded as `invalid` with the reason (the
  nested operation is unobservable; the case needs either native/twin
  usage or an honest unknown), never a pass, never silently dropped.
- `minDocsCalls` (legacy, for stamps recorded before this change): the
  historical attempted-operations semantics, applied to the frozen
  definition as recorded, with `(legacy attempted-operations)` visibly
  labelled in the refusal — old evidence keeps its meaning rather than
  being quietly regraded today.

A completed trial answer must be real completion evidence: the process
exits 0 with no signal, no triggered timeout (a timeout fails regardless
of the final exit code, with SIGTERM escalating to SIGKILL after a short
grace so an ignoring child cannot hold the harness), no stdout overflow
past the capture limit (recorded as `outputOverflow`, invalidating
incomplete evidence), no unparsable output lines, a nonblank answer, and
a trail that ends on its final text part — a mid-turn tool echo is not a
completed answer. Judge success requires the same process discipline plus
a complete, valid verdict object; a failed judge becomes a visible
`judge-error` verdict and never a pass. Historical zero-native-call
stamps remain measurement limitations about Code Mode, not established
events. A stamp's rows may carry a `[model: …]` suffix where evidence
contradicts the stamp's own model.

### Schedules

- **Smoke**: one case per family of interest, once. Cost-bounded;
  observation, not a verdict.
- **Relevant family**: every case in one family (e.g. the recording
  family) across a pair of agreeable revisions.
- **Full comparison**: E01–E18 across two named revisions, judged.

A skipped family must be visible: `summary.md` renders rows from the
stamp's frozen case list, so an un-run expected case appears as `not
run`, and the results root keeps each per-case directory findingable
even when an artefact is missing.

### The container

`container-run.sh` runs the harness inside the trial container
(`Containerfile`): Debian slim, Node LTS, the current `@opencode/cli`
installed at build time so trials test what users run. The root filesystem is
read-only. `generate` mounts the repository read-only and writes prompts,
fixtures and rubrics; `run` starts **one container per case, serially** —
`--jobs` above 1 is refused by the wrapper with a clear message (worker
pools are a host/direct-harness feature; container parallelism is not
built) — mounting only a curated plugin package (`package.json`, `src`,
`node_modules`, `CONVENTION.md`), that case's sandbox, its prompt, an
id-only case list and its result directory. Rubrics and case JSON are
copied into the result only after the container exits, so a trial cannot
read its own or another case's expectations; the case list it does see
carries ids plus the case's mutation policy, docs criterion and generation
inputs hash (instrumentation, not rubric content), no claims or expected
labels. The container shares the host network namespace, so provider
traffic uses the host's loopback proxy overlay unchanged — no routes or
credentials live in this repository.

Before the loop the wrapper freezes the stamp's run.json host-side with
the FULL corpus ("describe") — carrying the trial container's
image and image id in `trialBoundary` so the frozen description describes
the trials, not the host orchestrator — and stages a per-case
`frozen.json` receipt (ids, image facts, the run.json digest) beside each
staged sandbox. The container must find that receipt; it proves the
freeze the container can never read, and an unwritable or absent freeze is
a refusal — a filesystem permission error is never treated as evidence
that a valid host-side freeze exists.
Host-only commands — `judge`, `summary`, `export` and `describe` — dispatch
before any podman check and run directly against the harness with the host's
Node and provider keys; a scorched machine without podman can still score
and export recorded evidence. `all` accepts `--no-judge` to skip the judge
stage (reports still render), and propagates a nonzero generate/run/judge
status — report steps may themselves fail without masking it. Per-case
staging lives under `$PLACEMENT_RUN_FIXTURES/<stamp>/<case>/` (sandbox
surfaces plus the case's `generation.json` and its nonsecret freeze
receipt, never rubrics), and the redacted run list is keyed by corpus
hash, so two sweeps cannot stage over each other.

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
refused — the result directory is claimed atomically with a `.reservation`
marker, so parallel workers cannot share one — and a stamp whose frozen
description names a different case set or model refuses additional runs,
so a comparison always gets a fresh stamp. Every judge attempt is
stored separately under `judge/attempt-NNN/` with the answer, rubric and
judge-prompt hashes, the judge model, timings and completion metadata.
The top-level `verdict.json` is only a pointer to the latest attempt; a
judge whose process failed or whose output is invalid records
`judge-error` there, never a pass. Judging refuses an incomplete run —
a blank answer or missing final completion, no parsable trail, stdout
overflow, nonzero exit or timeout, altered recorded answers or rubrics,
an unmet docs criterion, unmet `expectedDocs` artefact expectations,
out-of-policy writes in a policy-bearing case, or writes in a
decision-only trial without `--allow-writes` — and records `invalid`
without calling the judge model. Rejudging with unchanged inputs
(answer, rubric, judge prompt, judge model) resumes the prior attempt
instead of respending; a changed input creates the next attempt, which
is why every attempt directory is kept and never overwritten. An
infrastructure failure (a trial that did not complete) fails the
aggregate run status while the other cases still record.

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

### Hardening smoke (bounded, 2026-11-08)

One recorded run per new behavioural family on the free workhorse
(`opencode-go/deepseek-v4.1-flash`, real CLI inside the trial container,
plugin `hardening/pre-trial-fixes`), plus one tool-inventory probe:

- **Recording (W01)** — the trial used `shell` three times, claimed a doc
  write it never made (`writes.txt` stayed `none`), and the workhorse judge
  passed it on stated intent. The deterministic recording minimum now
  overrides that: the case records `invalid` with
  `recording case wrote 0 file(s), policy requires 1`, while the semantic
  pass stays preserved in `judge/attempt-001/` as honest history.
- **Retrieval (R01)** — the trial never consulted the docs tool; the docs
  criterion gate invalidated it (`0 docs call(s), required 1`) before any
  judge call.
- **Discovery (D02)** — a natural prompt of the pre-fix template: no
  destinations and no tool mention, but the template still appended a
  State block naming "the exact destination lake, or other documentation
  workflow" and a document count, so the recorded proposal was a valid
  PROMPTED response. The interpretation "unprompted trigger" attached to
  this run was unsupported; the natural template has since been corrected
  to carry no documentation framing at all (M06), and D02/D03 must be
  re-run under it before an unprompted trigger is claimed.
- **Host/transport (tool-inventory probe)** — asking a real container
  session to list its tools returned both registered surfaces (`docs`
  native and `docs_search` Code Mode twin) plus the built-ins, so plugin
  registration through the actual CLI path is verified, not inferred from
  plugin-core tests. A tool-inventory probe proves registration only —
  it is not a full live write/read round trip and no sweep-1 R03 trial
  evidence exists or is claimed.

What this smoke does NOT establish (and nothing else here claims to):

- No verdict on the three families' model behaviour beyond these single
  observations — workhorse sessions leaned on `shell` (as sweep-1's trails
  did; permission denials are defence in depth, and the container mount
  remains the enforced boundary).
- `config-home` surfaced no CLI-owned writes in these container runs.

### What a run produces

Per case, under `results/<stamp>/<case>/`:

- `final.md` — the trial model's answer; `tools.jsonl` — its deduplicated
  tool trail (the `Docs` and `Exposure` columns read from it); `writes.txt`
  — final-state additions/modifications/removals across `work`, `lakes` and
  `config-home` with kinds, followed by any `git:` and `violation:` notes
  (must say `none` plus no violations); `prompt.md`, `rubric.md`,
  `case.json`, `meta.json` (model, CLI, image, fixture/plugin/fingerprint
  identities, trail telemetry, timing, validity), `exit-code`, `live/` (the
  exact sandbox that ran); plus `verdict.json` and a `judge/attempt-NNN/`
  trail once judged. A stamp-level `run.json` freezes the experiment's
  provenance before results land; the `.reservation` marker documents the
  claiming run.
- Per sweep: `summary.md` (verdicts plus per-case trail-exposure
  classification), `dossier.md` (with an `Exposure:` line per case) and the
  provenance-bearing `manifest.json` under the fixture root.

### Sandbox guarantees

Trials judge placement from the supplied finding (the `docs` tool serves the
lakes itself). A run container mounts only the current case's sandbox, its
prompt, an id-only case list and the result directory, plus the curated
plugin package; rubrics, case JSON and every other case's results are outside
its mount namespace. The rubric and case are copied into the result only
after the container exits.

The container is the enforced boundary. The permission rules (no shell, no
edits, no reads outside the workspace) are requested, not guaranteed: trails
have shown successful shell commands and reads outside the workspace, so
never rely on them, and treat host-side trial runs as development, never as
the safety mechanism. Instead of trusting the denials, the harness classifies
each case's tool-trail exposure — guidance / case list / rubric-case / repo
cases — into the `Exposure` column of `summary.md` and an `Exposure:` line
per dossier section. A populated cell is context for the verdict, not
automatically a failure: guidance exposure (the curated `CONVENTION.md`
mount) is expected and benign.

### Reading results

Treat a sweep as a sample, not a verdict: sampling means borderline cases
(E05, E07, E16 are judgement-heavy) flicker between sweeps. Compare
distributions across stamps; a single red cell is a question, not a finding.
`writes.txt` saying anything but `none` is a trial-integrity issue before it
is a guidance issue. A guidance wording that keeps failing is durable
knowledge — record it under `docs/` at the narrowest scope, with the stamp
that showed it.

### Trial families

`tests/fixtures/trial-cases.json` extends the baseline with three
supplied-evidence-only families beyond the E01 legislative no.18 placements:

| Family    | Cases         | What it measures                                                 |
| --------- | ------------- | ---------------------------------------------------------------- |
| Discovery | D01           | same-class lakes picked by description                           |
| Discovery | D02, D03      | natural triggers — genuinely undirected (M06-corrected template) |
| Retrieval | R01, R05, R06 | existing knowledge reused; policy linked, not restated           |
| Retrieval | R02           | stale doc read, token refreshed, replaced in place               |
| Retrieval | R04           | justify ambiguity, ask rather than guess                         |
| Recording | W01           | permitted write within a declared mutation policy                |
| Recording | W02           | in-place replace with a deterministic preservation marker        |

The corpus schema adds optional fields the baseline never uses: `family`,
`promptKind` (`baseline` | `recording` | `natural`), `seeds` (documents or
symlinks written into a configured lake's root at generation time),
`mutationPolicy` (allowed-path globs; `runtimeAllow` for CLI-owned state),
`docsCriterion` (deterministic pre-judge gate on docs usage — verified
completed operations, required verbs, and optionally the relevant document
paths; the legacy `minDocsCalls` field keeps its old attempted-operations
semantics for stamps recorded before this change) and `expectedDocs`
(recording reproducibility: create/replace target, structural validity,
retains/omits/link and preserved paths). Baseline prompt wording for
E01–E18 stays byte-identical; the family prompting varies by `promptKind`:
decision-only baseline, an authorised-recording variant, and natural
prompts that carry no documentation framing — so the trigger is genuinely
measured. The R03 antirace (an external edit between read and replace)
is deliberately a deterministic integration test — the repair path is
already under `revisions.test.ts` (R05), so no model trial is raced.

### Fixture notes

- E11 and E18 each configure two personal lakes (`workstation`,
  `household`) and expect the lake named by the description, not the class
  alone; E17 nests a repo lake inside a wider
  repo lake with an unrelated personal lake beside it; E06 and E17 get small
  code-shaped work trees matching their evidence.
- E13 and E16 list no repository destination, so their fixtures pin a
  read-only placeholder at `work/docs`: the plugin otherwise adds an implicit
  _writable_ repo lake at `<location>/docs`, which would offer a destination
  the case does not list.
- Trial-family seed documents live under their configured lake's root inside
  the fixture (e.g. `docs/kb/…`, `global/org/…`, `wiki/…`), so a seeded doc
  is genuinely retrievable through the plugin.

## Host/transport integration

`tests/host-integration.test.ts` proves the plugin through a PACKED
installation away from the source checkout: `npm pack`, extract into an
isolated directory with the repo's own dependency copies, load the
installed module through the real Plugin.define contract, and assert both
registered tool surfaces (native `docs` + the Code Mode twin
`docs_search`), the `/docs` command and a skill whose content resolves
from the installed `src/SKILL.md`. The same file runs a deterministic
byte-size ladder (doc bodies from a few blocks up to ~1 MiB) through the
written-to and read-from paths of both tool surfaces — exact stored
bytes, a usable revision, a full content round trip. No threshold or
cutoff is claimed; these are observed sizes, and "truncation cannot
masquerade as a complete read" is asserted per rung. The original
8 KiB/64 KiB argument-integrity failures observed on an earlier local
diagnostic branch (now absent) remain unexplained by these runs; that
branch's cause stays unconfirmed and is not re-derived here.
Recording-validity closes the loop: a write the plugin's own `check`
accepts versus a mangled one that shows findings.

This is plugin-core through the packed shape; it is not a live CLI
session. The bounded free-model smoke (one case per family, once) is
what exercises a real CLI registration, and the sweep section above
records what it covered once run.

## Where the workflow lives

In this repository, `/placement` (implemented by
`.opencode/commands/placement.md`, workflow in
`.opencode/skills/placement-trials/SKILL.md`) drives everything above,
including the model policy and the ask-before-a-full-sweep rule.
