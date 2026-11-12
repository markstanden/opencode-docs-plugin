---
Area: Testing
Keywords: productivity-screen, prod014, deepseek, harness-repair, launch-boundary, evidence-boundary, freeze, closure, run-card
Summary: Offline repairs to the 0.14.0 productivity-screen harness. The launch boundary now parses the ledger structurally and claims trial and judge budget exclusively, one selector drives every consumer, credit is bound to the changed document and a declared lake, the paired screen is the single decision, the journal is verified once, and closure is derived from durable evidence. A full container rehearsal was not run; the materialised runner, analyser and materialiser contract regressions were.
---

# 0.14.0 productivity-screen harness repair (2026-11-12)

Offline work only. No paid trial, judge or delivery-model call was made. The
historical campaign `/home/mark/tmp/docs-prod014-20261111T181252Z` was treated
as read-only and none of its evidence, attempts, freeze or human-review
mapping was changed.

## Facts

- Reproduced from `main` at `0ed70331c9873d88d7c1c845f60676ed5ad9f025`
  (tree `844a0bec09e532f5aa5482bbd7c5a409afb7de77`), on branch
  `repair/prod014-harness-d1-d10`. `origin/main` had not advanced.
- Decision-bearing harness code is now strict TypeScript under
  `tests/fixtures/placement-harness/analysis/`: `ledger.ts`, `budget.ts`,
  `selector.ts`, `journal.ts`, `freeze.ts`, `closure.ts`.
- `prod014/campaign/materialise.mjs` verifies `scripts.json`, copies the six
  modules at the hashes pinned in `campaign/runner.json`, and refuses a hash
  mismatch. Materialised `run.mjs` and `rejudge.mjs` import those modules.
- `npm test` runs the new contract and materialised-CLI regressions on CPU.
  1086 tests pass; typecheck passes; `defined comply` and `defined verify`
  report compliant in a clone (the gate does not support a linked worktree).
- The normal shell/shim path is exercised by the existing materialised
  `runner-regression.mjs`: closed campaign, preserved recovery attempt and
  non-executable shim all refuse without a launcher call.

## D1–D10 mapping

| Finding | Repair | Regression |
| --- | --- | --- |
| D1 attempt selection | One selector with manifest precedence, default `attempt-001`, contradiction refusal before spawn or ledger write; recovery needs its own explicit id | `campaign-launch-boundary.test.ts` "attempt selection"; `campaign-materialised-launch.test.ts` conflicting override |
| D2 credit binding | A verified write requires a completed plugin add for the one useful changed lake document, correct change kind, useful judgement and gate pass; two changed documents stay unknown | `analysis-measures.test.ts` recording group; `campaign-credit-binding.test.ts` |
| D3 retrieval packet gap | Retrieval credit needs a declared nonblank lake, exact lake/path result, primary pass and judge-applied detail; lake-less declarations fail preflight | `analysis-measures.test.ts` retrieval group and declaration preflight |
| D4 paired decision | Candidate-only misleading in a paired scenario defeats promotion at equal aggregates; dead heat gives no promotion | `campaign-decision-authority.test.ts` |
| D5 output authority | The screen is computed once and republished in the Markdown headline, `analysis.json` and the screening block; utility threshold stays one labelled component | `campaign-credit-binding.test.ts` cross-output; `analysis-report.test.ts` first outcome line |
| D6 evidence boundary | Journal MAC, run identity and one-to-one host-dispatch matching live in `journal.ts`; harness and analyser consume it; `meta.answerHash` is checked with the producer's byte convention | `campaign-evidence-boundary.test.ts`; harness journal tests |
| D7 freeze | `freeze.ts` freezes once, refuses started/dirty/second freezes and swapped descriptions, consumes the raw delivery request, and verifies files, image and CLI | `campaign-freeze.test.ts` |
| D8 launch boundary and spend | Structural ledger parsing (`open`/`closed`/`malformed`/`missing`); exclusive trial and judge claims with independent ceilings; reservations survive a crash and block re-entry | `campaign-launch-boundary.test.ts`; `campaign-materialised-launch.test.ts`; materialised runner regressions |
| D9 reusable TypeScript | Six decision modules are checked, pinned and materialised; the historical scripts remain replay data | materialiser mode/hash test; `runner.json` pin |
| D10 accounting and closure | Closure derives attempts, inference, steps, per-field token coverage and duration from slots/claims/attempts; known zero differs from unavailable; a partial campaign closes at its real scope and cannot reopen | `campaign-closure.test.ts`; budget claim tests |

## Tested

```sh
npm test
npm run typecheck
defined comply        # in a clone, not a linked worktree
node tests/fixtures/placement-harness/prod014/campaign/materialise.mjs <fresh-root>
CAMPAIGN_ROOT=<fresh-root> node <fresh-root>/prepare/runner-regression.mjs
```

Observed: 1086 tests pass, zero fail; typecheck clean; gate compliant. The
materialised regression ran with counts: closed campaign exit 2 with zero
launcher calls and unchanged ledger; a failed recovery attempt exit 2 with zero
launcher calls; a judged recovery exit 0 with zero duplicate calls; a
non-executable shim exit 2 with zero launcher calls.

A disposable tree with the paired veto bypassed made the swap test fail for
exactly that reason (7 pass, 1 fail: "gives no promotion even when a paired
swap hides equal aggregates"), which is the intended counterexample.

## Run card

Fresh root, no manual manifest edit, no hand-extracted delivery file:

```sh
export CAMPAIGN_ROOT=/home/mark/tmp/docs-prod014-<fresh-stamp>
mkdir -p "$CAMPAIGN_ROOT"
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
# freeze reads evidence/delivery-<arm>/request-1.json directly
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/freeze.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/run.mjs" --pair-from 1 --pair-to 4
# only after the manifest declares attempt-002, or with no conflicting flag:
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/run.mjs" --pair-from 5 --pair-to 8 --attempt-id attempt-002
```

B is still the previous P04 candidate: 739 native characters against 600, and
2407 combined against 2100. A future campaign ceiling is 16 DeepSeek launches
and 16 blind GLM Flash attempts, stopping on the first unusable assessment or
broken premise.

## Compatibility limits

- The materialised `freeze.mjs` reads the real delivery request but does not yet
  call `freezeExperiment`/`verifyFreeze`; its exclusive-write and resume
  verification behaviour is provided by the tested module, not yet wired into
  the command. Treat the freeze command as improved, not complete.
- `close-campaign.mjs` still carries the historical P04 closeout logic;
  `closure.ts` is the tested replacement but is not yet the materialised
  closer. Accounting and reopening rules are proven at module level only.
- The remaining historical scripts in `scripts.json` are still data; only the
  launch/selection, journal, freeze, closure and accounting decisions have
  been extracted. Shell and process glue stays shell.
- Legacy evidence without a retrieval lake now parses as malformed and reports
  `inconclusive`; it is never given an inferred lake. Replaying the preserved
  P04 evidence therefore needs the historical measurement file, and its counts
  remain the previously published ones.

## Costs and timings

Zero model calls and zero provider spend. `npm test` takes about 75 s on this
host; `defined comply` about 100 s in the gate container (coverage dominates).
No live speedup, token saving or delivery change is claimed.

## Open questions

- Whether to wire `freeze.mjs` and `close-campaign.mjs` to the tested modules
  before any authorised campaign. Until then the freeze/closure commands are
  only partially protected.
- Whether the full eight-pair rehearsal should run through the real container
  boundary; it was not run here, so the container/provider seam is unproven
  for this revision.
- Whether a legacy measurement declaration without lakes should be migrated or
  re-declared before replaying P04.
