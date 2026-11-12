---
Area: Testing
Keywords: prod014, deepseek, attribution, journal, add-string, screen, stop
Summary: A fresh 0.14.0 A/B screen at 8cfa0ed stopped at slot 4: the model supplied the add argument as a JSON string, OpenCode decoded it before execution, and the journal verifier's strict input equality rejected the write line, refusing the P02 arm-A judgement. P01 completed with both arms useful-create; B applied the S02 retrieval while A modified the preserved note.
---

# Prod014 fresh screen: string-form `add` breaks journal attribution (2026-11-12)

Fresh eight-pair screen at `8cfa0ed8139bbb0be98e1400c5484eb33fc4b94b`,
comparing unmodified 0.14.0 A with the existing `assets/b-prod014.txt`
candidate B. Campaign `pd-fresh-20261112T193530Z-8cfa0ed`, root
`/home/mark/tmp/docs-prod014-20261112T193530Z`. It stopped at slot 4 (P02,
arm A); no P04 checkpoint was reached.

## Facts

- Freeze clean: A 415 chars `c3903c7d…`, B 739 chars `6d1d6e47…`, delivered
  hashes matched the registered ones; image `58505eac2fe9`; 16 slots,
  `attempt-001`; budgets 16 trials / 16 judges.
- P01 (R01) completed with both arms judged `useful-create` (utility 5 each),
  gate and primary pass. A wrote `docs/parsing/csv-bom.md`; B wrote
  `docs/importer/csv-bom.md`.
- P02 (S02, retrieval only) B completed: read `ops/staging-deploy.md`,
  left it untouched, applied the detail in `work/deploy/staging.json`,
  judged `none` with retrieval `applied`.
- P02 A ran: read the same note, then replaced it with an `add` that added
  the `steps` array detail, and edited `work/deploy/staging.json`. The gate
  blocked (`preserved lakes/docs/ops/staging-deploy.md was modified`); the
  primary check passed.
- The judge refused before dispatch: `the operation journal is not
attributable: 1 line(s) rejected`. Offline replay: lines 0 (search) and 1
  (read) credited; line 2 rejected as `no-host-dispatch`.
- Journal line 2 records `input.add` as an object; `tools.jsonl` and
  `stdout.jsonl` record `input.add` as a JSON string. `consumeDispatch()`
  compares with `isDeepStrictEqual`, so they never match.
- The plugin received the decoded object: `modeOf()` would refuse a string,
  yet the journal is `completed`, `written: true`, and the file changed.
- The 2026-11-11 campaign's `tools.jsonl` recorded `add` as an object, so
  this shape passed there. No verifier code changed in this campaign.
- Spend: 4 trial launches (12 remain), 3 judge attempts reaching inference
  plus 1 refused before dispatch (13 remain), 2 free fake-provider delivery
  probes, no recovery calls. Trial tokens 68,089 in / 4,413 out / 1,519
  reasoning / 251,776 cache-read over 36 steps; judge 5,695 in / 1,289 out /
  1,057 reasoning over 3 steps.
- Analysis of the partial state: `inconclusive`; coverage A 1/8, B 2/8;
  utility A 5, B 5; recording A 1/4, B 1/4; retrieval A 0/5 (1 unknown),
  B 1/5; 1 complete pair, a tie.

## Inferred

- The mismatch is a measurement gap at the host-trail boundary, not plugin
  misbehaviour: the runtime coerces a JSON-string `add` into the struct, and
  only the pre-decode form reaches the trail.
- A rejudge of this evidence would refuse identically, so recovery cannot
  rescue the slot; the frozen protocol needs a fresh root after a repair.
- A's unprompted write to a retrieval-only note is genuine behaviour, but
  it is gate-blocked evidence and not a scored outcome.

## Tested

- `verifyOperationsJournal` replayed offline over
  `gen/a/results/pd-A-r0-S02/S02`: credited 2, rejected 1
  (`no-host-dispatch`), no other problems.
- The analyser ran once over the partial campaign and published
  `inconclusive` with no model calls.

## Open questions

- Whether to normalise a JSON-string `add` at verification or reject the
  string form at the model boundary. Either is a protocol change and needs a
  fresh freeze.
- Whether a new 16-launch ceiling or the remaining 12 trials / 13 judges
  applies to the follow-up commission.
