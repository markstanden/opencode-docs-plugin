---
Area: Testing
Keywords: prod014, typescript, harness, contracts, strict, migration, replay, evidence
Summary: The live prod014 campaign chain now runs typechecked .mts programs, with boundary JSON validated instead of cast. Historical replay keeps its frozen .mjs bytes. A fresh offline A/B pair through the real container and judge adapters reproduced the repaired positive result, and the historical P04 root still replays to the same inconclusive screen.
---

# Strict TypeScript for the live campaign harness (2026-11-12)

## Facts

- Base: `64fd0e1520cf1ad90efd0fbdc89fd0c6f8c0d02a` (the judge-path repair on
  `ae7bf1c`). The migration is a separate branch so it can be reviewed and
  landed apart from that fix.
- The live command chain moved from `.mjs` to `.mts`: `materialise`, `schedule`,
  `surfaces`, `delivery-probe`, `freeze`, `run`, `rejudge`, `close-campaign`,
  `runner-regression`, the `env` helper, the judge wrapper `ac/run`, and the
  eight prod014 primary checks. `npm run typecheck` now checks every one; the
  package still has no build step.
- A shared `campaign/active/contracts.mts` reads schedules, manifests, freeze
  records and their ceilings as `unknown` and validates each field the
  commands use. Journal operations and judge packets keep the existing
  validators (`journal.ts`, `ac-scoring.mts`).
- `prod014/campaign/runner/*.ts` are typecheck-only re-exports of the pinned
  analysis modules. A materialised campaign supplies the real files at
  `../runner/`; the source copies are never imported at runtime.
- Historical replay kept its bytes: `scripts.json`, `replication/cases.json`
  and their `.mjs` primary checks are unchanged. The live corpus uses the
  `.mts` checks; `container-run.sh` ships whichever shared helper each check
  imports.
- The shared reader distinguishes a missing file from a failed read: only
  `ENOENT` returns an empty string, so a directory, permission error or I/O
  failure throws. Usage accounting catches it, keeps steps and tokens unknown
  and publishes the read problem; the ledger parsers convert it to a malformed
  ledger, which refuses a launch, a recovery judgement and a close before
  dispatch or publication.
- The fresh snapshot was regenerated (`--snapshot`): 13 active sources and the
  same six pinned runner hashes. `runner.json` is byte-identical. The corpus
  (`prod014/cases.json`) changed only its `primaryCheck.script` values, so its
  hash and the primary-check source hashes change; prompts, truth and the
  budget are unchanged.
- Rehearsal, zero paid calls: fresh root
  `/home/mark/pd-strict-ts-canary-20261112T182923Z`, arms at the migration
  commit and its B patch (`ada7bb15`), real materialisation, generation,
  delivery probes, freeze (image `58505eac2fe9`), one A→B pair through the real
  trial container and real judge launcher, with a local provider on
  `127.0.0.1:8899`. Result: 2 trials, 2 judge attempts, 1 complete pair,
  A `none` (gate-blocked), B `useful-create` with a verified write to
  `ops/rehearsal-note.md`; analyser `inconclusive` at 1/8 coverage. Five
  provider bodies captured, two of them judge packets, none containing a
  `/home/...` path.
- Offline replay of the historical P04 root
  `/home/mark/tmp/docs-prod014-20261111T181252Z` with
  `--allow-legacy-unbound` still publishes `inconclusive`, control 4/8 and
  candidate 4/8, matching the recorded checkpoint.

## Inferred

- The rename is a fresh-campaign change: a frozen campaign's inventories pin
  the old `ac` and `prepare` filenames, so it must replay with the historical
  `scripts.json` rather than be resumed on the new chain.
- `prod014/build.mjs` stays a generation fixture (not executed by a campaign)
  but its reused-case helper now emits `.mts` primary script names.

## Tested

- `npm run typecheck` clean; `npm test` 1155 pass, 0 fail in a signing-free git
  environment (the materialised suites commit fixture repos).
- The rehearsal above, including provider-body inspection for host paths.
- Directory-at-path regressions: an unreadable trail keeps totals unknown with
  the problem exposed, a readable empty trail stays a known zero, and an
  unreadable ledger refuses `run` and `rejudge` before any dispatch.
- `defined comply` after the fence refactors.
