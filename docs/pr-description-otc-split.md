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
- Classifies the tests by behaviour. `npm test` runs the 527 product contract
  tests (2.5s); the 827 tests that exercise the frozen prod014 engine move to
  `tests/legacy/` behind `npm run test:legacy`. Product coverage instruments
  `src/` only, so the floors are earned by product code: 99.9 line / 96.7
  branch / 98.6 function against 95/90/95 — no legacy coverage masking.
- Makes `evaluations/` a product-owned suite bundle: cases, prompts and seed
  fixtures, hidden `truth`, measurement declarations, expected outcomes and
  the primary checkers, with `manifest.json` as the index. Each docs case now
  declares a product-owned checker that OTC stages and executes in its own
  no-network container; this repo adds no scheduler, budget, judge, recovery
  or reporting layer.
- Pins the dev-only OTC tooling to an immutable vendored tarball with recorded
  provenance: `@markstanden/opencode-test-container` 0.1.0, source
  `287e30a236e34b0dda8a24d966d7c3d6140d0c1b` (branch
  `feat/otc-fresh-campaign-judging`, based on `5b0ee3d`), tarball SHA-256
  `a3731bb52bc154173bb6103a2e175b5a9fc19b3b8ca9bf90e2e07fb12495015b`.
  Two independent `git archive` + `npm pack` builds are byte-identical to the
  vendored artifact. Ordinary tests and the published tarball do not include
  `evaluations/`.
- Adds the cross-project journal contract through the **packed** plugin and
  the **installed pinned** OTC evaluator, covering the string-form `add` and
  the undeclared nested `add.lake`, including the refusal to credit a write
  corroborated only by the nested value.
- Completes the consumer integration: the declared checker drives OTC's closed
  primary-check plan (fixed interpreter, read-only `/live`, `/pristine` and
  `/checker`, `network: "none"`); the product checkers are executed exactly as
  OTC does; the installed artifact carries no docs-harness bridge; and the
  committed mini corpus replays through `otc replay` offline.
- Fences the legacy route: `evaluations/legacy-inventory.md` classifies all
  147 retained files (32 legacy machinery, 39 fixture data, 76 historical);
  fresh commands, the placement skill/command and the campaign README route
  new campaigns to OTC; the historical harness is explicitly the reproduction
  route and no longer a compatibility bridge.

## Proof

- `npm ci`, `npm run typecheck`.
- `npm test`: 527 pass.
- `npm run test:legacy`: 827 pass.
- `npm --prefix evaluations ci && npm --prefix evaluations test`: 21 pass,
  including the packed-plugin journal contract, the product checkers, the
  primary-check plan, the bridge-removal check and the offline replay.
- Installed pinned artifact from an unrelated cwd: `otc validate`, `prepare`,
  `freeze`, `delivery-check`, `run --dry-run` and `status --json` all succeed;
  freeze resolved the verified OpenCode 2.2.6 image ID and recorded the tool
  identity. No provider call.
- `npm pack --dry-run`: includes the modules and `src/SKILL.md`; excludes
  `evaluations/` and `tests/`.
- `defined comply --full` at the recorded head: see the PR checks.

## Outstanding dependency

The vendored tarball is a provisional review artifact until the OTC branch is
merged and the package is published. The agreed order is: OTC merge →
immutable registry publication → this repository's registry pin and final
verification → this PR merge. Until the registry version exists, this draft
stays on the tarball pin. A full dispatched docs campaign and live judging are
not claimed; the offline proof stops at `run --dry-run`, the primary-check
plan, the product checkers and recorded replay.
