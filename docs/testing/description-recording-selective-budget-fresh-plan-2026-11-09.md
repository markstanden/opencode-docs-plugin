---
Area: Testing
Keywords: automatic-notetaking, selective-recording, fresh-campaign, note-01, note-02, note-03, note-04, 2250, deepseek, glm
Summary: Frozen fresh forty-trial replication of the selective-recording comparison under the repaired NOTE-02 replace gate, with four controls and the unchanged A/B wording.
---

# Frozen fresh selective-recording comparison under the repaired 2250 measurement

Recorded start `2026-11-09T17:08:20Z` (UTC). Frozen before any control or
natural model session. This is a distinct fresh campaign; it does not pool the
original forty trials or the derived reanalysis.

## Question and hypothesis

Does appending the exact 166-character selective-recording paragraph to the
current native `docs` tool description improve useful automatic recording
relative to the current prose, while retaining appropriate restraint and
primary-task completion? The hypothesis is unchanged. This is an assigned-
configuration comparison: a correct loaded configuration is not proof that
every session read the paragraph.

## Arms and exact intervention

| Arm                         | Native description                    | Commit                                     | Plugin hash                                                                     |
| --------------------------- | ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Shared repaired measurement | A/B plugin plus repaired replace gate | `9744c8bde192508b250858ce6a4ff1bed6bedb4a` | harness file `eea1b23267526bd69f2a511a92eebf37fa55864fd684d962cf6bf68367ca6005` |
| A (control)                 | current description, unchanged        | `bc422184ab140be701be032418f991420917e8be` | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8`              |
| B (intervention)            | A plus one space and the paragraph    | `2fd0935f816816eba9870f73ccc1e50bc0511b15` | `553d9e64d4321c3586fc577fffd44aa20ac32f75abac0eceaf79ea327177c535`              |

`harnessVersion` remains 6 for schema compatibility; the repaired measurement
is identified by the shared-base commit and the harness file SHA above, and
each run's `pluginCommit` names the arm commit that contains it.

Arm A native description: 415 characters, SHA-256
`c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c`,
byte-identical to the historical A description.

Exact append: one ASCII space plus 166 characters (167 added). Arm B native
description: 582 characters, SHA-256
`678757412bec0f8e4b54297111e1262e5107db0bc38b76dcb2fa9407caa07cad`.
`B.native === A.native + " " + paragraph` holds. The twin description, skill,
convention, package and lockfile are byte-identical across arms.

### One-surface diff between the arms

```diff
-              "convention compliance.",
+              "convention compliance. When authorised, record verified " +
+              "repo-specific facts that add to or correct existing " +
+              "knowledge. Skip transient state and generic advice; update " +
+              "rather than duplicate.",
```

## Shared experimental budget

Both arms change only `tests/budget.test.ts`:
`descriptionPlusAnnotations: 2100` becomes `2250`. The production ceiling is
unchanged at 2100 and the native ceiling remains 600. The combined measure is
the budget test's own: native description plus every `description` annotation
in `DOCS_INPUT`, joined by one space.

| Measure                 | Arm A       | Arm B                   |
| ----------------------- | ----------- | ----------------------- |
| Native description      | 415         | 582                     |
| Native ceiling          | 600 (pass)  | 600 (pass)              |
| Description annotations | 1668        | 1668                    |
| Combined                | 2083        | 2250                    |
| Experimental ceiling    | 2250 (pass) | 2250 (pass)             |
| Production ceiling      | 2100        | 2100 (B exceeds by 150) |

`BUDGETS` is test-only; the plugin does not read it and does not truncate,
select or alter content with it. The same cap is present in both arms, so it
cannot explain an arm difference.

## Fixed inputs and execution identities

| Identity              | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Repository            | `/home/mark/repos/opencode-docs-plugin`                            |
| Branch                | `experiment/recording-closing-variant`                             |
| Trial corpus          | `f975698048c61af6a8a0d03008fdf175a75e15435eb6d356c40ef5ad11e00130` |
| Diagnostic corpus     | `ac956a2d1975a6d3429b293b93d26480c216eee4a25bef4d6bfe4210277a2377` |
| Read-control corpus   | `83314737928f3083fadac66ef58fcd1a715de0be86b02cc72c179813dac6a163` |
| Standing permission   | `57d0a68aaeb5afd7031870f5ed3c1a396a0c2404e7b072d64069b253d5a61a5e` |
| NOTE-01 primary check | `9aade3113e7be05596882dab1b3cb0c6a55195ec373dabee561f62950117ab47` |
| NOTE-02 primary check | `55d708a0defabc5c5487591c70f208135e40a133acb8e4997930f3499f276f7f` |
| NOTE-03 primary check | `6a037bed1605a73a79ea0fa3321a03a104c7c1456593e1ceeb3b1c2fe8e7d715` |
| NOTE-04 primary check | `6a093090abba25cd25f72eb69f56fd15edb683900c9b3520ac51f1473e3fa445` |
| Trial image           | `localhost/opencode-placement-trials`                              |
| Workhorse             | `opencode-go/deepseek-v4.1-flash`                                  |
| Independent judge     | `opencode-go/glm-5.3-flash`                                        |
| Recording closing     | `original`                                                         |
| Variant               | `destinations`                                                     |

## Four first-attempt, unjudged controls

| Control           | Stamp             | Arm | Corpus / case                   |
| ----------------- | ----------------- | --- | ------------------------------- |
| Help/inventory    | `self-ctl-a01-a`  | A   | `diagnostic-cases.json` / A01   |
| Exact seeded read | `self-ctl-read-a` | A   | `read-control-cases.json` / R01 |
| Help/inventory    | `self-ctl-a01-b`  | B   | `diagnostic-cases.json` / A01   |
| Exact seeded read | `self-ctl-read-b` | B   | `read-control-cases.json` / R01 |

A blank search is not inventory help. Any failed control stops the fresh
campaign before natural trials; no retry and no single-arm fallback.

## Forty-trial schedule (frozen)

A then B when block + position is even; otherwise B then A.

| Block | Position | Scenario | Order    | Stamps                                    |
| ----- | -------- | -------- | -------- | ----------------------------------------- |
| 1     | 1        | NOTE-01  | A then B | `self-A-b1-NOTE-01` / `self-B-b1-NOTE-01` |
| 1     | 2        | NOTE-02  | B then A | `self-B-b1-NOTE-02` / `self-A-b1-NOTE-02` |
| 1     | 3        | NOTE-03  | A then B | `self-A-b1-NOTE-03` / `self-B-b1-NOTE-03` |
| 1     | 4        | NOTE-04  | B then A | `self-B-b1-NOTE-04` / `self-A-b1-NOTE-04` |
| 2     | 1        | NOTE-02  | B then A | `self-B-b2-NOTE-02` / `self-A-b2-NOTE-02` |
| 2     | 2        | NOTE-03  | A then B | `self-A-b2-NOTE-03` / `self-B-b2-NOTE-03` |
| 2     | 3        | NOTE-04  | B then A | `self-B-b2-NOTE-04` / `self-A-b2-NOTE-04` |
| 2     | 4        | NOTE-01  | A then B | `self-A-b2-NOTE-01` / `self-B-b2-NOTE-01` |
| 3     | 1        | NOTE-03  | A then B | `self-A-b3-NOTE-03` / `self-B-b3-NOTE-03` |
| 3     | 2        | NOTE-04  | B then A | `self-B-b3-NOTE-04` / `self-A-b3-NOTE-04` |
| 3     | 3        | NOTE-01  | A then B | `self-A-b3-NOTE-01` / `self-B-b3-NOTE-01` |
| 3     | 4        | NOTE-02  | B then A | `self-B-b3-NOTE-02` / `self-A-b3-NOTE-02` |
| 4     | 1        | NOTE-04  | B then A | `self-B-b4-NOTE-04` / `self-A-b4-NOTE-04` |
| 4     | 2        | NOTE-01  | A then B | `self-A-b4-NOTE-01` / `self-B-b4-NOTE-01` |
| 4     | 3        | NOTE-02  | B then A | `self-B-b4-NOTE-02` / `self-A-b4-NOTE-02` |
| 4     | 4        | NOTE-03  | A then B | `self-A-b4-NOTE-03` / `self-B-b4-NOTE-03` |
| 5     | 1        | NOTE-01  | A then B | `self-A-b5-NOTE-01` / `self-B-b5-NOTE-01` |
| 5     | 2        | NOTE-02  | B then A | `self-B-b5-NOTE-02` / `self-A-b5-NOTE-02` |
| 5     | 3        | NOTE-03  | A then B | `self-A-b5-NOTE-03` / `self-B-b5-NOTE-03` |
| 5     | 4        | NOTE-04  | B then A | `self-B-b5-NOTE-04` / `self-A-b5-NOTE-04` |

## Judging rules

Exactly one independent judge attempt (`attempt-001`) per gate-eligible trial,
using the frozen rubric and actual document/primary-check evidence. Judge
`opencode-go/glm-5.3-flash`; no substitution, retry or manual upgrade.
Gate-blocked semantic acceptance stays unknown, not failed. Judge process
failure is `judge-error`, never a pass.

## Denominators and stopping rules

- Planned: 5 per scenario per arm; 10 per scenario; 20 per arm; 40 total.
- Attempted: a planned stamp whose session started.
- Completed: exit 0, no timeout/signal/overflow, valid final answer.
- Usable: completed with readable answer and no capture failure.
- Positive combined: primary pass + usable + docs gate pass + semantic pass +
  no policy violation.
- Restraint combined: primary pass + no documentation mutation + usable +
  semantic pass + no policy violation.
- Semantic P/F/JE/NJ: pass, fail, judge error, not judged (gate-blocked).
- Preserve first attempts; resume only genuinely unstarted slots. A nonzero
  gate result does not abort later work. No mid-campaign edits.
- A concrete blocking measurement defect ends the campaign; no repair-and-pool.
- Do not pool the original or derived populations into this comparison.

## Window and deadline

Fresh campaign start `2026-11-09T17:08Z`; overall task deadline
`2026-11-09T19:56Z`. The fresh campaign target is to finish by 19:30Z, leaving
time for integrity verification, restoration and the handback. At least sixty
minutes remain at launch.
