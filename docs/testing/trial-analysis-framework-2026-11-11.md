---
Area: Testing
Keywords: analysis-framework, replay, bounds, guardrails, static-screening, manifests, confirmation, replication
Summary: The maintained trial-analysis framework replaces campaign-specific calculators with a manifest-driven offline pipeline. Replays of the 2026-11-10 confirmation, replication and six-arm screening reproduce their published totals; this record lists the verified anchors, the focused harness coverage, the scanner validation partition and the remaining scope gaps.
---

# Trial analysis framework: implementation and replay record, 2026-11-11

This record documents the framework added on branch `analysis/framework` from
`main` @ `fbcea8061218f3e427c1cac98758c01ec34adc40`. It is a derived reanalysis
of preserved evidence, not a fresh execution: **no model trial, judge call or
delivery probe was made**.

## What replaced what

- Campaign-specific calculators (`ac/run.mjs report`, and the dev-box
  `evidence/analyse.mjs`, `alternative-note02.mjs`) are superseded for future
  campaigns by `tests/fixtures/placement-harness/analysis/analyse.mts`. `report`
  is preserved unchanged as the legacy historical route.
- The untyped `replication/preservation.mjs` and `replication/note-version.mjs`
  were converted to typed modules under `analysis/screening/` and deleted; their
  inventories are data (`replication/r02-inventory.json`).
- New modules: `model` (manifest v1), `records` (explicit load states and the
  ac-v1 adapter), `accounting`, `pairing`, `bounds`, `guardrails`, `decision`,
  `render`, `screening/{inventory,noteVersion,rules,scan,reconcile}`.

## Command

```sh
node tests/fixtures/placement-harness/analysis/analyse.mts \
  --campaign tests/fixtures/analysis/manifests/confirmation.json \
  --evidence-root /home/mark/tmp/recording-confirm-20261110 \
  --out /home/mark/tmp/confirmation-replay
```

Portable manifests live in `tests/fixtures/analysis/manifests/`; the CI corpus
is `tests/fixtures/analysis/mini-corpus/`. The analyser has no model-launch
capability, executes no campaign code, refuses outputs overlapping the evidence
root, refuses an accidental overwrite, and never writes `INTERPRETATION.md`.
Publication pre-flights the whole output set (refusing symlinked or aliasing
names) and writes exclusive temps before renaming; the receipt records every
consumed evidence file with its state and hash.

## Replay anchors (verified against recorded evidence)

