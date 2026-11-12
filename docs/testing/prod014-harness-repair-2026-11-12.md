---
Area: Testing
Keywords: productivity-screen, prod014, deepseek, harness-repair, launch-boundary, evidence-boundary, freeze, closure, rehearsal, run-card
Summary: Offline repairs to the 0.14.0 productivity-screen harness, rehearsed through the real container seam with local provider and judge fakes. The launch boundary parses the ledger structurally and claims trial and judge budget exclusively, one selector drives every consumer, credit is bound to the changed document and a declared lake, the paired screen is the single decision, the journal is verified once, freeze and closure are wired into the materialised commands, and an eight-pair fake-provider run produced 8 pairs, 16 trials and 16 judge attempts with no paid call.
---

# 0.14.0 productivity-screen harness repair (2026-11-12)

Offline work only. No paid trial, judge or delivery-model call was made. The
historical campaign `/home/mark/tmp/docs-prod014-20261111T181252Z` was treated
as read-only and none of its evidence, attempts, freeze or human-review
mapping was changed.

## Facts

- Reproduced from `main` at `0ed70331c9873d88d7c1c845f60676ed5ad9f025`
  (tree `844a0bec09e532f5aa5482bbd7c5a409afb7de77`), branch
  `repair/prod014-harness-d1-d10`. `origin/main` had not advanced.
- Decision-bearing harness code is strict TypeScript under
  `tests/fixtures/placement-harness/analysis/`: `ledger.ts`, `budget.ts`,
  `selector.ts`, `journal.ts`, `freeze.ts`, `closure.ts`.
- `prod014/campaign/materialise.mjs` verifies `scripts.json`, copies the six
  modules at the hashes pinned in `campaign/runner.json`, and refuses a hash
  mismatch. Materialised `run.mjs`, `rejudge.mjs`, `freeze.mjs` and
  `close-campaign.mjs` import those modules.
- The materialised freeze refuses a second freeze, refuses a started or dirty
  experiment, and records every immutable input plus the image and CLI actually
  used. Run, continuation and recovery verify that record before any spend.
- The materialised closer derives pairs, launches, judge attempts, inference,
  per-field tokens and durations from the schedule, claims and result
  directories. It no longer slices eight slots or hard-codes P04 counts.
- `npm test` runs the contract, materialised-CLI and rehearsal-adjacent
  regressions on CPU. Typecheck passes; `defined comply` and `defined verify`
  report compliant in a clone (the gate does not support a linked worktree).

## Rehearsal through the container seam

Fresh root `/tmp/opencode/rehearsal2`, the real materialiser, the real
`prepare/shim` on `PATH`, the real `localhost/opencode-placement-trials`
container and the real analyser. The provider boundary was a local fake on
`127.0.0.1:8899` (response `Done.`) and the judge launcher was a local fake
emitting a fixed `judged` payload. Arm A was the current 415-character native
description; arm B was the patched 739-character candidate. Zero paid calls.

- Clean P04: 4 pairs, 8 trial launches, 8 judge attempts, 8 provider requests,
  18.7 s wall time.
- Clean P08 (same root, pairs 1–8): 8 pairs, 16 trial launches, 16 judge
  attempts, 16 provider requests, 37.1 s wall time.
- The fake judge emits no model step events, so `judge.reachedInference` is 0
  for the rehearsal while 8 judgements are usable. The inference distinction is
  covered by `campaign-closure.test.ts` with a failed-auth fixture.
- Interrupted copy `/tmp/opencode/rehearsal3` after P04: a durable trial claim
  for `pd-A-r0-S05` was left unresolved. Restart refused the slot
  ("unsettled trial claim; no duplicate call is authorised"), made zero
  provider calls, and appended only the blocker event; no launch or judge
  spawn occurred.
- Closing the clean P04 root produced 4 completed pairs, 8 launches, 8 judge
  attempts, 8 usable judgements and 8 unrun slots. After closure, `run.mjs` and
  `rejudge.mjs` both refused, made zero provider calls, and left
  `ATTEMPTS.jsonl` byte-identical.
- The analyser read the same root and published `no-promotion` with complete
  pairs (8/8) and zero recording/retrieval credit, because the fake model made
  no useful change. That is the independently expected decision for a dead
  heat; the utility-threshold component said `qualified`, which is exactly why
  it is labelled a component.

Rehearsed revision: `022f0cec6da8ae75707e4e5ad77cd72fa581e8a6`. Later commits
are documentation only.

## D1–D10 mapping

| Finding                | Production entry point                              | Named regression                                                                | Observed                                                            |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D1 attempt selection   | materialised `run.mjs`/`rejudge.mjs` selector       | `campaign-launch-boundary`, `campaign-materialised-launch`                      | pass                                                                |
| D2 credit binding      | `analysis/measures.ts` via analyser CLI             | `analysis-measures`, `campaign-credit-binding`                                  | pass                                                                |
| D3 retrieval lake      | `parseMeasureDeclarations` + analyser               | `analysis-measures` preflight                                                   | pass                                                                |
| D4 paired decision     | `personalTrialDecision`                             | `campaign-decision-authority`                                                   | pass                                                                |
| D5 output authority    | `render.ts`, `analyse.mts` screening block          | `campaign-credit-binding`, `analysis-report`                                    | pass                                                                |
| D6 evidence boundary   | `analysis/journal.ts`, `records.ts`, harness        | `campaign-evidence-boundary`, analyser-key CLI test                             | pass                                                                |
| D7 freeze              | materialised `freeze.mjs` + `run.mjs`/`rejudge.mjs` | `campaign-freeze`, `campaign-materialised-freeze`                               | pass                                                                |
| D8 launch/spend        | materialised `run.mjs`/`rejudge.mjs`                | `campaign-launch-boundary`, `campaign-materialised-launch`, `runner-regression` | pass                                                                |
| D9 reusable TypeScript | `runner.json` + materialiser                        | materialiser mode/hash, generation parity                                       | partial: six decision modules moved; historical scripts remain data |
| D10 accounting/closure | materialised `close-campaign.mjs` + `closure.ts`    | `campaign-closure`, `campaign-materialised-closure`                             | pass                                                                |

