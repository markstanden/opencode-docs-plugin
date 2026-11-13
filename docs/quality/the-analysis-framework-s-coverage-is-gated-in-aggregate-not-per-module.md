---
Area: quality
Keywords: coverage, defined gate, analysis framework, lcov, per-module floors, sonar, opencode-docs-plugin
Summary: The gate's coverage command now instruments the analysis framework as well as src, so both are held to one aggregate 95/90/95 floor. Six analysis modules still sit below those percentages individually, and the gate cannot see that.
---

# The analysis framework's coverage is gated in aggregate, not per module

Recorded 2026-11-13 at `ceb1b84` plus the test-review branch, after a whole-repo test review.

## Facts

- `coverage.node.command` in `.defined.json` ran with a single `--test-coverage-include='src/**/*.ts'`. The 11.5k lines under `tests/fixtures/placement-harness/analysis/` (campaign decision, measures, records, freeze, closure, budget, journal, rendering) had **no measured coverage at all**; Sonar's `sonar.sources` is still `src` only.
- The gate reads one report at a fixed path (`coverage/lcov.info`) and checks aggregate totals. Repeated `--test-coverage-include` flags union into that one report (verified on Node 26.13).
- The scope now includes `src/**/*.ts` and `tests/fixtures/placement-harness/analysis/**/*.ts` in both `.defined.json` and the `test:coverage` npm script, kept byte-identical.
- Review-start combined totals were line 96.08%, branch 88.61%, function 98.45% against declared minimums 95/90/95 — the branch floor would have failed if the include had been added without closing test gaps first.
- After this branch's tests: combined line 97.28%, branch 91.05%, function 98.45%. `src/index.ts` alone moved from 98.9/94.0/98.6 to 99.7/95.9/98.6.
- Six analysis modules remain below the gate's percentages individually, hidden by the aggregate: `model.ts` 90.9/71.1, `freeze.ts` 92.4/71.8, `render.ts` 96.1/80.6, `pairing.ts` 98.4/84.4, `measures.ts` 93.1/85.4, `records.ts` 95.3/89.7 (line/branch).
- `harness.mts`, `ac-scoring.mts` and `container-run.sh` remain unmeasured: they execute as child processes, which `node --test` coverage does not instrument without `NODE_V8_COVERAGE` plumbing.

## Inferred

- An aggregate floor protects the combined tree from a large regression but cannot stop one young module drifting: a weak validator can sit at 71% branch while the report still clears 90 because `src` and the accounting modules dominate the denominator.
- A repo-owned second command could enforce per-module floors, but it would duplicate threshold authority; the gate is the single authority by house policy, so the alternative was rejected.

## Tested

- `defined comply` is compliant with the wider include at the numbers above.
- Before wiring, the same command produced 88.61% branch, proving the include is not a no-op.

## Open questions

- Whether the six weak modules deserve per-module floors through an upstream gate capability, rather than aggregate-only protection.
- Whether Sonar should keep `sonar.sources=src`: the lcov entries for `tests/**` are outside its analysed sources, and no Sonar verdict has been observed against the wider report yet.
