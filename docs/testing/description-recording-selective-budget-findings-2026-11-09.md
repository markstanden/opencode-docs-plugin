---
Area: Testing
Keywords: automatic-notetaking, note-01, note-02, note-03, note-04, tool-description, native-docs, recording, restraint, deepseek, glm, paired-comparison, budget, 2250
Summary: Fresh forty-trial comparison of the current native docs description against the exact 167-character selective-recording append, both under a shared experimental 2250 description-plus-annotations ceiling. Positive recording was 3/10 for A and 2/10 for B; combined restraint 7/10 and 8/10; primary-task completion 20/20 and 19/20. The candidate did not improve useful recording and is not recommended for production.
---

# Selective recording under a shared 2250 budget: forty paired DeepSeek trials, 2026-11-09

## Outcome and scope

**Completed.** Forty fresh natural trials (twenty per arm) and four
first-attempt controls ran under a shared experimental
description-plus-annotations ceiling of 2250. The selective append did **not**
improve useful positive recording: Arm A completed 3/10 positive trials and
Arm B 2/10. Combined restraint was 7/10 for A and 8/10 for B; primary-task
completion was 20/20 for A and 19/20 for B. Both arms wrote unnecessary transient-lock
notes in NOTE-03, so the selective wording did not remove that failure mode.
There were no semantic failures among the twenty judged trials; twenty trials
were gate-blocked and their semantic acceptance remains unknown.

This is a separate run from the earlier long-paragraph comparison and from
the blocked preparation attempt. It does not pool either record, and it does
not change their verdicts. The candidate was evaluated under the authorised
2250 experimental cap; it still exceeds the production 2100 combined ceiling,
so this run is not evidence for production adoption.

## Identity and working state

| Item                             | Actual value                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository / checkout            | `git@github.com:markstanden/opencode-docs-plugin.git` at `/home/mark/repos/opencode-docs-plugin`                                                                                |
| Branch                           | `experiment/recording-closing-variant`                                                                                                                                          |
| Starting HEAD / tree             | `e9731cd15a5c5b24fae813c5acd3fd333f62d01b` / `fb0216e34ecfb874b36aeae26e90c700a6a0f676`                                                                                         |
| Shared base commit (budget only) | `88b29239955b6671c5c5fdef62d648cd83168aa3`, tree `2a8e12273821a0a1c90e94d908e812fd8157d6c3`                                                                                     |
| Arm A execution                  | `88b29239955b6671c5c5fdef62d648cd83168aa3`, tree `2a8e12273821a0a1c90e94d908e812fd8157d6c3`, plugin hash `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8`     |
| Arm B execution                  | `313789fd6cd3601120e72dad4d1ca24ee2da4f3f`, tree `f06a992d17d5f32564c2ece3a4befc9af0bd803e`, plugin hash `553d9e64d4321c3586fc577fffd44aa20ac32f75abac0eceaf79ea327177c535`     |
| Preparation plan commit          | `1a62a2c6ec320e2e77b9038576463cd413ea7cc4`                                                                                                                                      |
| Findings commit                  | Reported in the handback; this document is committed after the evidence                                                                                                         |
| Restoration commit               | Not applicable: the active branch's `src/index.ts` and `tests/budget.test.ts` never carried the candidate or the experimental cap and were verified byte-identical to the start |
| Active HEAD after plan commit    | `1a62a2c6ec320e2e77b9038576463cd413ea7cc4`, tree `6fcf0ab4f4a306d8d1c8a7323f4d677bed56face`                                                                                     |
| Working tree                     | Clean before the findings commit                                                                                                                                                |
| Remote state                     | Local only; no push, PR, merge, release or external comment                                                                                                                     |

Both arm worktrees are clean. Arm A is on branch
`experiment/recording-selective-budget2250`; Arm B is on
`experiment/recording-selective-budget2250-b`, one commit ahead of the shared
base.

