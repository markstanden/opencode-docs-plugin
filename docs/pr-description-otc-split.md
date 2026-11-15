# PR — split docs plugin internals and add the evaluation bundle

## Summary

- Splits `src/index.ts` (5,270 lines) into focused modules without changing the
  public entry point, tool/command/skill descriptions, prose, journal bytes,
  locking behaviour, package identity or Node support:
  `metadata`, `ranking`, `collection`, `convention`, `lakes`, `journal`.
- `src/index.ts` re-exports the public names and keeps host registration; it is
  now ~355 lines.
- Adds `evaluations/` as the product-side bundle index and the dev-only,
  pinned OTC tooling. Ordinary tests and the published tarball do not include
  it.
- Adds a cross-project contract test proving the plugin's signed journal is
  credited by the pinned OTC evaluator.
- Updates placement command/skill routing: unregistered sweeps only;
  registered campaign authority unchanged; new campaigns use OTC.

## Proof

- `npm test`: 1344 tests pass.
- `defined comply --full`: compliant at the recorded head; coverage 97.4 line,
  91.1 branch, 98.3 function against the existing 95/90/95 floors.
- `npm pack --dry-run`: includes all six new `src` modules and `src/SKILL.md`;
  excludes `evaluations/` and `tests/`.
- `npm --prefix evaluations ci && npm --prefix evaluations test`: the
  cross-project journal contract passes.

## Follow-ups

- Replace the vendored OTC tarball with the published immutable version when
  the package is released; remove the tarball then.
- The prod014 route remains frozen until an OTC campaign reaches parity; owner
  and removal condition are in `evaluations/README.md`.
