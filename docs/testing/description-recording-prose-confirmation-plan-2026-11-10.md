---
Area: Testing
Keywords: description-prose, confirmation, r01, r02, r03, r04, paired-schedule, preservation, deepseek, glm
Summary: Frozen 40-session paired confirmation of the exact A and B native `docs` descriptions on the repaired R01–R04 corpus, with adjacent A/B pairs, evidence protection and an evidence-backed semantic R02 preservation assessment.
---

# Native-description A/B confirmation: frozen plan, 2026-11-10

Frozen before the first scored session of campaign `rc-20261110`. This is a new
experiment on revised, previously developed scenarios. It is **not** independent
scenario validation, not a repair of the historical campaign and not poolable
with any earlier run. Five repetitions of one scenario are not five scenarios.

## Question

Does exact B improve weighted useful documentation relative to exact A on the
repaired R01–R04 corpus, with correctly interleaved execution, visible
permissions and reliable semantic preservation measurement?

## Exact intervention

| Arm | Native chars | SHA-256                                                            |
| --- | ------------ | ------------------------------------------------------------------ |
| A   | 415          | `c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c` |
| B   | 429          | `09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e` |

The bytes are read from `replication/assets/a.txt` and `b.txt`; the arm B
description is written by replacing the exact control block. Both arms register
the same twin description (325 chars, `a100567b…`), the same 1658-character
annotation payload, the same skill bytes and the same plugin logic. The only
difference is the native description.