## Exact intervention and budget-only change

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
`B.native === A.native + " " + paragraph` was verified. The twin description
(325 characters, SHA-256
`a100567bf13fc47e9a140ee1213c9ec5fb11671b01e72677b4735a165c51efa0`),
`src/SKILL.md`, `CONVENTION.md`, `package.json` and `package-lock.json` are
byte-identical across arms. `git diff 88b2923 313789f` changes only
`src/index.ts`.

### Complete arm-to-arm diff

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

### The one-line experimental budget change

The shared base commit `88b2923` changes only `tests/budget.test.ts`:

```diff
-    descriptionPlusAnnotations: 2100,
+    descriptionPlusAnnotations: 2250,
```

| Measure                                      | Arm A                   | Arm B       |
| -------------------------------------------- | ----------------------- | ----------- |
| Native description                           | 415                     | 582         |
| Native ceiling                               | 600 (pass)              | 600 (pass)  |
| Description annotations from `DOCS_INPUT`    | 1668                    | 1668        |
| Description plus annotations                 | 2083                    | 2250        |
| Production combined ceiling                  | 2100 (B exceeds by 150) | 2100        |
| Experimental combined ceiling for these arms | 2250 (pass)             | 2250 (pass) |

The combined measure is the budget test's own: registered native description
length plus every `description` annotation in the converted `DOCS_INPUT` JSON
Schema, joined by one space. `BUDGETS` is a local constant in
`tests/budget.test.ts`; `src/index.ts` contains no reference to 2100 or 2250,
the plugin does not read the test file, and the value is not used to truncate,
select or alter delivered content. The same adjustment is present in both
arms, so it cannot explain an arm difference. It remains a separate
experimental test-policy change, not part of the candidate and not authorised
for production.

### Generation identity

The harness generation inputs hash covers the case definition, model, plugin
content hash, lockfile hash, discovery and recording-closing flags, and sandbox
permissions. It does not cover `tests/budget.test.ts`, so the budget change is
absent from generation identity. A and B generation fingerprints differ only
because B's `src/index.ts` changes the plugin content hash. Prompt, rubric,
config, fixture-tree, standing-permission and primary-check bytes are identical
across arms; `generation.json` differs because it records the arm plugin hash
and inputs hash. `recordingClosing` is `original` and the variant is
`destinations` in all forty run descriptions.

## Validation

Checks run now:

| Check                               | Scope                                                | Result                                                                                    | Evidence                                       |
| ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `npm test`                          | Arm A `88b2923`                                      | pass, 705/705                                                                             | `validation-a-test.log`, exit 0                |
| `npm run typecheck`                 | Arm A `88b2923`                                      | pass                                                                                      | `validation-a-typecheck.log`, exit 0           |
| `npm test`                          | Arm B `313789f`                                      | pass, 705/705                                                                             | `validation-b-test.log`, exit 0                |
| `npm run typecheck`                 | Arm B `313789f`                                      | pass                                                                                      | `validation-b-typecheck.log`, exit 0           |
| `defined comply --full`             | Main checkout at starting source                     | compliant                                                                                 | `validation-main-baseline-defined.log`, exit 0 |
| `defined comply --full`             | Main checkout with Arm A's two-line budget change    | compliant                                                                                 | `validation-main-A-defined.log`, exit 0        |
| `defined comply --full`             | Main checkout with Arm B's budget change plus append | compliant                                                                                 | `validation-main-B-defined.log`, exit 0        |
| Deterministic length and hash check | Both arms                                            | A 2083, B 2250; B = A + space + paragraph                                                 | `IDENTITY.json`                                |
| `defined comply --full`             | Arm worktrees                                        | blocked: gate container cannot resolve the worktree mount (`crun ... /repo/node_modules`) | `validation-a-defined.log`, exit 127           |
| CI observed at a pinned SHA         | N/A                                                  | Not run                                                                                   | N/A                                            |

