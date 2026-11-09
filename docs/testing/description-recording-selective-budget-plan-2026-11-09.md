---
Area: Testing
Keywords: automatic-notetaking, note-01, note-02, note-03, note-04, tool-description, native-docs, recording, restraint, deepseek, glm, paired-comparison, budget, 2250
Summary: Frozen plan for a fresh forty-trial comparison of the current native docs description against the exact 167-character selective-recording append, under a shared experimental description-plus-annotations ceiling of 2250. Includes the exact append, arm identities, budget-only diff, schedule, controls and stopping rules.
---

# Selective recording under a shared 2250 budget: frozen plan, 2026-11-09

Tracked copy of the evidence `RUN_PLAN.md`; the evidence copy remains
authoritative for the campaign. The plan was frozen before any control or
natural model session.

# Frozen selective-recording comparison under a shared 2250 budget

Frozen before any control or natural model session. This file is the evidence
copy; a tracked copy is written under `docs/testing/`.

## Question and hypothesis

Does appending the exact 166-character selective-recording paragraph to the
current native `docs` tool description improve useful automatic recording
relative to the current prose, while retaining appropriate restraint and
primary-task completion?

The hypothesis is that the selection wording raises useful completed
repository recording under the existing standing permission without increasing
unnecessary documentation mutations or reducing primary-task completion. This
is an assigned-configuration comparison: a correct loaded configuration is not
proof that every session read the paragraph.

## Arms and exact intervention

| Arm                       | Native description                     | Commit                                     | Tree                                       | Plugin hash                                                        |
| ------------------------- | -------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| Shared base (budget only) | Current description, unchanged         | `88b29239955b6671c5c5fdef62d648cd83168aa3` | `2a8e12273821a0a1c90e94d908e812fd8157d6c3` | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` |
| A (control)               | Current description, unchanged         | `88b29239955b6671c5c5fdef62d648cd83168aa3` | `2a8e12273821a0a1c90e94d908e812fd8157d6c3` | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` |
| B (intervention)          | Arm A plus one space and the paragraph | `313789fd6cd3601120e72dad4d1ca24ee2da4f3f` | `f06a992d17d5f32564c2ece3a4befc9af0bd803e` | `553d9e64d4321c3586fc577fffd44aa20ac32f75abac0eceaf79ea327177c535` |

Starting HEAD for the run: `e9731cd15a5c5b24fae813c5acd3fd333f62d01b`,
tree `fb0216e34ecfb874b36aeae26e90c700a6a0f676`, clean, branch
`experiment/recording-closing-variant`. The arm branches were cut from that
commit; the active branch itself was not modified by either arm.

Arm A native description (415 characters, SHA-256
`c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c`):

> Search the configured knowledge lakes and nested project `README.md` files
> before a broad grep for how-to knowledge. A blank search lists recent docs;
> `help` shows the lakes and ranking. `read` returns a lake doc verbatim plus
> its revision token; `instructions:` results open with the built-in read tool.
> `add` creates or replaces a knowledge doc (replace needs that revision);
> `check` audits convention compliance.

Exact append: one ASCII space followed by 166 ASCII characters (167 added):

> When authorised, record verified repo-specific facts that add to or correct
> existing knowledge. Skip transient state and generic advice; update rather
> than duplicate.

Arm B native description: 582 characters, SHA-256
`678757412bec0f8e4b54297111e1262e5107db0bc38b76dcb2fa9407caa07cad`.
`B.native === A.native + " " + paragraph` was checked. The twin description
(325 characters, SHA-256
`a100567bf13fc47e9a140ee1213c9ec5fb11671b01e72677b4735a165c51efa0`),
`src/SKILL.md`, `CONVENTION.md`, `package.json` and `package-lock.json` are
byte-identical across arms.

### Complete one-surface diff between the arms

```diff
diff --git a/src/index.ts b/src/index.ts
index 7fa9462..bfac99c 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -4906,7 +4906,10 @@ export function createDocsTool(
         "revision token; `instructions:` results open with the " +
         "built-in read tool. `add` creates or replaces a knowledge " +
         "doc (replace needs that revision); `check` audits " +
-        "convention compliance.",
+        "convention compliance. When authorised, record verified " +
+        "repo-specific facts that add to or correct existing " +
+        "knowledge. Skip transient state and generic advice; update " +
+        "rather than duplicate.",
     input: DOCS_INPUT,
     options: codemode
         ? { namespace: "docs", codemode: true }
```

`git diff 88b2923 313789f` changes only `src/index.ts`.

## Authorised experimental budget change

The sole change in the shared base commit `88b2923` is one line in
`tests/budget.test.ts`:

```diff
-    descriptionPlusAnnotations: 2100,
+    descriptionPlusAnnotations: 2250,
```

| Measure                                   | Arm A | Arm B                           |
| ----------------------------------------- | ----- | ------------------------------- |
| Native description                        | 415   | 582 (native ceiling 600 passes) |
| Description annotations from `DOCS_INPUT` | 1668  | 1668                            |
| Description plus annotations              | 2083  | 2250                            |
| Combined ceiling before this run          | 2100  | 2100                            |
| Combined ceiling for these arms           | 2250  | 2250                            |