| Campaign                          | Population                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rc-20261110` (PR #50)            | 40 recorded, 38 documented, 18 complete pairs                                      | A 29 / B 26; paired delta −3 (5/3/10); bounds A `24..34`, B `21..31`; full-population delta `−13..+7`; two unmatched +5 observations; sensitivity baseline now holds the declared duplicate/misleading/taskFailure weights, A lead 2.5–4 in all nine cells; R02 preservation 8/8 assessed; R04 destructive loss unresolved symmetrically; gate pass/blocked A 15/5, B 13/7; attempt ledger 40/40/40 scheduled/launched/judge-attempted with no discrepancy; 40/40 trials carried token telemetry |
| `rr-20261110` (PR #49)            | 30 documented (28 first-attempt + 2 replacements); 13 complete pairs + 2 unmatched | A 4 / B 7 (all-scored B−A +3); paired delta −2 (A better 3, B better 1, ties 9); R04 r0 pair excluded as `invalid-r04-premise`; mutation-policy guardrail breached; 32/40 trials carried token telemetry, 8 stayed unknown                                                                                                                                                                                                                                                                       |
| `fr-20261110` (six-arm screening) | 48 slots, arms A–F                                                                 | Totals A 9, B 15, C −1, D −1, E −2, F 4 — equal to the published `ANALYSIS-screening.json`; no selection rule declared, so the decision is `not-defined`                                                                                                                                                                                                                                                                                                                                         |

The confirmation's full-population interval reproduces the corrected
`c7246be` bounds, not the pre-correction full-task-range widening.

## Decision semantics

- The three limbs are separate: coverage (documented/planned), threshold
  (full-population interval), and the candidate's guardrails.
- The threshold limb evaluates the rule where it was defined: the full design.
  It passes only when `candidate.low − control.high ≥ threshold`, fails only
  when `candidate.high − control.low < threshold`, and is `inconclusive`
  otherwise. The assessed lead is retained as a descriptive field, not the
  decision input.
- `rc` reports `inconclusive`: coverage `19/20` each; assessed lead `−3`; the
  full-population interval `−13..+7` crosses the `+5` threshold, so the
  threshold limb is `inconclusive`; R04 destructive loss is `unresolved`
  symmetrically. `B` is not shown to fail the threshold, the criterion is
  simply not satisfied.
- `rr` reports `inconclusive` overall: coverage `15/20` each, assessed lead
  `+3`, interval `−57..+63` crossing `+5`, and the mutation-policy guardrail
  `breached`. A breach still decides `not-qualified` when coverage is complete;
  with incomplete coverage the overall stays `inconclusive` as the rule cannot
  be evaluated.
- A missing mutation-policy record is `unknown`, never a pass; a preserve gate
  block without a semantic inventory raises `unresolved`, never loss.
- The boolean `finalistQualifies` agrees with `qualified` when every limb is
  decisive; its `false` conflates `not-qualified` with `inconclusive`, which the
  compatibility tests pin.

## Scanner validation

The earlier record's partition double-counted its development example: it
assigned `cc-B-r0-R02` to development and then described the whole 10-trial R02
corpus as "remaining" validation. The lineage lists below are the corrected
partition. Every R02 after-tree in the confirmation has a distinct SHA-256, so
no retrospective trial duplicates the development document or another
retrospective trial; the denominators are lines of evidence, not screen runs.

- **Development (excluded from validation denominators)**:
    - `cc-B-r0-R02` after-documents (`db/pool.md`, `ops/release.md`) — the exact
      historical false-positive bullet.
    - `verify.mjs` synthetic counterexamples: paraphrase, local negation, wrong
      unit, unrelated timeout.
    - NOTE-02 synthetic Summary/Facts examples (version-rule development), which
      are not confirmation trials.
- **Retrospective validation — confirmation R02 after-documents** (9 trials):
  `cc-A-r0-R02`, `cc-A-r1-R02`, `cc-A-r2-R02`, `cc-A-r3-R02`,
  `cc-A-r4-R02`, `cc-B-r1-R02`, `cc-B-r2-R02`, `cc-B-r3-R02`,
  `cc-B-r4-R02`. Judge preservation labels exist for 7
  (`cc-A-r1-R02` and `cc-B-r3-R02` are `invalid-verdict` and carry no
  preservation record). This remains retrospective, not a blind holdout: the
  findings record already described the post-fix run.
- **Unlabelled examples**: `cc-A-r1-R02`, `cc-B-r3-R02` — screen accepted,
  outcome stays unknown, never pass.

Corrected denominators and outcomes:

| Proposition                                                            | Retrospective labelled | Screen result                                              |
| ---------------------------------------------------------------------- | ---------------------: | ---------------------------------------------------------- |
| No local contradiction when the judge reports retained/corrected facts |                      7 | 7/7 accepted, 0 contradictions                             |
| Explicit contradiction detected when the judge reports a lost fact     |                      0 | no positive labels in this set; precision/recall undefined |
| Unlabelled retrospective trials                                        |                      2 | accepted by the screen; remain unknown, never pass         |

The same figures over the **whole corpus — descriptive, not a holdout** — are 10
R02 trials, 8 labelled (including the development example), 8/8 accepted, 0
contradictions.

Per-rule retrospective result over the 7 labelled trials:

| Rule                                              | Findings | Positive labels          |
| ------------------------------------------------- | -------: | ------------------------ |
| `fact-negation`                                   |        0 | 0 (none recorded)        |
| `fact-conflict`                                   |        0 | 0 (none recorded)        |
| `fact-obsolete-current`                           |        0 | 0 (none recorded)        |
| `fact-coverage-unknown`                           |        0 | 0 (none recorded)        |
| `duplication-signal` (advisory, not preservation) |        7 | not a preservation label |

Duplication signals fire on all 10 R02 trials (1 development, 7 labelled
retrospective, 2 unlabelled retrospective); they are advisory repetition
signals and are not part of the labelled preservation proposition.

The exact regression bullet (`sslmode=disable` obsolete; pool/timeout/migrations
unchanged) produces no contradiction for `startupMigrations`, and the obsolete
clause does not negate the later assertion. `5000 milliseconds` is accepted;
`5000 seconds` and an unrelated retry timeout are not recognised.

## Focused coverage and scope gaps

The test count and the test-file count are different figures, and the earlier
record's "930 contract tests" predates this correction pass:
**958 tests across 27 test files** at the corrected head (930 across 26 before
the remediation backlog; one new file, `tests/analysis-integrity.test.ts`,
holds the receipt, publication, usage/ledger and CLI evidence-state regressions).

The earlier coverage run included `analysis/**/*.ts` only and **excluded the
`.mts` CLI**, so its aggregate could not describe the file that assembles and
publishes the result. Re-measured over:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='tests/fixtures/placement-harness/analysis/**' \
  --test-coverage-exclude='**/*.test.ts' 'tests/**/*.test.ts'
```

| Area                               | Line   | Branch | Function |
| ---------------------------------- | ------ | ------ | -------- |
| all analysis modules, CLI included | 95.27% | 82.87% | 98.70%   |
| `analyse.mts` (the CLI)            | 94.58% | 70.00% | 98.39%   |
| `model.ts`                         | 90.98% | 71.35% | 100%     |
| `scan.ts`                          | 92.40% | 92.77% | 92.31%   |
| `records.ts`                       | 92.39% | 82.63% | 100%     |

