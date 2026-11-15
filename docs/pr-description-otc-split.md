# PR — split docs plugin internals and make the evaluation bundle OTC-owned

## Summary

- Splits `src/index.ts` (5,270 lines) into focused modules without changing
  the public entry point. The public surface is listed explicitly and is
  identical to the pre-split one (99 names); moving code did not widen the
  package API. A `tests/public-api.test.ts` guard freezes both the 74 runtime
  exports and the 25 type exports, so an accidental leak is a red test and an
  intended addition is a deliberate edit. Tool/command/skill descriptions,
  prose, journal bytes, locking behaviour, package identity and Node support
  are unchanged. `src/index.ts` is now ~355 lines; modules: `metadata`,
  `ranking`, `collection`, `convention`, `lakes`, `journal`.
- Classifies the tests by behaviour. `npm test` runs the 517 product contract
  tests (2.5s); the 827 tests that exercise the frozen prod014 engine move to
  `tests/legacy/` behind `npm run test:legacy`. Product coverage instruments
  `src/` only, so the floors are earned by product code: 99.7 line / 96.2
  branch / 98.6 function against 95/90/95 — no legacy coverage masking.
- Makes `evaluations/` a product-owned suite bundle: cases, prompts and seed
  fixtures, hidden truth, measurement declarations, expected outcomes and the
  primary checkers, with `manifest.json` as the index. OTC executes it; this
  repo adds no scheduler, budget, judge, recovery or reporting layer.
- Pins the dev-only OTC tooling to an immutable vendored tarball with recorded
  provenance: `@markstanden/opencode-test-container` 0.1.0, source
  `5b0ee3d6c4f762cf254d1240edff58583b72943b`, tarball SHA-256
  `75bd531056c397b14657d33ae70beeaaeed07cbe8a62a75025707e4ad49475c5`.
  A fresh `npm pack` of that commit is content-identical to the vendored
  artifact. Ordinary tests and the published tarball do not include
  `evaluations/`.
- Adds the cross-project journal contract through the **packed** plugin and
  the **installed pinned** OTC evaluator, covering the string-form `add` and
  the undeclared nested `add.lake`, including the refusal to credit a write
  corroborated only by the nested value.
- Fences the legacy route: `evaluations/legacy-inventory.md` classifies all
  147 retained files; fresh commands, the placement skill/command and the
  campaign README route new campaigns to OTC; the historical harness is
  explicitly the reproduction route.

## Proof

- `npm ci`, `npm run typecheck`.
- `npm test`: 527 pass.
- `npm run test:legacy`: 827 pass.
- `npm --prefix evaluations ci && npm --prefix evaluations test`: 11 pass,
  including the packed-plugin journal contract and `otc validate`.
- Installed pinned artifact from an unrelated cwd: `otc validate`, `prepare`,
  `freeze`, `run --dry-run` and `status --json` all succeed; freeze resolved
  the verified OpenCode 2.2.6 image ID. No provider call.
- `npm pack --dry-run`: includes the modules and `src/SKILL.md`; excludes
  `evaluations/` and `tests/`.
- `defined comply --full` at the recorded head: see the PR checks.

## Outstanding dependency

The vendored tarball is a provisional review artifact until the package is
published; replace it with the registry version and delete the tarball then.
OTC's docs campaign support (`src/evaluators/docs/harness/run.ts`, `gate`)
still reaches this repository's `tests/fixtures/placement-harness/harness.mts`
by literal path — the one retained compatibility bridge, recorded in the
handback for the OTC owner. A full dispatched docs campaign and live judging
are not claimed.
