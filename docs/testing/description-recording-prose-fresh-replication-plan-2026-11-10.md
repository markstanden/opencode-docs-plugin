---
Area: Testing
Keywords: description-prose, replication, r01, r02, r03, r04, preservation, paired-schedule, deepseek, glm
Summary: Frozen 40-session paired replication of the exact historical A and B native `docs` descriptions on four newly authored scenarios, after a derived audit corrected the H02 preservation premise and the NOTE-02 partial-fix classification.
---

# Native-description A/B replication: frozen plan, 2026-11-10

Frozen before the first scored replication session. This is **not** a repair of
the historical campaign and does not re-run it. The historical 88 trials remain
as recorded; the derived audit is a separate layer.

## Question

Does exact B improve weighted useful documentation relative to A on newly
authored tasks, with reliable preservation measurement and correctly
interleaved execution?

## Exact assets

| Arm | Native chars | SHA-256                                                            |
| --- | ------------ | ------------------------------------------------------------------ |
| A   | 415          | `c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c` |
| B   | 429          | `09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e` |

The strings were extracted from the arm plugins' registered `docs`
description, not reconstructed from a report. The provider-boundary probes
captured both byte-exactly (415/429, same hashes) in a real request body.

| Identity | Value |
| --- | --- |
| Control plugin content hash | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` |
| Finalist plugin content hash | `04535cf3b9efece2edb9cc72e1dbbe57fa36e269688623c9d6eac61ee30bbd88` |
| Arm A commit / tree | `624f8c48a7c41874ca60158963d80b23feda7d3b` / `abaf7d757540b2668e25dfdd1d377b78e0ac0ec0` |
| Arm B commit / tree | `796dc59f15e6e0b50e8b4680bc2a46ba761f2d3b` / `5571aa66657e185bd2b3100a05f317fc30005399` |
| Base for both arms | `bf767ea` plus the audited gate repairs; `src/` identical to `902a6fe` |
| Corpus | `934f5e683113c10d94a4722ddac584b4e267e3b11bc45590fc26419871e2de0b` |
| Truth | `066615127cbb629ff160f2cf9e1f251bde6f1f3cbfd1b055ec6b9495aefed3d5` |
| Schedule hash | `8aa0053c7a27265e7772db7f476eca22683fdc26681c16f4218daea752bbe2b4` |
| Workhorse / judge | `opencode-go/deepseek-v4.1-flash` / `opencode-go/glm-5.3-flash` |
| Runtime | OpenCode `v2.2.6`; Node `v26.13.0`; image `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb` |
| Evidence root | `/home/mark/tmp/docs-desc-fresh-20261110/r2/` (dev-box only) |

## Scenarios (newly authored holdouts)

| Case | Opportunity | Task |
| --- | --- | --- |
| R01 | useful create | vendor CSV carries a UTF-8 BOM; strip only the leading BOM |
| R02 | useful correction | TLS must be required; preserve pool 10, 5-second acquire timeout and startup migrations |
| R03 | transient only | stale machine-local `.tmp/dev.sock` after a killed dev server |
| R04 | already covered | lexical migration-lint `MIGRATION_ORDER` is deliberate; `npm test` is the gate |

R01–R04 were authored by this agent after reading the prior findings; they are
newly authored holdouts, not independent validation. Five repetitions of one
scenario are not five scenario types.

The deterministic readiness suite proves, for every R case, seeded failure (or
the R04 pass), intended-fix pass and a plausible wrong fix failing. R02's
preservation checker additionally proves: a valid paraphrase is accepted, a
supported obsolete-fact removal is accepted, and valid-fact loss is rejected.

## Schedule

Forty slots, twenty adjacent pairs. Scenario order rotates by repetition; for
scenario index `s` and repetition `r`, A runs first when `(s + r)` is even.
Both slots of a pair complete before the next pair. The schedule hash above is
the frozen identity; `run.mjs --dry-run` verifies every path and all pair
invariants before any model session.

## Measurement

One documentation outcome per trial, freeze weights: useful create/update +5,
transient -1, duplicate -2, misleading -5, primary failure -5. Precedence
misleading > duplicate > transient > useful > none. For R02 the deterministic
preservation checker is authoritative for still-valid facts and the obsolete
claim; a failed check is a non-compensable preservation incident and is also
scored misleading.

Sensitivity: useful 3/5/8 × transient 0.5/1/2, other weights fixed.

Later-review criterion (frozen): complete assessments; B has no unauthorised-
mutation or destructive-preservation breach; B's total utility exceeds A by at
least 5 across 20 trials per arm. A breach does not erase the numerical result;
it prevents the recommendation. Passing does not authorise adoption.

## Limits

- Provider delivery is proven for both descriptions at readiness; per-session
  delivery is recorded by the harness's plugin identity and telemetry.
- The judge is blind and isolated; deterministic re-parse is allowed only for
  unambiguous JSON, never a model retry.
- No push, PR, merge or production change follows.