Inspection of automatic repairs: the three arm-validation gate runs (starting
source, Arm A files, Arm B files) made no repairs beyond the deliberately
applied arm files, which were restored with `git checkout`. The later
documentation gate run reformatted Markdown tables in the plan and in this
findings document (alignment only); that repair is committed as `f052c20`,
separately from the findings. No source, budget, fixture, rubric or
model-visible content was changed by any repair. The worktree `defined comply`
failure is an infrastructure limitation, not a code result; the main checkout
carried each arm's exact files. No later check has been reused as if it were
fresh.

## Window, models and fixed inputs

| Item                            | Actual value                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recorded start / deadline       | `2026-11-09T16:02:08Z` / `2026-11-09T18:02:08Z` (UTC)                                                                                                  |
| Preparation and generation      | `2026-11-09T16:02:08Z`–`2026-11-09T16:11:45Z`                                                                                                          |
| Controls                        | `2026-11-09T16:12:28Z`–`2026-11-09T16:13:19Z`                                                                                                          |
| Natural trials                  | `2026-11-09T16:13:49Z`–`2026-11-09T16:34:24Z`                                                                                                          |
| Judging                         | `2026-11-09T16:34:50Z`–`2026-11-09T16:37:52Z`                                                                                                          |
| Deadline reached                | No                                                                                                                                                     |
| Workhorse                       | `opencode-go/deepseek-v4.1-flash` (resolved active)                                                                                                    |
| Independent judge               | `opencode-go/glm-5.3-flash` (resolved active)                                                                                                          |
| Runtime / image                 | OpenCode `v2.2.6`; Node `v26.13.0`; image `localhost/opencode-placement-trials`, id `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb` |
| Harness / generation / naming   | version 6 / version 4 / version 2                                                                                                                      |
| Trial corpus                    | `f975698048c61af6a8a0d03008fdf175a75e15435eb6d356c40ef5ad11e00130`                                                                                     |
| Diagnostic corpus               | `ac956a2d1975a6d3429b293b93d26480c216eee4a25bef4d6bfe4210277a2377`                                                                                     |
| Read-control corpus             | `83314737928f3083fadac66ef58fcd1a715de0be86b02cc72c179813dac6a163`                                                                                     |
| Standing permission             | SHA-256 `57d0a68aaeb5afd7031870f5ed3c1a396a0c2404e7b072d64069b253d5a61a5e`, byte-identical across arms                                                 |
| NOTE-01/02/03/04 primary checks | `9aade311…`, `55d708a0…`, `6a037bed…`, `6a093090…` (full hashes in `IDENTITY.json`)                                                                    |
| Schedule                        | Frozen in the plan; all forty slots started in the exact block order and no deviation                                                                  |

No model substitution, no extra repetition, no unstarted slot, and no
mid-campaign edit to prompts, fixtures, code, checks or policies.

## Controls (unjudged, before natural trials)

| Control               | Stamp             | Arm | Attempts | Criterion evidence                                                                                                                           | Outcome |
| --------------------- | ----------------- | --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A01 help/inventory    | `selb-ctl-a01-a`  | A   | 1        | matching cwd/PWD/host cwd; plugin load observed; native `docs {search:"help"}` and Code Mode twin help both completed and journal-attributed | pass    |
| R01 exact seeded read | `selb-ctl-read-a` | A   | 1        | native `docs {read:"kb/test-commands.md"}` returned the seed; revision `1193e96a…` equals the seed SHA-256                                   | pass    |
| A01 help/inventory    | `selb-ctl-a01-b`  | B   | 1        | matching cwd/PWD/host cwd; plugin load observed; native help and Code Mode twin help completed and journal-attributed                        | pass    |
| R01 exact seeded read | `selb-ctl-read-b` | B   | 1        | native `docs {read:"kb/test-commands.md"}` returned the seed; revision `1193e96a…` equals the seed SHA-256                                   | pass    |

All four controls exited 0 with valid answers and no writes. They are separate
from every natural denominator and none was retried. The first natural trial
began after the fourth control finished.

## Results