## Acceptance reconciliation

1. **Launch boundary and attempt selection.** Wired and tested at module and
   materialised-CLI level; closed, malformed, conflicting and unsettled states
   refuse before spawn. Judged.
2. **Evidence boundary.** One typed verifier is reached by the harness and by
   the analyser CLI; answer hash binding is tested. Trial-child environment
   stripping and judge-packet blinding were not exercised in the rehearsal
   (the fake judge never saw a real packet); outstanding.
3. **Precise credit.** Recording is bound to the changed lake document and
   retrieval requires a declared lake; both have positive controls and
   counterexamples. Judged.
4. **Authoritative paired decision.** One screen across headline, JSON and
   screening output; the veto-bypass counterexample fails for the intended
   reason. Judged.
5. **Freeze.** Exclusive, delivery-driven, verified at launch/resume/rejudge;
   changed rubric and rebuilt image both refuse with zero spawns. Judged.
6. **Accounting and closure.** P04 and P08 close independently from evidence;
   closed roots cannot be reopened. Judged.
7. **Reusable TypeScript and data fixtures.** Six decision modules are checked
   and materialised; the generator now matches the canonical fixtures (parsed
   parity) and R02/S07 facts are asserted independently. Remaining shell glue
   and historical scripts are not decision logic. Partial but bounded.
8. **Cheap suite.** New contract and materialised-CLI regressions run under
   ordinary `npm test`. Judged.

## Tested

```sh
npm test
npm run typecheck
defined comply        # in a clone, not a linked worktree
defined verify
```

Observed: 1100 tests pass, zero fail; typecheck clean; both gate verbs
compliant. Materialised regression counts: closed campaign and bad shim exit 2
with zero launcher calls; failed recovery exit 2 with zero calls; judged
recovery exit 0 with zero duplicate calls.

## Run card

Fresh root, no manual manifest edit, no hand-extracted delivery file:

```sh
export CAMPAIGN_ROOT=/home/mark/tmp/docs-prod014-<fresh-stamp>
mkdir -p "$CAMPAIGN_ROOT/evidence"
node tests/fixtures/placement-harness/prod014/campaign/materialise.mjs "$CAMPAIGN_ROOT"
# campaign-local key, chmod 600; never committed
printf 'ZAI_API_KEY=%s\n' "$(cat ~/.config/secrets/<your-key>)" > "$CAMPAIGN_ROOT/.env"

CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/schedule.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" bash "$CAMPAIGN_ROOT/prepare/generate.sh"
node "$CAMPAIGN_ROOT/prepare/surfaces.mjs" <arm-a> "$CAMPAIGN_ROOT/evidence/surfaces-a.json"
node "$CAMPAIGN_ROOT/prepare/surfaces.mjs" <arm-b> "$CAMPAIGN_ROOT/evidence/surfaces-b.json"
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mjs" \
  "$CAMPAIGN_ROOT/evidence/delivery-a/capture.json" <arm-a> \
  opencode-go/deepseek-v4.1-flash "Hello." 8801
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mjs" \
  "$CAMPAIGN_ROOT/evidence/delivery-b/capture.json" <arm-b> \
  opencode-go/deepseek-v4.1-flash "Hello." 8802
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO=<measurement> \
  node "$CAMPAIGN_ROOT/prepare/freeze.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/run.mjs" --pair-from 1 --pair-to 8
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/close-campaign.mjs"
```

Pass `--attempt-id` only when it agrees with the manifest's
`assessment.attemptId`; a contradiction refuses before spend. The delivery
probe writes `request-1.json` beside its capture and freeze reads that raw
request.

B is still the previous P04 candidate: 739 native characters against 600, and
2407 combined against 2100. A future campaign ceiling is 16 DeepSeek launches
and 16 blind GLM Flash attempts, stopping on the first unusable assessment or
broken premise.

## Compatibility limits

- The fake judge produced no model steps, so the rehearsal's judge-inference
  and token totals are not comparable with a real judge run. Real-run token
  coverage and wall time remain unmeasured.
- Trial-child environment stripping and judge-packet blinding were not
  exercised end to end; the label-leak and packet tests are unit-level.
- `dry-check.mjs` and `cli-measures.mjs` remain historical synthetic scripts in
  `scripts.json`; they are not part of `npm test`.
- Legacy evidence without a retrieval lake parses as malformed and reports
  `inconclusive`; it is never given an inferred lake.

## Costs and timings

Zero model spend. Rehearsal: P04 18.7 s, P08 37.1 s, 16 provider requests (all
local). `npm test` about 75 s on this host; `defined comply` about 100 s in the
gate container (coverage dominates).

## Open questions

- Whether to strip arm labels from trial child environments and exercise the
  real judge packet in a future authorised campaign.
- Whether the remaining historical scripts in `scripts.json` should be deleted
  or retained as replay data after this campaign closes.
- Whether a real judge run reproduces the expected `no-promotion` decision on
  the same eight pairs.
