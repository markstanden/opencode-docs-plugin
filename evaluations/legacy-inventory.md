# Retained legacy harness inventory

Every file retained under `tests/fixtures/placement-harness/` and `tests/fixtures/analysis/` after the OTC extraction, with its classification. Nothing here runs in `npm test`; the engine tests that exercise it are behind `npm run test:legacy`.

## Classifications

- **historical material** — immutable recorded evidence and frozen campaign inputs. Bytes, ids and receipts are never rewritten, and no frozen root is resumed or replayed through OTC.
- **fixture data** — product-owned data the evaluation bundle needs (primary checkers, seeds, scenario names, manifests). Kept where the existing checks and the frozen route read it.
- **legacy machinery** — the old live engine: generation, container dispatch, judging, analysis and its harness. Ported to OTC; retained to reproduce the frozen route and as a parity oracle, never invoked by fresh commands.

## Counts

- fixture data: 39
- historical material: 76
- legacy machinery: 32
- total: 147

## Files

| File                                                                                                      | Class               |
| --------------------------------------------------------------------------------------------------------- | ------------------- |
| `tests/fixtures/analysis/manifests/confirmation.json`                                                     | historical material |
| `tests/fixtures/analysis/manifests/mini.json`                                                             | historical material |
| `tests/fixtures/analysis/manifests/replication.json`                                                      | historical material |
| `tests/fixtures/analysis/manifests/screening.json`                                                        | historical material |
| `tests/fixtures/analysis/mini-corpus/a/fixtures/R02/lakes/docs/db/pool.md`                                | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/ac/attempt-001/judgement.json`             | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/ac/attempt-001/meta.json`                  | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/final.md`                                  | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/gate.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/live/lakes/docs/ops/csv-bom.md`            | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/meta.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/primary-check.json`                        | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/prompt.md`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/stdout.jsonl`                              | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R01/R01/writes.txt`                                | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/ac/attempt-001/judgement.json`             | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/ac/attempt-001/meta.json`                  | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/final.md`                                  | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/gate.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/live/lakes/docs/db/pool.md`                | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/meta.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/primary-check.json`                        | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/prompt.md`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/stdout.jsonl`                              | historical material |
| `tests/fixtures/analysis/mini-corpus/a/results/cc-A-r0-R02/R02/writes.txt`                                | historical material |
| `tests/fixtures/analysis/mini-corpus/b/fixtures/R02/lakes/docs/db/pool.md`                                | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/ac/attempt-001/judgement.json`             | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/ac/attempt-001/meta.json`                  | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/final.md`                                  | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/gate.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/live/lakes/docs/test/runs/stale-socket.md` | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/meta.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/primary-check.json`                        | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/prompt.md`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/stdout.jsonl`                              | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R01/R01/writes.txt`                                | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/ac/attempt-001/meta.json`                  | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/final.md`                                  | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/gate.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/live/lakes/docs/db/pool.md`                | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/meta.json`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/primary-check.json`                        | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/prompt.md`                                 | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/stdout.jsonl`                              | historical material |
| `tests/fixtures/analysis/mini-corpus/b/results/cc-B-r0-R02/R02/writes.txt`                                | historical material |
| `tests/fixtures/placement-harness/Containerfile`                                                          | legacy machinery    |
| `tests/fixtures/placement-harness/ac-scoring.mts`                                                         | legacy machinery    |
| `tests/fixtures/placement-harness/ac/README.md`                                                           | legacy machinery    |
| `tests/fixtures/placement-harness/ac/campaign.mts`                                                        | legacy machinery    |
| `tests/fixtures/placement-harness/ac/evidence-guard.mts`                                                  | legacy machinery    |
| `tests/fixtures/placement-harness/ac/judge-launcher.sh`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/ac/run.mts`                                                             | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/accounting.ts`                                                 | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/analyse.mts`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/blinding.ts`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/bounds.ts`                                                     | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/budget.ts`                                                     | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/closure.ts`                                                    | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/decision.ts`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/freeze.ts`                                                     | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/guardrails.ts`                                                 | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/journal.ts`                                                    | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/ledger.ts`                                                     | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/measures.ts`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/model.ts`                                                      | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/pairing.ts`                                                    | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/records.ts`                                                    | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/recovery.ts`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/render.ts`                                                     | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/screening/inventory.ts`                                        | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/screening/noteVersion.ts`                                      | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/screening/reconcile.ts`                                        | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/screening/rules.ts`                                            | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/screening/scan.ts`                                             | legacy machinery    |
| `tests/fixtures/placement-harness/analysis/selector.ts`                                                   | legacy machinery    |
| `tests/fixtures/placement-harness/container-run.sh`                                                       | legacy machinery    |
| `tests/fixtures/placement-harness/harness.mts`                                                            | legacy machinery    |
| `tests/fixtures/placement-harness/primary-checks/H01.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/H02.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/H03.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/H04.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/NOTE-01.mjs`                                             | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/NOTE-02.mjs`                                             | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/NOTE-03.mjs`                                             | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/NOTE-04.mjs`                                             | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R01.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R01.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R02.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R02.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R03.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R03.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R04.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/R04.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S02.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S02.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S05.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S05.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S06.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S06.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S07.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/S07.mts`                                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/_replication-shared.mjs`                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/_replication-shared.mts`                                 | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/probe-fail.mjs`                                          | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/probe-pass.mjs`                                          | fixture data        |
| `tests/fixtures/placement-harness/primary-checks/probe-timeout.mjs`                                       | fixture data        |
| `tests/fixtures/placement-harness/prod014/assets/b-prod014.txt`                                           | historical material |
| `tests/fixtures/placement-harness/prod014/build.mjs`                                                      | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/README.md`                                             | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/close-campaign.mts`                             | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/contracts.mts`                                  | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/delivery-probe.mts`                             | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/env.mts`                                        | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/freeze.mts`                                     | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/generate.sh`                                    | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/manifest.json`                                  | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/rejudge.mts`                                    | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/run.mts`                                        | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/runner-regression.mts`                          | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/schedule.mts`                                   | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/shim/podman`                                    | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/snapshot.json`                                  | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/active/surfaces.mts`                                   | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/materialise.mts`                                       | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/rehearsal/judge-recovery-rehearsal.mts`                | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner.json`                                           | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner/budget.ts`                                      | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner/closure.ts`                                     | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner/freeze.ts`                                      | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner/ledger.ts`                                      | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner/recovery.ts`                                    | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/runner/selector.ts`                                    | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/scripts.json`                                          | historical material |
| `tests/fixtures/placement-harness/prod014/campaign/status.mts`                                            | historical material |
| `tests/fixtures/placement-harness/prod014/cases.json`                                                     | historical material |
| `tests/fixtures/placement-harness/prod014/measurement.json`                                               | historical material |
| `tests/fixtures/placement-harness/prod014/truth.json`                                                     | historical material |
| `tests/fixtures/placement-harness/replication/assets/a.txt`                                               | fixture data        |
| `tests/fixtures/placement-harness/replication/assets/b.txt`                                               | fixture data        |
| `tests/fixtures/placement-harness/replication/build.mjs`                                                  | fixture data        |
| `tests/fixtures/placement-harness/replication/cases.json`                                                 | fixture data        |
| `tests/fixtures/placement-harness/replication/patch.mjs`                                                  | fixture data        |
| `tests/fixtures/placement-harness/replication/r02-inventory.json`                                         | fixture data        |
| `tests/fixtures/placement-harness/replication/schedule.mjs`                                               | fixture data        |
| `tests/fixtures/placement-harness/replication/truth.json`                                                 | fixture data        |
| `tests/fixtures/placement-harness/replication/verify.mjs`                                                 | fixture data        |
| `tests/fixtures/placement-harness/scenario-names.mts`                                                     | fixture data        |