### Per scenario and arm

| Scenario | Group               | Arm | Planned | Attempted | Completed | Usable | Primary pass | Gate pass | Gate blocked | Semantic P/F/JE/NJ | Required docs | Docs-mutation trials | Combined/planned | Combined/usable |
| -------- | ------------------- | --- | ------- | --------- | --------- | ------ | ------------ | --------- | ------------ | ------------------ | ------------- | -------------------- | ---------------- | --------------- |
| NOTE-01  | positive create     | A   | 5       | 5         | 5         | 5      | 5            | 1         | 4            | 1/0/0/4            | 1             | 1                    | **1/5**          | 1/5             |
| NOTE-01  | positive create     | B   | 5       | 5         | 5         | 5      | 5            | 0         | 5            | 0/0/0/5            | 1             | 0                    | **0/5**          | 0/5             |
| NOTE-02  | positive update     | A   | 5       | 5         | 5         | 5      | 5            | 2         | 3            | 2/0/0/3            | 1             | 2                    | **2/5**          | 2/5             |
| NOTE-02  | positive update     | B   | 5       | 5         | 5         | 5      | 4            | 2         | 3            | 2/0/0/3            | 1             | 3                    | **2/5**          | 2/5             |
| NOTE-03  | restraint transient | A   | 5       | 5         | 5         | 5      | 5            | 3         | 2            | 3/0/0/2            | 0             | 2                    | **3/5**          | 3/5             |
| NOTE-03  | restraint transient | B   | 5       | 5         | 5         | 5      | 5            | 4         | 1            | 4/0/0/1            | 0             | 1                    | **4/5**          | 4/5             |
| NOTE-04  | restraint duplicate | A   | 5       | 5         | 5         | 5      | 5            | 4         | 1            | 4/0/0/1            | 0             | 0                    | **4/5**          | 4/5             |
| NOTE-04  | restraint duplicate | B   | 5       | 5         | 5         | 5      | 5            | 4         | 1            | 4/0/0/1            | 0             | 0                    | **4/5**          | 4/5             |

Totals: 40/40 planned, attempted, completed and usable; 39/40 primary pass;
20/40 gate pass; 20/40 gate blocked; 20 semantic passes, 0 semantic fails, 0
judge errors, 20 not judged (gate-blocked); 0 policy violations; 0
shell-written documents. Gate pass + gate blocked = 40 usable;
P + F + JE + NJ = 40 usable. Combined success requires primary pass, gate pass,
semantic pass and no policy violation. All denominators are usable trials.

### Positive group (NOTE-01/02)

| Scenario                 | Arm A    | Arm B    | Difference |
| ------------------------ | -------- | -------- | ---------- |
| NOTE-01 retry boundary   | 1/5      | 0/5      | −1         |
| NOTE-02 stale setup rule | 2/5      | 2/5      | 0          |
| **Positive total**       | **3/10** | **2/10** | **−1**     |

Five useful positive notes/updates were accepted in total: Arm A's
`engineering/webhook-retry-safety.md` create (NOTE-01 b3) and two in-place
`setup/node-version.md` replacements (NOTE-02 b1, b5); Arm B's two in-place
`setup/node-version.md` replacements (NOTE-02 b3, b4). Arm B's NOTE-01 trials
made no document write; three made native docs searches, one made a nested
attempt, and one made no docs call. These were silent code-only completions,
not proposal-only answers.

Arm B's NOTE-02 b1 made an in-place replacement whose primary check passed, but
the gate blocked it because the literal string `Node 22` survives (the note
says setup rejects Node 22, rather than claiming the repository uses it). That
is a deterministic omission-gate block; its semantic acceptance is unknown, not
a semantic failure. Arm B's NOTE-02 b5 failed its primary check (`.nvmrc` left
at 22) and made no docs call or note update: it missed **both** required
outcomes. No other positive trial failed its primary check.

### Restraint group (NOTE-03/04)