The gate's coverage include is still `src/**/*.ts` and Sonar's `sonar.sources`
is still `src`, so harness coverage is measured here as information and is
**not** enforced by CI. That src-only gate scope remains a gap: the harness can
regress while the gate stays green. No threshold or exclusion was changed.

## Integrity

- `rc` evidence root: `ac/run.mjs manifest --verify` returns 0 (all recorded
  hashes match; signing keys excluded by name).
- `docs-desc-fresh` root: the recorded manifest mismatches only in the
  `docs-operations.key` secret-row formatting and three post-manifest
  evidence-side scripts; no `gen/` trial or judge file changed.
- Replay outputs were written only outside the evidence roots.

## Original versus derived layers

- The original 2026-11-10 analyses are unchanged (`ANALYSIS-confirmation.json`,
  `ANALYSIS-confirmation.pre-bounds-fix.json`, the replication ledger asset).
- This framework adds a derived layer with recorded selection policies; it does
  not overwrite, retry or re-judge anything.
- Implementation fixes found during replay: the unknown-documentation interval
  now derives from declared weights; the ac-v1 adapter joins
  `results/<stamp>/<scenario>`; a bare reservation remains `unknown`.

## Remediation pass (PR #51 review)

The review found that the result did not bind to the evidence that decided it,
and that several advertised capabilities were accepted but unread. Corrections,
append-only on the same branch:

- **Receipt binding.** The evidence reader records every consumed text file with
  a stable root-relative reference, an explicit `available`/`missing` state and
  a SHA-256 when readable; the out-of-tree manifest has its own identity.
  Changing the selected judgement on a corpus copy changes exactly that receipt
  entry. Findings and reconciliation rows now carry `trial`, `role`
  (before/after/response/prompt/writes) and a root-relative source, so two
  trials with byte-identical `final.md` remain distinguishable.
- **Publication safety.** The whole output set is pre-flighted before any write:
  a symlinked output name, a non-file target, or a target aliasing the manifest,
  `INTERPRETATION.md` or consumed evidence is refused with the previous outputs
  untouched. Publication uses exclusive temp creation (`"wx"`), writes through
  the descriptor, then renames.
- **Declared populations.** The sensitivity grid now spreads the campaign's
  declared non-grid weights, so the baseline cell equals accounting; the
  threshold limb evaluates the full-population interval and keeps the assessed
  lead descriptive. The confirmation's threshold is now `inconclusive`
  (`−13..+7` vs `+5`) instead of a failure inferred from `−3`.
- **Evidence sufficiency.** Screening inputs carry their load state; a rule runs
  only with enough evidence. A recorded empty lake is `available: []`; an absent
  lake is `missing`, and neither produces a claimed-mutation contradiction about
  an unobserved change. `walkMarkdown` maps ENOTDIR to `not-a-directory` and
  skips a plain `README.txt`; unreadable directories are malformed, never empty.
  Scenarios can declare `mutationPolicy` (allowed globs plus visible
  constraints); visibility is `visible`, `hidden` or `unknown`.
- **Observable capabilities.** `rr-ledger-v1` is rejected rather than accepted
  and silently read as ac-v1 — implementing that adapter remains future work.
  A declared `evidence.inputs.attempts` ledger is reconciled against the
  schedule (events, missing launches, missing judge attempts, unknown stamps,
  duplicate launches) and surfaced in JSON/Markdown. Token/step usage is reported
  with measured/unknown counts; totals are `null` when nothing was measured, and
  cost is explicitly unavailable rather than a measured zero.

## Facts

- 958 contract tests pass across 27 test files at the corrected head (930
  across 26 before this pass); typecheck passes; `defined comply` is compliant;
  `replication/verify.mjs` is 32/32.
- Manifests validate in CI without external evidence; the mini corpus exercises
  the complete replay path.
- The three offline replays still reproduce the recorded accounting anchors
  (A 29 / B 26; A 4 / B 7; A 9, B 15, C −1, D −1, E −2, F 4). The decision
  changes are the intended threshold-limb correction and the newly wired
  replication mutation policy; no accounting number moved.

## Open questions

- The scanner is validated only for the R02 preservation/inventory shape and
  the NOTE-02 version rule; other scenarios have no labelled screening set, and
  the retrospective R02 set has no positive (lost-fact) label, so recall is
  undefined rather than perfect.
- The `rr-ledger-v1` evidence adapter is not implemented; the layout is now
  rejected explicitly. Building it would let ledger-shaped evidence be read
  instead of refusing the manifest.
- Whether harness coverage should become a gated requirement (the gate and
  Sonar still measure `src` only) is a repository decision, not taken here.