The combined measure is the budget test's own: registered native description
length plus every `description` annotation in the converted `DOCS_INPUT` JSON
Schema, joined by one space. The native 600, twin 500, skill discovery 420 and
skill body 4600 ceilings are unchanged. `BUDGETS` is a test-only constant read
by `tests/budget.test.ts` assertions; it is not read by `src/index.ts`, not
shipped to a model, and not used to truncate, select or alter delivered
content. The budget change is identical in both arms, so it cannot explain an
arm difference. It still leaves the candidate over the production 2100 ceiling:
production adoption would require its own editorial decision.

## Generation and identity note

The harness generation inputs hash covers the case definition, model, plugin
content hash, lockfile hash, discovery and recording-closing flags and sandbox
permissions. The plugin content hash covers `package.json`, `src/index.ts`,
`src/SKILL.md` and `CONVENTION.md`. Therefore:

- A and B generation fingerprints differ only because B's `src/index.ts`
  differs; the budget change is not in the plugin identity and does not appear
  in generation identity.
- Prompt, rubric, config, fixture-tree and standing-permission bytes are
  identical across arms; `generation.json` differs because it records the arm
  plugin hash and inputs hash.
- `recordingClosing` is `original` in both arms; `--recording-closing direct`
  is not used.

## Execution identities

| Identity              | Value                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Repository / checkout | `git@github.com:markstanden/opencode-docs-plugin.git` at `/home/mark/repos/opencode-docs-plugin` |
| Branch                | `experiment/recording-closing-variant`                                                           |
| Trial image           | `localhost/opencode-placement-trials`                                                            |
| Image id              | `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`                               |
| OpenCode CLI          | `opencode v2.2.6`                                                                                |
| Node                  | `v26.13.0`                                                                                       |
| Workhorse             | `opencode-go/deepseek-v4.1-flash` (resolved active)                                              |
| Independent judge     | `opencode-go/glm-5.3-flash` (resolved active)                                                    |
| Harness version       | 6                                                                                                |
| Generation version    | 4                                                                                                |
| Naming map            | version 2                                                                                        |

## Frozen inputs

| Corpus / input                           | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `tests/fixtures/trial-cases.json`        | `f975698048c61af6a8a0d03008fdf175a75e15435eb6d356c40ef5ad11e00130` |
| `tests/fixtures/diagnostic-cases.json`   | `ac956a2d1975a6d3429b293b93d26480c216eee4a25bef4d6bfe4210277a2377` |
| `tests/fixtures/read-control-cases.json` | `83314737928f3083fadac66ef58fcd1a715de0be86b02cc72c179813dac6a163` |
| Standing permission (`work/AGENTS.md`)   | `57d0a68aaeb5afd7031870f5ed3c1a396a0c2404e7b072d64069b253d5a61a5e` |
| NOTE-01 primary check                    | `9aade3113e7be05596882dab1b3cb0c6a55195ec373dabee561f62950117ab47` |
| NOTE-02 primary check                    | `55d708a0defabc5c5487591c70f208135e40a133acb8e4997930f3499f276f7f` |
| NOTE-03 primary check                    | `6a037bed1605a73a79ea0fa3321a03a104c7c1456593e1ceeb3b1c2fe8e7d715` |
| NOTE-04 primary check                    | `6a093090abba25cd25f72eb69f56fd15edb683900c9b3520ac51f1473e3fa445` |

Policies and expected document outcomes are the frozen corpus entries:
NOTE-01 create (retain `retry`/`duplicate`, preserve `ops/on-call.md`);
NOTE-02 replace `setup/node-version.md` (retain `nvm`/`CI`, omit `Node 22`,
preserve `ops/release.md`); NOTE-03 no documentation mutation (preserve
`ops/on-call.md`); NOTE-04 no documentation mutation plus a verified read of
`ops/webhook-debugging.md` (preserve both seeded notes).

## Four first-attempt, unjudged controls

| Control           | Stamp             | Arm | Corpus / case                   | Criterion                                                                                                                               |
| ----------------- | ----------------- | --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Help/inventory    | `selb-ctl-a01-a`  | A   | `diagnostic-cases.json` / A01   | matching cwd/PWD/host cwd, observed intended plugin load, native `docs` help inventory and Code Mode twin help completed                |
| Exact seeded read | `selb-ctl-read-a` | A   | `read-control-cases.json` / R01 | matching cwd/PWD/host cwd, observed intended plugin load, native/twin `docs` read returns the seed with revision equal to the seed hash |
| Help/inventory    | `selb-ctl-a01-b`  | B   | `diagnostic-cases.json` / A01   | same as A                                                                                                                               |
| Exact seeded read | `selb-ctl-read-b` | B   | `read-control-cases.json` / R01 | same as A                                                                                                                               |

Controls are separate, unjudged and excluded from every natural denominator.
A blank search is not inventory help. If any control fails its criterion, the
campaign stops before natural trials; there is no favourable retry and no
single-arm fallback.