| Scenario                 | Arm A    | Arm B    | Difference |
| ------------------------ | -------- | -------- | ---------- |
| NOTE-03 interrupted run  | 3/5      | 4/5      | +1         |
| NOTE-04 replay diagnosis | 4/5      | 4/5      | 0          |
| **Restraint total**      | **7/10** | **8/10** | **+1**     |

NOTE-03: three unnecessary notes were written, all inside the permitted lake
and therefore restraint failures rather than policy violations:

- Arm A b2: `lakes/docs/testing/interrupted-runs.md` (native add).
- Arm A b5: `lakes/docs/testing/stale-run-lock.md` (Code Mode twin add).
- Arm B b2: `lakes/docs/testing/stale-run-lock.md` (Code Mode twin add).

Each records a generic stale-lock cleanup procedure the specification treats as
transient state. Both arms therefore exhibit the failure mode; the selective
wording did not eliminate it.

NOTE-04: both arms' b3 trials were gate-blocked because no completed docs read
of `ops/webhook-debugging.md` was observed. Both kept the fixture, script and
existing note unchanged, so restraint itself held, but the required
consultation was not established. Their semantic acceptance is unknown.

### Paired comparisons (combined outcome)

| Scenario  | Both pass | Both fail | A-only | B-only | Incomplete |
| --------- | --------- | --------- | ------ | ------ | ---------- |
| NOTE-01   | 0         | 4         | 1      | 0      | 0          |
| NOTE-02   | 0         | 1         | 2      | 2      | 0          |
| NOTE-03   | 3         | 1         | 0      | 1      | 0          |
| NOTE-04   | 4         | 1         | 0      | 0      | 0          |
| **Total** | **7**     | **7**     | **3**  | **3**  | **0**      |

Both-fail counts include gate-blocked trials, whose semantic acceptance is
unknown. The aggregate hides opposite movements: NOTE-02 splits 2–2, NOTE-03
favours B by one pair, and NOTE-01 favours A by one pair. Five pairs per
scenario are exploratory and establish neither a stable effect size nor
equivalence.

### Primary-task completion

| Arm | Primary pass | Primary fail | Dual failure (primary + required note) |
| --- | ------------ | ------------ | -------------------------------------- |
| A   | 20/20        | 0            | 0                                      |
| B   | 19/20        | 1            | 1                                      |

The single dual failure is `selb-B-b5-NOTE-02`: `.nvmrc` remained at 22, and the
required in-place note update was not made.

### Proposal-only, duplicates, preservation and policy

- Proposal-only answers: **0** in both arms. Positive misses were silent
  code-only completions.
- Duplicate documents: **0**. No duplicate `node-24.md`; no near-duplicate of
  an existing correct note. The three restraint notes are generic but were
  written in separate isolated trials, not twice in one trial.
- Preservation: seeded notes were untouched except for the intended NOTE-02
  replacement. The B NOTE-02 b1 replacement preserved nvm/CI but retained the
  literal `Node 22` string in a corrected rejection sentence, so the
  deterministic gate blocked it.
- Unsupported claims: not assessed in unjudged notes. The only unjudged note
  mutation was the B NOTE-02 b1 replacement above; its block reason is
  recorded. No judged note failed on unsupported scope.
- Policy violations: **0**. Every documentation mutation was inside
  `lakes/docs/**`.
- Shell-written documents: **0**. All nine document mutations were
  plugin-mediated and journal-attributed (native or Code Mode twin).

## Non-pass table

Twenty trials did not reach combined success. `Primary` is the independent
pristine check; `Docs action` counts one document plus its parent/lock
directories as one mutation; `Judge` is `not-judged` for every gate block.