## Authority and removal

**Historical material** is provenance. The `mini-corpus` and `manifests` are
the recorded evidence the OTC parity record replays; the `prod014` assets,
cases, truth, measurement and campaign records are the frozen 2026-11-11
campaign. Their bytes, ids and receipts are never rewritten, and no frozen
root is resumed or replayed through OTC. Executable members under
`prod014/campaign/` (`active/`, `materialise.mts`, `status.mts`) reproduce that
frozen root and observe it read-only; they are not templates for a new
campaign. Removal: none.

**Fixture data** belongs to the product. `primary-checks/` are the checkers
the product supplies and OTC executes; `scenario-names.mts` holds the display
identities; `replication/` holds the candidate assets and the frozen
replication inventory. Removal: only when the consuming product checks and the
evaluation bundle move with them.

**No compatibility bridge remains.** OTC 287e30a removed its migrated
`harness/run.ts` and no installed OTC source reaches
`tests/fixtures/placement-harness/harness.mts`; the consumer contract test
asserts the installed artifact contains no such reference. `harness.mts` is
therefore legacy machinery, retained for the historical E01–E18 reproduction
and `npm run test:legacy`, not because OTC consumes it.

**Legacy machinery** is the old live engine — generation, container dispatch,
judging, analysis and its harness. It is not invoked by `npm test`, the defined
gate, the placement command or the placement skill. Only
`npm run test:legacy` exercises it. Fresh campaigns use OTC. Removal: after
the remaining legacy route is retired; the OTC equivalents have passed offline
semantic parity on the recorded evidence (parity record retained), and OTC now
owns primary-check execution, the blind judge, recovery and fresh dispatch.
