---
Area: Testing
Keywords: prod014, judge, recovery, structured-output, retries, ledger, selection, campaign
Summary: The pd-fresh-20261114T082648Z screen stopped at P05 because the judge's captured JSON ended with a transposed closing sequence, not an unescaped mid-string quote as the handover said. The parser refused it correctly. A complete-but-malformed response is now classified separately from incomplete capture, schema and semantic failures, and an opt-in frozen policy may recover it once under atomic dual budgets; the recovery path was verified through the real launcher, a loopback provider and a materialised campaign.
---

# Judge-output recovery and the S05 malformed capture

Follow-up to campaign `pd-fresh-20261114T082648Z-91c173e` (measurement
`91c173ec774800781fb61ca8ad09c63c740f8820`), which stopped at P05/slot 9
(`pd-A-r0-S05`) on a single unusable judgement. Base revision for the repair:
`2870d901f5b76da955d1f8813b6c030c949c806f` (main).

## Facts

- The failed attempt's raw `output.jsonl` SHA-256 is
  `90e06045cc7d5e6cace645dab1a8818dafb98df8a7b6e1e726757bd9f35bf0d4` and is
  preserved byte-identical as `tests/fixtures/judge-recovery/observed-output.jsonl`.
- The capture is complete: exit 0, `step_start` -> `text` -> `step_finish`
  reason `stop`, 328 output tokens. The extracted text is 1559 UTF-16 units.
- The text fails `JSON.parse` at position 1557: it ends `"}]` where valid JSON
  requires `"]}`. That is a transposed tail bracket (the evidence array is
  never closed), not an unescaped quote inside `documentationReason`. A
  mid-string unescaped quote would fail far earlier; every byte before the
  tail parses cleanly.
- Both extraction paths refuse it identically and correctly: the strict
  `parseAcJudgement` envelope slice and the resolver's escape-aware
  `firstBalancedObject` return the same SyntaxError. The frozen
  first-unusable-assessment rule then stopped the campaign, as designed.
- The CLI route has no structured-output flag (`opencode run --help`, CLI
  2.2.6 in the frozen image). It does deliver configuration-provided output
  controls: `providers.zai-coding-plan.body.response_format` reaches the
  chat-completion request body (loopback capture).
- The adapter retries internally: **one retry was observed** — a 429 answered
  by a subsequent success costs two chat-completion requests for one durable
  judge attempt. The maximum was not established. Attempt accounting and
  HTTP-request accounting are different units; the policy records
  `providerRequestLimit: null` (not exposed) instead of implying a bound it
  cannot enforce.
- The judge wrapper and launcher are frozen campaign inputs, so the closed
  root cannot be re-judged by repaired code: a retrospective assessment would
  need separate authorisation and provenance and is outside this repair.

## Inferred

- The handover's attribution (unescaped quote in `documentationReason`) does
  not match the preserved bytes; the corrected cause is the transposed closing
  sequence, and nothing in the parser or transport was at fault.
- A judge that returns complete-but-malformed JSON is a model-output failure,
  not an infrastructure failure; recovering it with one fresh blind assessment
  of the same packet is the proportionate remedy.

## Tested

- The observed bytes stay invalid and are retained; the same response with the
  structurally valid closing sequence parses and validates.
- Taxonomy: complete malformed -> `json-syntax`; a trail without a terminal
  step finish (or one that ends before the final text) -> `empty-or-truncated`;
  schema and semantic failures classified separately; process failures ->
  `transport-or-process`.
- Policy and selection: only a complete `json-syntax` failure is eligible;
  adversarially tampered selection records, ineligible classes, incomplete
  capture, replaced first assessments and recalculated facts are refused.
  Concurrent claims cannot exceed either the recovery or the total judge
  ceiling, and the loser's reservation is returned.
- Materialised driver: malformed -> recovered attempt-002 with a matching
  packet hash, two trial launches, one recovery; two malformed answers stop
  without a third call; no policy, spent budget, incomplete capture and a
  closed ledger dispatch nothing; a repeated run does not re-dispatch.
- Analyser, closure, reconciliation, status text and status JSON agree on the
  selected attempt, the recovery counts and the budgets; unknown judge
  telemetry stays null.
- Real-launcher rehearsal (`prod014/campaign/rehearsal/`): loopback provider
  counting chat vs readiness requests: valid 1 request, malformed 1 request,
  429-then-success 2 requests, response_format delivered; driver scenarios as
  above with 3 requests for valid -> malformed -> recovered -> continuation.
  The rehearsal now reads completion and packet identity from each attempt's
  `meta.json` and checks them: judged and malformed attempts both report
  `completion.complete: true` and a recorded packet hash, and the recovery
  matches the first attempt's packet. The regenerated report
  (`reportKind: "regenerated"`, `originalReport` naming the preserved original)
  kept the original run's request counts unchanged.
- `npm test` 1337 pass / 0 fail; `npm run typecheck` clean; `recovery.ts`
  coverage 100% lines / 98.7% branches / 100% functions.

## Failed approaches

- Permissive repair, regex quote insertion and a second model guessing the
  verdict were rejected: each would have changed the assessment rather than
  preserving it.
- Relying on `spawnSync` to run the real CLI in the rehearsal hung the judge:
  its private stdio server waits for stdin to close, and the synchronous pipe
  never closes. Async spawn with ignored stdin is the faithful harness
  boundary.

## Open questions

- Whether a future paid screen values the recovery capability enough to
  register the 16 + 2 = 18 policy is a separate spend decision; this repair
  authorises no call.
- The measurement branch's status counting fixes (judge-exit status and the
  campaign family label) remain required before the next agents-screen
  campaign reads its status.