## Forty-trial schedule (expanded and frozen)

Five repetition blocks; within each scenario the two arms run consecutively.
A then B when block + position is even, otherwise B then A. All stamps are
exact and unique.

| Block | Position | Scenario | Order    | Stamps                                    |
| ----- | -------- | -------- | -------- | ----------------------------------------- |
| 1     | 1        | NOTE-01  | A then B | `selb-A-b1-NOTE-01` / `selb-B-b1-NOTE-01` |
| 1     | 2        | NOTE-02  | B then A | `selb-B-b1-NOTE-02` / `selb-A-b1-NOTE-02` |
| 1     | 3        | NOTE-03  | A then B | `selb-A-b1-NOTE-03` / `selb-B-b1-NOTE-03` |
| 1     | 4        | NOTE-04  | B then A | `selb-B-b1-NOTE-04` / `selb-A-b1-NOTE-04` |
| 2     | 1        | NOTE-02  | B then A | `selb-B-b2-NOTE-02` / `selb-A-b2-NOTE-02` |
| 2     | 2        | NOTE-03  | A then B | `selb-A-b2-NOTE-03` / `selb-B-b2-NOTE-03` |
| 2     | 3        | NOTE-04  | B then A | `selb-B-b2-NOTE-04` / `selb-A-b2-NOTE-04` |
| 2     | 4        | NOTE-01  | A then B | `selb-A-b2-NOTE-01` / `selb-B-b2-NOTE-01` |
| 3     | 1        | NOTE-03  | A then B | `selb-A-b3-NOTE-03` / `selb-B-b3-NOTE-03` |
| 3     | 2        | NOTE-04  | B then A | `selb-B-b3-NOTE-04` / `selb-A-b3-NOTE-04` |
| 3     | 3        | NOTE-01  | A then B | `selb-A-b3-NOTE-01` / `selb-B-b3-NOTE-01` |
| 3     | 4        | NOTE-02  | B then A | `selb-B-b3-NOTE-02` / `selb-A-b3-NOTE-02` |
| 4     | 1        | NOTE-04  | B then A | `selb-B-b4-NOTE-04` / `selb-A-b4-NOTE-04` |
| 4     | 2        | NOTE-01  | A then B | `selb-A-b4-NOTE-01` / `selb-B-b4-NOTE-01` |
| 4     | 3        | NOTE-02  | B then A | `selb-B-b4-NOTE-02` / `selb-A-b4-NOTE-02` |
| 4     | 4        | NOTE-03  | A then B | `selb-A-b4-NOTE-03` / `selb-B-b4-NOTE-03` |
| 5     | 1        | NOTE-01  | A then B | `selb-A-b5-NOTE-01` / `selb-B-b5-NOTE-01` |
| 5     | 2        | NOTE-02  | B then A | `selb-B-b5-NOTE-02` / `selb-A-b5-NOTE-02` |
| 5     | 3        | NOTE-03  | A then B | `selb-A-b5-NOTE-03` / `selb-B-b5-NOTE-03` |
| 5     | 4        | NOTE-04  | B then A | `selb-B-b5-NOTE-04` / `selb-A-b5-NOTE-04` |

## Judging rules

Exactly one independent judge attempt (`attempt-001`) per gate-eligible trial,
using the unchanged rubric and existing actual-document/primary-check evidence.
Judge model `opencode-go/glm-5.3-flash`; no substitution, no re-judging for
consistency and no manual upgrades. Gate-blocked semantic acceptance is
`unknown`, not failed. Judge process failure is recorded as `judge-error`, never
a pass. Preserve every attempt directory and input.

## Denominators, outcomes and stopping rules

- Planned: 5 per scenario per arm; 10 per scenario; 20 per arm; 40 total.
- Attempted: every planned stamp whose session started.
- Completed: exit 0, no timeout/signal/overflow, valid final answer.
- Usable: completed with readable answer and no capture failure; included in
  the main analysis even when no docs call was made.
- Primary task: independent pristine check `pass`.
- Positive combined (NOTE-01/02): primary pass + usable + documentation gate
  pass + semantic pass + no policy violation.
- Restraint combined (NOTE-03/04): primary pass + no documentation mutation +
  usable + semantic pass + no policy violation.
- Semantic P/F/JE/NJ: pass, fail, judge error, not judged (gate-blocked).
- Report positive, restraint and primary-task measures separately. Report
  paired both-pass / both-fail / A-only / B-only counts per scenario.
- Preserve first attempts, including failures and unusable attempted sessions;
  resume only genuinely unstarted slots. A nonzero gate result does not abort
  later planned work. No mid-campaign edits to fixed inputs, code or checks.
- A concrete blocking measurement defect ends the campaign; no repair-and-pool.
- Do not pool historical campaigns into this comparison.

## Deadline

Two hours from the recorded start `2026-11-09T16:02:08Z`: deadline
`2026-11-09T18:02:08Z`. Unstarted trials remain unrun rather than bypassing
integrity. Time is reserved for judging, analysis and restoration.