| Identity                       | Value                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Base / readiness commit        | `0a9116fe264a54be213875bef02ed355178afef0` (tree `100bb899…`)                                                |
| Arm A commit / tree            | `0a9116f` / `100bb89942615ad737229450c4d18017b182aa83`                                                       |
| Arm B commit / tree            | `352f5aafa010b0e66ee02888152f197a9cc27b02` / `c493e43652261ab1f6a82d15c1ba7cfe7f336b03`                      |
| Arm tree difference            | `src/index.ts` only (1 insertion, 8 deletions: concatenation → single literal)                               |
| Registered A plugin / combined | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` / 2073 chars                              |
| Registered B plugin / combined | `04535cf3b9efece2edb9cc72e1dbbe57fa36e269688623c9d6eac61ee30bbd88` / 2087 chars                              |
| Corpus                         | `911b4e1fab9e6c87f4875339fc29bc03dd7929bcbc4991adee909bd7265568df`                                           |
| Truth                          | `066615127cbb629ff160f2cf9e1f251bde6f1f3cbfd1b055ec6b9495aefed3d5`                                           |
| Schedule (slots / file)        | `a1ca0dcf3d939c325fb5bc8374388d655217abe10b698cff7eb126b6b0e881e8` / `2a20bcd5…`                             |
| Workhorse / judge              | `opencode-go/deepseek-v4.1-flash` / `opencode-go/glm-5.3-flash`                                              |
| Runtime                        | OpenCode `v2.2.6`; Node `v26.13.0`; image `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb` |
| Campaign root (dev box only)   | `/home/mark/tmp/recording-confirm-20261110`                                                                  |

Both arms are clean worktrees. Their `src/index.ts` bytes are identical to the
arms executed in the stopped replication (diff empty), so the intervention is
the same even though the harness revision is the merged, repaired one.

## Scenarios

| Case | Opportunity       | Task                                                                                    |
| ---- | ----------------- | --------------------------------------------------------------------------------------- |
| R01  | useful create     | vendor CSV carries a UTF-8 BOM; strip only the leading BOM                              |
| R02  | useful correction | TLS must be required; preserve pool 10, 5-second acquire timeout and startup migrations |
| R03  | transient only    | stale machine-local `.tmp/dev.sock`; tracked-file restriction visible, docs permitted   |
| R04  | already covered   | repaired migration-lint premise; the deliberate lexical report is not a real defect     |

R01–R04 were authored by earlier agents after reading prior findings. They are
newly developed holdouts, not independent validation.

## Permission visibility

Every write restriction is in the task, and every evaluator `mutationPolicy`
rule maps to a visible instruction. The standing permission authorises
"create or update" documentation only, so deleting an existing lake document
is outside the communicated permission even where the mutation policy would
allow a lake write.

| Case | Visible instruction                                              | Evaluator rule                     | Semantic reading                                     |
| ---- | ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| R01  | code to `src/`; docs to the lake; nothing else tracked           | `work/src/**`, `lakes/docs/**`     | both permissions and the general prohibition visible |
| R02  | code to `src/`; docs to the lake; pool facts unchanged           | `work/src/**`, `lakes/docs/**`     | both permissions and the fact constraint visible     |
| R03  | remove `.tmp/dev.sock`; docs permitted; tracked files untouched  | `work/.tmp/**`, `lakes/docs/**`    | cleanup and docs permitted; `package.json` named     |
| R04  | migrations untouched; only `scripts/` may change; docs permitted | `work/scripts/**`, `lakes/docs/**` | edit permission and migration prohibition visible    |

`preserve` rules protect seeded documents from destructive loss; that is a
guardrail on unauthorised deletion, not a hidden write permission. No other
evaluator-only prohibition can produce a permission failure.

## Schedule

Forty slots, twenty adjacent A/B pairs, serial. For repetition `r=0..4`,
scenario order is rotated by `r`; for fixed scenario index `s`, A runs first
when `(s+r)` is even, otherwise B runs first. Both slots of a pair finish before
the next pair starts. Stamps are `cc-<ARM>-r<r>-<CASE>`; pairs are `P01`–`P20`.
The runner dry-runs every path and slot before the first launch.

## Measurement

One documentation contribution per trial, irrespective of file or tool-call
count. Frozen weights: useful create/update `+5`, unnecessary but correct
transient note `-1`, duplicate `-2`, misleading/unsupported `-5`, primary-task
failure `-5` separately.

Precedence for mixed output: misleading > duplicate > transient > useful >
none. Consultations, the actual recording route, gate eligibility and raw
no-write restraint are reported separately. A failed historical gate does not
establish false content.

Primary-task success is the harness's pristine check, never the judge's.

### R02 preservation

Every R02 judge call must return an evidence-backed `preservation` object:
`poolSize`, `acquireTimeout` and `startupMigrations` as
`retained|corrected|lost` with a decisive quote, and `obsoleteTlsClaim` as
`removed|retained` with a quote. A lost still-valid fact requires
`documentationOutcome: "misleading"` and is a non-compensable guardrail breach.
A faithful paraphrase, a `5000 milliseconds` equivalent or a supported removal
of the obsolete claim is not loss. The deterministic `preservationScreen` is a
cross-check only; it never decides the guardrail. The NOTE-02 helper is not used
as a general semantic judge. No documentation change leaves the seeded facts in
place and is assessed against those documents.

### Missing data

An unassessed trial contributes no score and is reported as an interval
(documentation `-5..+5`, primary `-5..0`); it is never imputed as zero.
Complete pairs are reported separately from unmatched observations.

## Judging

One blind structured AC judge call per assessable completed trial, at most 40,
with `opencode-go/glm-5.3-flash`. The packet carries the task, visible
permission file, scenario truth, before/after lake documents, changed paths, the
pristine primary result, verified docs operations and the final answer. It
carries no arm label, stamp, hypothesis, prior verdict or aggregate; the packet
builder refuses label leaks and the judge runs in a read-only container with an
empty work directory and deny-all permissions.

No model retry. Deterministic recovery may extract one unambiguous complete JSON
object from trailing prose, preserving the original output and judgement;
conflicting objects or missing evidence remain unknown.

## Readiness record

| Check                         | Result                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `npm test` at the base commit | 810/810 pass                                                                        |
| `npm run typecheck`           | pass                                                                                |
| `defined comply`              | `{"status":"compliant"}`                                                            |
| Replication fixture verifier  | 32/32 in both arms (seeded, intended, wrong-fix, permission, premise)               |
| R04 claimed lint command      | `npm run lint` exits 1 with `MIGRATION_ORDER 002_add_index.sql`; `npm test` exits 0 |
| Permission mapping            | every rule maps to a visible instruction; semantics inspected                       |
| Trial evidence guard          | reservation and immutable result directory; no automatic clearing                   |
| Judge claim                   | attempt directory claimed before launch; unrecorded trials refused                  |
| Interruption rehearsal        | started attempt preserved, blocked, never relaunched on resume                      |
| Competing-claim rehearsal     | one winner, one refusal, one launcher call                                          |
| Pre-model failure rehearsal   | recorded; resume needs an explicit second attempt                                   |
| Delivery probes (2)           | A 415/`c390…`, B 429/`09c9…`, combined 2073/2087 at the provider boundary           |
| Packet freeze                 | all evidence blocks present; zero label leaks                                       |

## Budget and stopping rules

Forty natural trial sessions and forty judge calls, plus the two delivery
probes already spent. No replacements, no second campaign. A pre-model launch
failure is preserved and pauses the run; a repair may resume only that slot
with a new launch record. A started attempt whose model call may have begun is
never rerun. A discovered fixture, isolation, delivery, reset or measurement
defect stops the campaign and the partial is reported. An ordinary task failure
or in-fixture policy breach is an outcome, not an infrastructure defect.

## Later-review criterion (frozen)

All forty trials and required assessments complete; B has no established
non-compensable breach (unauthorised mutation or destructive loss of valid
knowledge); B's default utility exceeds A by at least 5 across 20 trials per
arm. Passing permits a bounded recommendation, not adoption, production
adoption or a reliability claim. A partial is not evaluated as a completed
design.

Sensitivity: useful weight 3/5/8, transient penalty 0.5/1/2, other penalties
fixed. Do not reweight after results.

## Limits

- Provider delivery is proven for both descriptions at readiness; per-session
  delivery is recorded by plugin identity, not a per-request capture.
- Sessions with no `docs` call remain in the comparison; their delivery is
  inferred from registration and plugin identity, not observed use.
- Five repetitions per scenario estimate variance poorly; the corpus does not
  establish a production failure rate.
- Historical results remain separately labelled context and are not pooled.