| Stamp               | Group/arm   | Primary  | Actual documentation action          | Gate reason                                     | Judge      |
| ------------------- | ----------- | -------- | ------------------------------------ | ----------------------------------------------- | ---------- |
| `selb-A-b1-NOTE-01` | positive/A  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-A-b2-NOTE-01` | positive/A  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-A-b4-NOTE-01` | positive/A  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-A-b5-NOTE-01` | positive/A  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-A-b2-NOTE-02` | positive/A  | pass     | none                                 | required replacement did not happen             | not-judged |
| `selb-A-b3-NOTE-02` | positive/A  | pass     | none                                 | required replacement did not happen             | not-judged |
| `selb-A-b4-NOTE-02` | positive/A  | pass     | none                                 | required replacement did not happen             | not-judged |
| `selb-A-b2-NOTE-03` | restraint/A | pass     | create `testing/interrupted-runs.md` | restraint failed: docs surface changed          | not-judged |
| `selb-A-b5-NOTE-03` | restraint/A | pass     | create `testing/stale-run-lock.md`   | restraint failed: docs surface changed          | not-judged |
| `selb-A-b3-NOTE-04` | restraint/A | pass     | none                                 | no completed read of `ops/webhook-debugging.md` | not-judged |
| `selb-B-b1-NOTE-01` | positive/B  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-B-b2-NOTE-01` | positive/B  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-B-b3-NOTE-01` | positive/B  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-B-b4-NOTE-01` | positive/B  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-B-b5-NOTE-01` | positive/B  | pass     | none                                 | no created knowledge doc                        | not-judged |
| `selb-B-b1-NOTE-02` | positive/B  | pass     | replace `setup/node-version.md`      | replacement still contains literal `Node 22`    | not-judged |
| `selb-B-b2-NOTE-02` | positive/B  | pass     | none                                 | required replacement did not happen             | not-judged |
| `selb-B-b5-NOTE-02` | positive/B  | **fail** | none                                 | required replacement did not happen             | not-judged |
| `selb-B-b2-NOTE-03` | restraint/B | pass     | create `testing/stale-run-lock.md`   | restraint failed: docs surface changed          | not-judged |
| `selb-B-b3-NOTE-04` | restraint/B | pass     | none                                 | no completed read of `ops/webhook-debugging.md` | not-judged |

The remaining twenty trials passed their gate and were judged; all twenty
semantic verdicts were `pass`.

## Judge provenance

- Eligible trials: 20; judge attempts: 20; exactly one `attempt-001` per
  eligible trial.
- Judge model: `opencode-go/glm-5.3-flash`; no substitution.
- Errors/retries: 0 judge errors, 0 retries, no rejudging for consistency, no
  manual upgrades.
- Rubric identity: NOTE-01 `62591053…`, NOTE-02 `81a1c31c…`, NOTE-03
  `1222df13…`, NOTE-04 `9922c98a…` (full hashes in `ANALYSIS.json`).
- Evidence supplied: frozen rubric, final answer, mutation report,
  primary-check record, actual resulting note excerpt or unchanged preserved
  note. No arm label appears in the judge prompt.
- Every judged attempt's recorded `answerHash` and `rubricHash` matches the
  saved `final.md` and rubric. Gate-blocked trials made no judge model call.

## Routes and exposure

| Scenario | Arm | Sessions with completed native docs call | Sessions with Code Mode twin add | Sessions with no docs call | Native add ops | Twin add ops |
| -------- | --- | ---------------------------------------- | -------------------------------- | -------------------------- | -------------- | ------------ |
| NOTE-01  | A   | 3                                        | 0                                | 1                          | 1              | 0            |
| NOTE-01  | B   | 3                                        | 0                                | 1                          | 0              | 0            |
| NOTE-02  | A   | 1                                        | 1                                | 3                          | 1              | 1            |
| NOTE-02  | B   | 2                                        | 1                                | 2                          | 2              | 1            |
| NOTE-03  | A   | 1                                        | 1                                | 3                          | 1              | 1            |
| NOTE-03  | B   | 1                                        | 1                                | 4                          | 0              | 1            |
| NOTE-04  | A   | 5                                        | 0                                | 0                          | 0              | 0            |
| NOTE-04  | B   | 4                                        | 0                                | 1                          | 0              | 0            |

