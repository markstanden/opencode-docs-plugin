# Testing

Two layers, two questions:

1. **Contract tests** — does the plugin _do_ what it promises? Node's built-in
   runner pins the tool, command and skill behaviour: ranking, write
   contracts, refusals, concurrency, lake resolution.
2. **Behavioural placement trials** — does a _model_ _follow_ the placement
   guidance the plugin ships? Real headless sessions answer synthetic cases; a
   fixture asserting expected answers cannot prove that.

Vocabulary, display names, condition phrases:
[docs/testing/test-glossary.md](docs/testing/test-glossary.md). Fixture ids are
the stable selectors.

## Setup

Node ≥ 26 (`engines`). Reproducible install from the lockfile:

```sh
npm ci
```

## Task selector

| Task | Command | Provider calls |
| ---- | ------- | -------------- |
| One behaviour, one file | `node --test tests/<file>.test.ts` | none |
| Inner loop | `npm test && npm run typecheck` | none |
| Final verdict | `defined comply` (owns typecheck, formatting, scoped coverage — `.defined.json`) | none; may repair the tree |
| PR head verification | clean checkout → `defined comply --full`; record `git rev-parse HEAD` and `git status --porcelain` at the same SHA (AGENTS.md) | none |
| Placement sweep (unregistered) | placement-trials skill / `/placement` | real model calls — model selection and budgets come from the task prompt; ask before a sweep |
| Registered prod014 campaign | [campaign README](tests/fixtures/placement-harness/prod014/campaign/README.md) + read-only `status.mts` | paid dispatch only through run-card steps, under the campaign's frozen models and ceilings |

`npm test` and `npm run typecheck` are the fast inner loop; the gate re-runs
typecheck, formatting and coverage itself — do not prescribe separate full
runs of them before handing back.

## Contract tests

- Node's built-in runner (`node --test`), `node:assert/strict`; the plugin
  runs under type-stripping (`noEmit`, `erasableSyntaxOnly`) — the file
  OpenCode loads is the file under test.
- `tests/docs.test.ts` imports the plugin statically so tests are typechecked;
  never reintroduce a dynamic import of a computed path.
- `tests/fixtures/docs-corpus.json` is a hand-authored synthetic corpus —
  invent paths and summaries; never snapshot a real docs tree into it.
- Every bug fix ships a test that fails against the pre-fix code.
- Hermeticity is mandatory (AGENTS.md "Test isolation").

## Trial analysis framework

`tests/fixtures/placement-harness/analysis/analyse.mts` — the supported
offline analyser: manifest validation, explicit-state evidence loading,
accounting, pairing, utility bounds, guardrails, the three-limb decision, the
static screen, stable reporting. No model calls; no campaign-supplied code.
Manifests are committed under `tests/fixtures/analysis/manifests/`; outputs
land outside the evidence root; an existing analysis refuses without
`--rerender`; `INTERPRETATION.md` is never written.

```sh
node tests/fixtures/placement-harness/analysis/analyse.mts \
  --campaign tests/fixtures/analysis/manifests/confirmation.json \
  --evidence-root <evidence-root> --out <fresh-out-dir>
```

Verified replay anchors:
[trial-analysis-framework 2026-11-11](docs/testing/trial-analysis-framework-2026-11-11.md).

## Behavioural placement trials

`tests/fixtures/placement-harness/harness.mts` runs
`tests/fixtures/placement-cases.json` (E01–E18) and
`tests/fixtures/trial-cases.json` (D/R/W families) through real headless
OpenCode sessions.

**Provider boundary:** `run`, `judge` and `all` start real model sessions
through the host provider proxy (the trial container shares the host network).
Model selection, judge choice, budgets and recovery are not set by this
guide: a registered campaign's frozen configuration and run card govern them,
and unregistered sweeps take them from the task prompt. Ask before a full
sweep.

- Workflow entry:
  [placement-trials skill](.opencode/skills/placement-trials/SKILL.md).
- Harness operating contract (subcommands and flags, frozen provenance,
  judging, generation fingerprints, mutation policy, `expectedDocs`,
  telemetry and verdict gating, schedules, the container, what a run
  produces, sandbox guarantees, trial families, the A01 diagnostic):
  [placement-harness contract](docs/testing/placement-harness-contract.md).
- Historical sweeps and smokes are evidence, not instructions:
  [sweep-1 2026-11-07](docs/testing/sweep-1-2026-11-07.md) ·
  [hardening smoke 2026-11-08](docs/testing/hardening-smoke-2026-11-08.md).

## Host/transport integration

`tests/host-integration.test.ts` proves the plugin through a PACKED
installation (`npm pack`, isolated directory, real `Plugin.define` contract):
both tool surfaces, the `/docs` command, the skill resolving from the
installed tree, the deterministic byte-size ladder on both surfaces, and
recording-validity through the plugin's own `check`. Plugin-core through the
packed shape — not a live CLI session; the bounded live CLI smoke records
what a real CLI registration covered.

