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

## Replay anchors (verified against recorded evidence)

| Campaign                          | Population                                                                         | Result                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rc-20261110` (PR #50)            | 40 recorded, 38 documented, 18 complete pairs                                      | A 29 / B 26; paired delta −3 (5/3/10); bounds A `24..34`, B `21..31`; full-population delta `−13..+7`; two unmatched +5 observations; sensitivity A lead 2.5–4 in all nine cells; R02 preservation 8/8 assessed; R04 destructive loss unresolved symmetrically; gate pass/blocked A 15/5, B 13/7 |
| `rr-20261110` (PR #49)            | 30 documented (28 first-attempt + 2 replacements); 13 complete pairs + 2 unmatched | A 4 / B 7 (all-scored B−A +3); paired delta −2 (A better 3, B better 1, ties 9); R04 r0 pair excluded as `invalid-r04-premise`                                                                                                                                                                   |
| `fr-20261110` (six-arm screening) | 48 slots, arms A–F                                                                 | Totals A 9, B 15, C −1, D −1, E −2, F 4 — equal to the published `ANALYSIS-screening.json`; no selection rule declared, so the decision is `not-defined`                                                                                                                                         |

The confirmation's full-population interval reproduces the corrected
`c7246be` bounds, not the pre-correction full-task-range widening.

## Decision semantics

- The three limbs are separate: coverage (documented/planned), threshold
  (assessed-total lead), and the candidate's guardrails.
- `rc` reports `inconclusive` with coverage `19/20` each and threshold
  `−3 vs 5`; `B` is not shown to fail the threshold, the criterion is simply
  not satisfied.
- A missing mutation-policy record is `unknown`, never a pass; a preserve gate
  block without a semantic inventory raises `unresolved`, never loss.
- The boolean `finalistQualifies` agrees with `qualified` when every limb is
  decisive; its `false` conflates `not-qualified` with `inconclusive`, which the
  compatibility tests pin.

## Scanner validation

Partition (frozen before rule checks; the findings documents named the
development examples first):

- **Development**: the exact `cc-B-r0-R02` false-positive bullet, the B r0
  document, the verify.mjs paraphrase/negation/unit counterexamples, and the
  NOTE-02 Summary/Facts examples.
- **Retrospective validation**: the remaining confirmation R02 after-documents
  (10 trials total; 8 carry judge preservation labels). This is not a fresh
  blind holdout — the findings record already described the post-fix run.

Denominators and outcomes:

| Proposition                                                            | Labelled | Screen result                                              |
| ---------------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| No local contradiction when the judge reports retained/corrected facts | 8        | 8/8 accepted, 0 contradictions                             |
| Explicit contradiction detected when the judge reports a lost fact     | 0        | no positive labels in this set; precision/recall undefined |
| Unlabelled trials                                                      | 2        | accepted by the screen; remain unknown, never pass         |

The exact regression bullet (`sslmode=disable` obsolete; pool/timeout/migrations
unchanged) produces no contradiction for `startupMigrations`, and the obsolete
clause does not negate the later assertion. `5000 milliseconds` is accepted;
`5000 seconds` and an unrelated retry timeout are not recognised.

## Focused coverage and scope gaps

`node --test --experimental-test-coverage --test-coverage-include='tests/fixtures/placement-harness/analysis/**/*.ts'`:

| Area                 | Line   | Branch | Function |
| -------------------- | ------ | ------ | -------- |
| all analysis modules | 94.78% | 84.46% | 98.28%   |
| `model.ts`           | 89.81% | 71.51% | 100%     |
| `scan.ts`            | 83.10% | 86.36% | 84.21%   |
| `records.ts`         | 92.58% | 82.21% | 100%     |

The gate's coverage include is `src/**/*.ts` and Sonar's `sonar.sources` is
`src`, so harness coverage is measured here as information and is **not**
enforced by CI. No threshold or exclusion was changed.

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

## Facts

- 930 contract tests pass at the framework head; typecheck passes; `defined
comply` is compliant; `replication/verify.mjs` is 32/32.
- Manifests validate in CI without external evidence; the mini corpus exercises
  the complete replay path.

## Open questions

- The scanner is validated only for the R02 preservation/inventory shape and
  the NOTE-02 version rule; other scenarios have no labelled screening set.
- Whether Harness coverage should become a gated requirement is a repository
  decision, not taken here.