- Assigned configuration: 40/40 sessions ran the intended arm; plugin hash and
  commit matched the arm in 40/40; no wrong-arm session.
- Plugin load: `msg="loading plugin"` appeared exactly once in all 40 session
  logs.
- Native advertisement is established only for the 20 sessions with a completed
  native call. For the other 20 it is unknown, not absent: no
  `tool-definitions.json` and no system-prompt capture exist.
- Exact delivery of the appended paragraph to any session, including
  non-callers, is not established. A native call proves the definition was
  supplied in that session, not that the model read the paragraph.
- Code Mode twin writes are journal-attributed operations inside `execute`; the
  CLI emits no separate nested event, so nested attempts remain attempts unless
  the plugin journal records the completed twin operation.

The comparison describes the effect of **assigning** the tested configuration,
not of every model demonstrably reading or acting on the append.

## Integrity and exclusions

- 40/40 sessions: plugin load, matching invocation cwd / child PWD / host-logged
  cwd, arm plugin hash, arm commit, prompt hash, `work/AGENTS.md` hash, frozen
  `run.json` identity and per-case freeze receipt all agree.
- 40/40 signed operation journals verify against their per-trial HMAC keys; no
  invalid or unsigned record.
- 40/40 `final.md` hashes match the recorded answer hash; 20/20 judged rubric
  hashes match; 40/40 have exactly one judge attempt or none.
- Four controls: 4/4 intended plugin hash and commit, valid answers, one plugin
  load each.
- Evidence manifest: `EVIDENCE.sha256` covers the plan, identity, logs,
  analysis and raw result trees. Excluded: `node_modules`, `.git` internals and
  every `*.key` signing-key file. No secret key content was printed or hashed.
- No push, PR, merge, release or external action occurred.

## Telemetry and cost

| Phase        | Calls/steps             | Input   | Output | Reasoning | Cache-read | Indicative estimate   |
| ------------ | ----------------------- | ------- | ------ | --------- | ---------- | --------------------- |
| Controls     | 4 sessions / 8 steps    | 27,360  | 2,112  | 3,429     | 25,216     | $0.0075               |
| Trials A     | 20 sessions / 169 steps | 219,794 | 20,098 | 16,914    | 1,281,408  | included in workhorse |
| Trials B     | 20 sessions / 164 steps | 281,014 | 18,923 | 20,015    | 1,231,744  | included in workhorse |
| Trials total | 40 sessions / 333 steps | 500,808 | 39,021 | 36,929    | 2,513,152  | $0.1282 workhorse     |
| Judges       | 20 attempts / 20 steps  | 99,584  | 3,023  | 7,434     | 39,808     | $0.0214 judge         |

Recorded step cost is **0** in the saved telemetry, which is not evidence of
zero billing. At the listed opencode-go prices and treating reasoning as
output, the indicative total is about **$0.157** (controls + workhorse +
judge). Actual billing is unverified. Twenty judge attempts correspond to
twenty judge model steps; the workhorse used 333 steps across forty trials.

## Facts

- The exact append is 166 characters; with the joining space it adds 167.
- The experimental cap was 2250 in both arms; Arm A measured 2083 and Arm B 2250. The production cap remains 2100.
- Positive combined recording was 3/10 for A and 2/10 for B; NOTE-01 was 1/5
  for A and 0/5 for B.
- Restraint combined was 7/10 for A and 8/10 for B; both arms wrote
  unnecessary transient-lock notes.
- Primary-task completion was 20/20 for A and 19/20 for B; the single B failure
  also missed its required note update.
- Twenty trials were judged, all passed; twenty were gate-blocked and have
  unknown semantic acceptance. There were no policy violations, duplicates or
  shell-written notes.

## Inferred

- The selective append did not reproduce the earlier long candidate's positive
  recording gain: on this workhorse and fixture set, the control arm recorded
  more useful positives than the treatment arm.
