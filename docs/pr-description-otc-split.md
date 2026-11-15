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
- Pins the dev-only OTC tooling to the **exact published version** `0.1.0`
  (no range) and records its provenance: registry integrity
  `sha512-5dhOJwj4UgxLnOdLoW/gMeLnJ2lU0A8aDj2h5cIwo/iV5hULvrLogE6Ihjom07TzenE/ZOJZ6WPfzqx3iulXZg==`,
  shasum `c336020f…`, published 2026-11-15T14:13:49.115Z by `markstanden`,
  published `gitHead` `f56092f` (squash merge of OTC PR #1; tree identical to
  the reviewed `287e30a`). The registry tarball is byte-identical
  (SHA-256 `a3731bb5…`) to the reviewed artifact, and `npm audit signatures`
  verifies the registry signature. The vendored tarball is deleted; the
  lockfile integrity is the pin, and a test fails if a range or file
  dependency returns.
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
- `npm --prefix evaluations ci && npm --prefix evaluations test`: 22 pass,
  including the packed-plugin journal contract, the product checkers, the
  primary-check plan, the bridge-removal check, the exact-pin guard and the
  offline replay. The install resolves from the public registry, and
  `npm audit signatures` verifies the package signature.
- Installed published artifact from an unrelated cwd: `otc validate`,
  `prepare`, `freeze`, `delivery-check`, `run --dry-run` and `status --json`
  all succeed; freeze resolved the verified OpenCode 2.2.6 image ID and
  recorded the tool identity. No provider call.
- `npm pack --dry-run`: includes the modules and `src/SKILL.md`; excludes
  `evaluations/` and `tests/`.
- `defined comply --full` at the recorded head: see the PR checks.

## Sequencing

OTC PR #1 is merged (`f56092f`) and `0.1.0` is published with the integrity
above; this repository is on the exact registry pin and the vendored tarball is
deleted. The remaining step is this PR's exact-head final verification and
merge. A full dispatched docs campaign and live judging are not claimed; the
offline proof stops at `run --dry-run`, the primary-check plan, the product
checkers and recorded replay.