## Campaign workflow (registered prod014 campaigns)

One read-only observation — local files and local git/podman queries only; no
dispatch, no network, no secret material. Exit 0 observation made (stopped,
closed, blocked included) / 1 broken invocation / 2 unreadable evidence.

```sh
# checkout mode, before a campaign root exists
node tests/fixtures/placement-harness/prod014/campaign/status.mts --base <rev>
# campaign mode, explicit roots (never scanned for); --detail and --json exist
node tests/fixtures/placement-harness/prod014/campaign/status.mts \
  --root "$CAMPAIGN_ROOT" --report-root "$REPORT_ROOT"
```

The one executable recipe, recovery and interruption rules live in the
[campaign README](tests/fixtures/placement-harness/prod014/campaign/README.md).
A registered campaign's frozen models, ceilings and attempt selection are
authoritative; the placement skill's defaults never override them.

## Reporting

Handbacks follow [templates/agent-handback.md](templates/agent-handback.md);
trial and campaign results append the relevant sections of
[templates/trial-feedback-report.md](templates/trial-feedback-report.md).
Both are output contracts only — scope, spend and stopping conditions come
from the task prompt.

## Troubleshooting

Each row: symptom → bounded diagnostic → established cause → supported
remedy. Only act on the remedy; nothing here authorises a fresh campaign by
itself.

| Symptom | Bounded diagnostic | Established cause | Supported remedy |
| ------- | ------------------ | ----------------- | ---------------- |
| `node-coverage: coverage command failed: exit 1: no output` (CI / read-only `defined verify`) | re-run the coverage command in a tracked-source scratch with no `.git`, or add a second human-readable `--test-reporter` in disposable output | an import-time git read dies in the gate's `.git`-less scratch; the lcov-only reporter hides the failure | make the test build its own fixture repo (see [prod014 campaign status](docs/testing/prod014-campaign-status-2026-11-12.md)); never weaken the gate command |
| Gate repairs files after `defined comply` | `git diff` | by design — repairs are real tree edits | review, commit, re-verify the resulting head (same-SHA rule in AGENTS.md) |
| Gate red on a linked worktree | compare the worktree's `.git` pointer with the gate container's mount | the container cannot resolve a linked worktree's `.git` file | gate through a normal-clone mirror, or a standalone checkout at the exact SHA |
| Fixture `git commit` hangs ~a minute, then `gpg: signing failed: Timeout` | check the test's spawn env for `GIT_CONFIG_GLOBAL=/dev/null` | ambient `commit.gpgsign` from the user's global config reaching fixture repos (pinentry cannot prompt) | wall config in the test env (AGENTS.md "Test isolation"); never change global config or gpg-agent |
| A report reads `stale` (it predates closure or later ledger events) | `status.mts --root … --report-root …` (freshness column) | reports rendered before closure are stale by design: closure appends ledger events after the render time | re-render `analyse.mts` into a fresh output directory (offline, no spend). **Never** start a fresh campaign over staleness alone |
| Generation refuses with `stale` or `incomplete` | the harness's generation fingerprint check (run contract) | unfrozen generation outputs no longer match their inputs fingerprint | regenerate per the [harness contract](docs/testing/placement-harness-contract.md) (`generate --force` only when inputs genuinely changed) |
| `status.mts` reports a freeze mismatch / "frozen premise no longer holds" | `status.mts --root …` preparation + freeze lines | a frozen input changed after the freeze | a changed frozen input needs a fresh root, fresh materialisation and fresh stamps; regenerate the checked-source snapshot (`materialise.mts --snapshot`, then commit) only when `active/` sources or pinned runner modules changed |
| Unsettled claim blocks every dispatch / ledger unreadable | inspect the named claim file and `evidence/ATTEMPTS.jsonl` | a spend whose outcome is unknown must never be retried | inspect and stop; never delete locks or repeat unknown spend; recovery is a separately authorised `rejudge.mts --attempt-id attempt-002` |
| Credential mode / non-executable shim / attribution or blinding refusals | `status.mts` names the exact command or path | runner refusals by design | `chmod 600 "$CAMPAIGN_ROOT/.env"`, `chmod +x "$CAMPAIGN_ROOT/prepare/shim/podman"` as suggested; refusals stand until evidence changes |
| Questions about an old sweep or campaign | read its dated record under `docs/testing/` | historical evidence | do not regenerate or regrade; a new assessment is a separately labelled retrospective |

Key records:
[prod014 campaign status](docs/testing/prod014-campaign-status-2026-11-12.md) ·
[a coverage run can go red with no named failure](docs/quality/a-coverage-run-can-go-red-with-no-named-failure.md) ·
machine `opencode` lake: "a read-only verify has no .git in its scratch",
"gating a git worktree needs a clone mirror".