- The restraint cost seen with the earlier long candidate is not specific to
  that candidate: both arms produced generic stale-lock notes here, so
  shortening and reframing the paragraph did not repair selection.
- The gate-block on the B NOTE-02 b1 replacement is a literal `omits` match,
  not evidence that the note asserted a stale repository rule. Its semantic
  acceptance remains unknown; the gate should not be read as proof that the
  content was wrong.
- The comparison is an assignment effect. Delivery to non-callers is unproven,
  and five pairs per scenario cannot separate a treatment effect from model
  variation.

## Tested

- Exact description, twin, budget, prompt, rubric, config, fixture and
  permission identities across both arms.
- `npm test` 705/705 and `npm run typecheck` in both arms; `defined comply
--full` at the starting source and with each arm's files.
- Four unjudged first-attempt controls, then forty fresh natural sessions in
  the frozen schedule, then twenty first-attempt judges.
- Integrity: 40/40 plugin load, cwd/PWD/host cwd, arm hash, commit, prompt,
  AGENTS, run description, freeze receipt, answer hash and journal HMAC.

## Failed approaches

- Running `defined comply` inside a linked worktree: the gate container cannot
  resolve the worktree's `.node_modules` mount. The main checkout carried each
  arm's exact files and was restored afterwards; this is an infrastructure
  limitation, not a code result.
- Treating every gate block as a semantic failure: the B NOTE-02 b1 replacement
  is a literal omission-gate block, and the other nineteen blocks are missing
  required artefacts or failed restraint, whose semantic acceptance is
  unknown.
- Treating the note "the setup rejects Node 22" as the stale "this repository
  uses Node 22" claim: the gate matches the literal string and blocks it, but
  the content is a corrected statement.

## Open questions

- Would a longer campaign separate the NOTE-01 difference (A 1/5, B 0/5) from
  model variation? Five pairs cannot.
- Is the current control arm's 2/5 NOTE-03 restraint failure a stable baseline
  behaviour, given the earlier campaign's control arm had 0/5? The fixture and
  wording are unchanged; that difference is a warning about small samples.
- Should the NOTE-02 omission gate distinguish the stale claim from a corrected
  rejection sentence, or is the literal check intentional? This run must not
  change the rubric; it records the block.
- Can a per-session tool-definition capture establish exact paragraph delivery
  to non-callers without new instrumentation? Not attempted.

## Recommendation

**Reject this exact candidate for production on this evidence.** It did not
improve useful positive recording (A 3/10 vs B 2/10), gave only a one-pair
restraint difference (7/10 vs 8/10) while both arms still wrote transient notes,
and produced one primary-task failure that also missed its required note. The
candidate remains over the production 2100 combined ceiling, so the 2250 cap
was experimental only. The sample is exploratory and does not establish a
stable effect size or equivalence; no second candidate, budget increase,
baseline or campaign is authorised by this result.

## Derived correction

The NOTE-02 literal-omission defect recorded above was repaired and the whole
preserved population reanalysed. The derived outcomes are reported separately
and do not rewrite this run's tables:
[description-recording-selective-budget-derived-2026-11-09.md](description-recording-selective-budget-derived-2026-11-09.md).

## Artefacts

- Evidence root (dev-box only):
  `/home/mark/tmp/docs-desc-selective-budget-20261109T1615Z/` — `RUN_PLAN.md`,
  `IDENTITY.json`, `ANALYSIS.json`, `ANALYSIS.txt`, `VERIFY.json`, validation,
  control, trial and judge logs, `EVIDENCE.sha256`, and preserved arm
  worktrees at `arms/a` (`88b2923`) and `arms/b` (`313789f`).
- Tracked plan:
  `docs/testing/description-recording-selective-budget-plan-2026-11-09.md`.
- Earlier long-paragraph comparison, not pooled: experiment branch commit
  `487976a` (not included in this PR).
- Blocked preparation attempt, not overwritten: experiment branch commit
  `4a02592` (not included in this PR).
