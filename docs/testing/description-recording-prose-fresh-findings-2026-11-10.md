---
Area: Testing
Keywords: description-prose, native-description, automatic-notetaking, note-01, note-02, note-03, note-04, held-out, deepseek, glm, structured-judging, prose-comparison
Summary: Six-arm native-description prose comparison under one shared experimental budget, scored by an arm-blind documentation-outcome schema. The previous memory-framing candidate (B, 429 chars) led screening by 6 points and confirmation by 23; the longer purpose, procedure and example rewrites scored at or below control, and one was vetoed by an out-of-policy write.
---

# Native-description prose comparison: six arms, two stages, 2026-11-10

> **Correction (2026-11-10).** This report applies a narrower preservation rule
> than the authorising guardrail. A review of the flagged cache-note rewrites
> confirms that still-valid facts were deleted, so the finalist breaches the
> preservation guardrail and the production-review qualification below is
> withdrawn. The confirmation sessions also ran non-interleaved, so the results
> are exploratory. Original outcomes and judgements are unchanged. See
> [the correction](description-recording-prose-fresh-correction-2026-11-10.md)
> and [the review packet](description-recording-prose-fresh-review-packet-2026-11-10.md).

## Outcome

**Completed both stages.** Six native `docs` description packages ran under one
frozen measurement on current `main` (`5ea4a71`, plugin bytes unchanged since
PR #47). Screening: 48 fresh trials, eight per arm across the four NOTE
scenarios. Confirmation: 40 fresh trials, the finalist and a fresh control
across four sealed held-out scenarios. All 88 scored sessions completed with
usable evidence, and 88 first-attempt structured judgements were collected
(two answers needed a recorded deterministic re-parse; no retry, no model
call).

Default-utility totals: screening A 9, **B 15**, C −1, D −1, E −2, F 4
(guardrail). Confirmation A −11, **B 12** — a lead of 23 points, above the
frozen 5-point prioritisation threshold. B is the 429-character previous
memory-framing candidate; the longer purpose (D, 889), decision-procedure (E, 1168) and example (F, 1343) rewrites did not beat control.

The most important limitation is a scenario effect, not the prose: when trials
rewrote the seeded cache note in held-out H02, both arms deleted valid facts
(control 2/5, finalist 1/5), which the judge classified as misleading. Under a
strict reading of the "destructive loss of valid content" guardrail, both arms
would carry a non-compensable breach and no production recommendation would
follow. The frozen rule counted only policy violations and preserve-list harm,
so that breach was not charged; the choice must be settled before adoption.

## Identities

| Item                                       | Value                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Base                                       | `5ea4a71e9174d638145e16c7f9508357c47542fc`                                   |
| Measurement commit (executed by every arm) | `902a6fe65ecff4cfea0358ae165e21e4f441f003`                                   |
| Plan commit / branch                       | `c69b1000713dddd3dfadd5de92196b0a44d296d8` / `desc-fresh/plan`               |
| Gate-repair commit / branch                | `731fbf8f99d1e18107d12b664c084c43f12d564a` / `desc-fresh/gate-repairs`       |
| Arm commits A/B/C/D/E/F                    | `902a6fe`, `4542790`, `bbc75a2`, `49edaea`, `f12e917`, `3a32fc3`             |
| Plugin content hashes A–F                  | `1b2b0319…`, `04535cf3…`, `743eda21…`, `24850986…`, `104177e6…`, `1033b34d…` |
| Evidence root                              | `/home/mark/tmp/docs-desc-fresh-20261110/` (dev-box only)                    |
| Workhorse / judge                          | `opencode-go/deepseek-v4.1-flash` / `opencode-go/glm-5.3-flash`              |
| Runtime                                    | OpenCode `v2.2.6`, Node `v26.13.0`, image `58505eac…`                        |

Only the native description differs between arms (one `src/index.ts` block);
twin description, skill, convention, package and lockfile are byte-identical.
Annotation payload 1658 characters on every arm.

## Screening (8 trials per arm)

| Arm       | Chars | Total  | Primary P/F | Gate pass/blocked | Useful create/update | Transient | Misleading | Guardrail |
| --------- | ----- | ------ | ----------- | ----------------- | -------------------- | --------- | ---------- | --------- |
| A control | 415   | 9      | 7/1         | 6/2               | 1 / 2                | 1         | 0          | 0         |
| B         | 429   | **15** | 8/0         | 7/1               | 1 / 2                | 0         | 0          | 0         |
| C         | 595   | −1     | 7/1         | 4/4               | 1 / 0                | 1         | 0          | 0         |
| D         | 889   | −1     | 7/1         | 6/2               | 1 / 1                | 1         | 1          | 0         |
| E         | 1168  | −2     | 7/1         | 4/4               | 1 / 1                | 2         | 1          | 0         |
| F         | 1343  | 4      | 7/1         | 5/3               | 2 / 1                | 1         | 1          | 1         |

Observations: every arm except F missed one NOTE-01 create; F's two copies of
the worked create example coincided with 2/2 creates but also with a
misleading Node-22 note and an out-of-policy `work/README.md` edit. C's
NOTE-02 trials made no note at all (gate blocked, not restraint). B matched
the control on creates and beat it on NOTE-02 primary success (2/2 vs 1/2)
and NOTE-03 restraint (2/2 vs 1/2).

## Confirmation (20 trials per arm, sealed scenarios)

| Arm       | Total  | Mean  | Primary P/F | Gate pass/blocked | H01 create | H02 update         | H03 transient | H04 restraint | Guardrail |
| --------- | ------ | ----- | ----------- | ----------------- | ---------- | ------------------ | ------------- | ------------- | --------- |
| A control | −11    | −0.55 | 19/1        | 7/13              | 1/5        | 0/5 (2 misleading) | 1             | 5             | 1 policy  |
| B         | **12** | 0.60  | 20/0        | 9/11              | 3/5        | 1/5 (1 misleading) | 3             | 5             | 0         |

The control's single guardrail was a real failure: it edited
`scripts/format-check.mjs` (out of policy) and failed the pristine check,
where the finalist cleared the cache instead. Both arms read the existing note
in H04 only 3/5 times (docs criterion), and both mostly declined to document
H01/H02 — so the absolute documentation rate stayed low; the arms differ mainly
in whether the occasional note was correct and whether the practical task
survived.

Sensitivity: B ranks first in all nine useful-weight × transient-penalty cells
in both stages. Reclassifying the three NOTE-02 "documented half-fix" outcomes
as useful (the way the control's was scored) leaves B first (15 vs 9).

## Facts

- Six assigned prose packages can be measured under one budget; the longest
  (1343 characters) was delivered byte-exactly in a captured provider request,
  so length alone was not truncated.
- The 429-character memory-framing text led both stages on default utility.
- Longer, more instructional prose did not raise useful recording; the example
  arm traded creates for a misleading note and an out-of-policy write.
- All 88 judgements were arm-blind and evidence-checked; none was retried.

## Inferred

- The benefit observed for B is concentrated in NOTE-02 correctness and
  NOTE-03 restraint, not in raw create volume.
- A prose rewrite cannot fix a task that never surfaces an obvious
  documentation hook: H01/H02 write rates stayed low for every arm.
- The H02 preservation trap suggests retained-content loss is common enough to
  matter as a guardrail, not only as a score penalty.

## Tested

- Deterministic: seeded-fails / intended-fix-passes / plausible-wrong-fix-fails
  for all four held-out scenarios; `--gate-only` gate records; AC schema and
  evidence-consistency tests; `npm test` 738/738; `tsc --noEmit`.
- Readiness: six A01 registration controls (one per arm) and one delivery
  probe; one probe attempt failed before any model call and is preserved.
- Campaign: 48 + 40 trials, 88 gate records, 88 AC judgements, 2 deterministic
  re-parses.

## Failed approaches

- Treating the historical gate alone as the outcome: it blocked 11–13 of 20
  confirmation trials, hiding whether a note was useful or merely absent.
- Assuming "more explicit instruction" helps: C/D/E/F did not beat control.
- Assuming page-level prose alone lifts recording: H01/H02 remained mostly
  undocumented in every arm.

## Open questions

- Should destructive loss of valid content inside a replace target be a
  non-compensable guardrail (which would veto both arms here)?
- Do the H01/H02 scenarios need a stronger natural documentation hook, or is a
  low write rate the honest finding?
- Does the finalist's advantage survive on a scenario set authored by a
  different person, and with the 20 finalist confirmation slots interleaved
  as frozen rather than resumed after the control arm?

## Deviations recorded

- The run-script's path case prevented the 20 finalist confirmation slots from
  starting (exit 127, no model call); they were resumed after the control
  slots. Frozen pair-order alternation was therefore not achieved, which is a
  drift protection this campaign lost. Control slots were preserved untouched.
- `defined comply` failed on the executed measurement commit with 40
  documentation and complexity findings (no behavioural ones). They were
  repaired in `731fbf8`, which the campaign did not execute; both analyses are
  byte-identical before and after the repair.
- Held-out scenarios were authored by the agent that ran the campaign; they
  were sealed from outcome-driven selection, not from authorship.

## Artefacts

- Plan: `docs/testing/description-recording-prose-fresh-plan-2026-11-10.md`.
- Evidence (dev-box): analysis JSON, rendered reports, gate records,
  judgements, resolution records, sensitivity, integrity manifest and logs
  under `/home/mark/tmp/docs-desc-fresh-20261110/`.
