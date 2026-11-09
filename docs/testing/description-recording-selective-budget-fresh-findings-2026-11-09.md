---
Area: Testing
Keywords: automatic-notetaking, selective-recording, fresh-campaign, note-01, note-02, note-03, note-04, repaired-gate, deepseek, glm, 2250
Summary: Fresh forty-trial replication of the selective-recording comparison under the repaired NOTE-02 replace gate. Positive recording was A 7/10 and B 7/10, combined restraint A 7/10 and B 7/10, primary checks 40/40 attempted (39/39 usable) with one unusable B trial. The append showed no demonstrated recording advantage; one fresh B trial exercised the corrected corrective-mention path.
---

# Fresh selective recording under the repaired gate, 2026-11-09

## Outcome and scope

**Completed fresh replication.** Four first-attempt controls passed, then forty
fresh natural sessions ran under the exact original A/B wording and the
repaired shared measurement. Positive recording was **A 7/10, B 7/10**;
combined restraint was **A 7/10, B 7/10**; primary checks passed **40/40
attempted (39/39 usable)**. Thirty-nine of forty sessions were usable:
`self-B-b2-NOTE-04` exited 1 with an invalid answer after a Web Search input
request the run could not answer. Its primary check passed but it is not
counted as usable or combined.

Twenty-eight trials were gate-eligible and all passed the frozen judge;
twelve were gate-blocked, including the unusable session, and their semantic
acceptance is unknown. One fresh B NOTE-02 trial (`self-B-b4-NOTE-02`) did
exercise the corrected path: its note says Node 22 and older are rejected, the
gate passed it, and the judge passed it.

This is a separate population from the original forty trials and from the
derived reanalysis. It is not pooled with either and does not rewrite their
tables. It remains an assigned-configuration comparison: delivery of the
appended paragraph to non-callers is not established.

## Identity

| Item                        | Value                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                  | `/home/mark/repos/opencode-docs-plugin`                                                                                                                                     |
| Branch                      | `experiment/recording-closing-variant`                                                                                                                                      |
| Fresh plan commit           | `9bef46ce23fb03ecc43932b190976525d8c56646`                                                                                                                                  |
| Shared repaired measurement | `9744c8bde192508b250858ce6a4ff1bed6bedb4a`; harness `eea1b23267526bd69f2a511a92eebf37fa55864fd684d962cf6bf68367ca6005`                                                      |
| Arm A execution             | `bc422184ab140be701be032418f991420917e8be`, tree `835486355f90b734c1b4167d3eecbfe384643afc`, plugin hash `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` |
| Arm B execution             | `2fd0935f816816eba9870f73ccc1e50bc0511b15`, tree `18a4b13cd22571d056c0f8e27aa22070c430405d`, plugin hash `553d9e64d4321c3586fc577fffd44aa20ac32f75abac0eceaf79ea327177c535` |
| Campaign root               | `/home/mark/tmp/docs-desc-selective-fresh-20261109T1715Z/` (dev-box only)                                                                                                   |
| Window                      | `2026-11-09T17:08:20Z`–`2026-11-09T17:47Z` (UTC)                                                                                                                            |
| Workhorse                   | `opencode-go/deepseek-v4.1-flash`                                                                                                                                           |
| Independent judge           | `opencode-go/glm-5.3-flash`                                                                                                                                                 |
| Runtime                     | OpenCode `v2.2.6`; Node `v26.13.0`; image `localhost/opencode-placement-trials`, id `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`                      |

`harnessVersion` is 6 for schema compatibility; the repaired measurement is
identified by the base commit, the harness file SHA and each run's arm commit.

## Arms and shared cap

Arm A native description is 415 characters, SHA-256
`c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c`,
byte-identical to the historical A description. Arm B is exactly A plus one
ASCII space and the 166-character paragraph, 582 characters, SHA-256
`678757412bec0f8e4b54297111e1262e5107db0bc38b76dcb2fa9407caa07cad`.
The twin description, skill, convention, package and lockfile are byte-
identical across arms.

Both arms change only `tests/budget.test.ts` to
`descriptionPlusAnnotations: 2250`. Native is 415/582 against the unchanged
600 ceiling; combined is 2083/2250 against the experimental 2250 cap. The
production combined cap remains 2100, so B still exceeds it by 150. The cap is
test-only, absent from model-visible content and not used to truncate or select
content.

The fixed prompts, rubrics and fixture trees are byte-identical to the
historical campaign except `generation.json` timestamps and manifest metadata.
The trial corpus, diagnostic corpus, read-control corpus, standing permission
and four primary checks match the frozen hashes.

## Controls

All controls were first attempts, unjudged and excluded from natural
denominators.

| Control           | Stamp             | Arm | Criterion                                                                             | Outcome |
| ----------------- | ----------------- | --- | ------------------------------------------------------------------------------------- | ------- |
| Help/inventory    | `self-ctl-a01-a`  | A   | native `docs {search:"help"}` and Code Mode twin help completed; journal MAC valid    | pass    |
| Exact seeded read | `self-ctl-read-a` | A   | native read returned `kb/test-commands.md`; revision `1193e96a…` equals the seed hash | pass    |
| Help/inventory    | `self-ctl-a01-b`  | B   | same as A                                                                             | pass    |
| Exact seeded read | `self-ctl-read-b` | B   | same as A                                                                             | pass    |

All four had matching cwd/PWD/host cwd, one observed plugin load, the intended
plugin hash and commit, a valid answer and zero writes.

## Per scenario and arm

| Scenario | Group               | Arm | Planned | Attempted | Completed | Usable | Primary pass | Gate pass | Gate blocked | Semantic P/F/JE/NJ | Combined/planned | Combined/usable |
| -------- | ------------------- | --- | ------- | --------- | --------- | ------ | ------------ | --------- | ------------ | ------------------ | ---------------- | --------------- |
| NOTE-01  | positive create     | A   | 5       | 5         | 5         | 5      | 5            | 2         | 3            | 2/0/0/3            | 2/5              | 2/5             |
| NOTE-01  | positive create     | B   | 5       | 5         | 5         | 5      | 5            | 2         | 3            | 2/0/0/3            | 2/5              | 2/5             |
| NOTE-02  | positive update     | A   | 5       | 5         | 5         | 5      | 5            | 5         | 0            | 5/0/0/0            | 5/5              | 5/5             |
| NOTE-02  | positive update     | B   | 5       | 5         | 5         | 5      | 5            | 5         | 0            | 5/0/0/0            | 5/5              | 5/5             |
| NOTE-03  | restraint transient | A   | 5       | 5         | 5         | 5      | 5            | 3         | 2            | 3/0/0/2            | 3/5              | 3/5             |
| NOTE-03  | restraint transient | B   | 5       | 5         | 5         | 5      | 5            | 3         | 2            | 3/0/0/2            | 3/5              | 3/5             |
| NOTE-04  | restraint duplicate | A   | 5       | 5         | 5         | 5      | 5            | 4         | 1            | 4/0/0/1            | 4/5              | 4/5             |
| NOTE-04  | restraint duplicate | B   | 5       | 5         | 4         | 4      | 5            | 4         | 1            | 4/0/0/1            | 4/5              | 4/4             |

Totals: 40 planned; 40 attempted; 39 completed and usable; primary **40/40
attempted, 39/39 usable**; gate pass **28 attempted, 28 usable**; gate blocked
**12 attempted, 11 usable**; semantic **28P/0F/0JE/12NJ attempted,
28P/0F/0JE/11NJ usable**; 0 policy violations; 0 shell-written documents;
18 document mutations. Gate pass + gate blocked = 40 planned; P + F + JE + NJ =
40 planned. Usable trials are 39; the twelve gate-blocked include one unusable
session.

| Measure       | Attempted | Usable-only |
| ------------- | --------- | ----------- |
| Sessions      | 40        | 39          |
| Primary check | 40 pass   | 39 pass     |
| Gate pass     | 28        | 28          |
| Gate blocked  | 12        | 11          |
| Semantic P/NJ | 28 / 12   | 28 / 11     |
| Combined      | 28        | 28          |

The unusable block is `self-B-b2-NOTE-04`: primary pass, gate blocked, no
documentation write, not usable. It remains an attempt and was not replaced.

Group totals: positive A 7/10 planned and usable, B 7/10 planned and 7/10
usable (no positive trial was unusable). Combined restraint A 7/10 planned and
usable, B 7/10 planned and 7/9 usable. Raw no-write restraint across NOTE-03/04
is separate: A 8/10 attempted and usable, B 8/10 attempted and 7/9 usable.

## Paired outcomes

| Scenario | Both pass | Both fail | A-only | B-only | Incomplete |
| -------- | --------- | --------- | ------ | ------ | ---------- |
| NOTE-01  | 1         | 2         | 1      | 1      | 0          |
| NOTE-02  | 5         | 0         | 0      | 0      | 0          |
| NOTE-03  | 1         | 0         | 2      | 2      | 0          |
| NOTE-04  | 3         | 0         | 0      | 1      | 1          |

## Non-pass table

| Stamp               | Group/arm   | Primary | Documentation action                                   | Gate reason                                     | Judge      |
| ------------------- | ----------- | ------- | ------------------------------------------------------ | ----------------------------------------------- | ---------- |
| `self-A-b2-NOTE-01` | positive/A  | pass    | none                                                   | no created knowledge doc                        | not-judged |
| `self-A-b3-NOTE-01` | positive/A  | pass    | none                                                   | no created knowledge doc                        | not-judged |
| `self-A-b4-NOTE-01` | positive/A  | pass    | none                                                   | no created knowledge doc                        | not-judged |
| `self-A-b2-NOTE-03` | restraint/A | pass    | create `ops/interrupted-test-runs.md`                  | restraint failed                                | not-judged |
| `self-A-b5-NOTE-03` | restraint/A | pass    | create `testing/interrupted-runs.md`                   | restraint failed                                | not-judged |
| `self-A-b3-NOTE-04` | restraint/A | pass    | none                                                   | no completed read of `ops/webhook-debugging.md` | not-judged |
| `self-B-b2-NOTE-01` | positive/B  | pass    | none                                                   | no created knowledge doc                        | not-judged |
| `self-B-b3-NOTE-01` | positive/B  | pass    | none                                                   | no created knowledge doc                        | not-judged |
| `self-B-b5-NOTE-01` | positive/B  | pass    | none                                                   | no created knowledge doc                        | not-judged |
| `self-B-b2-NOTE-04` | restraint/B | pass    | none                                                   | trial did not complete (exit 1)                 | not-judged |
| `self-B-b3-NOTE-03` | restraint/B | pass    | create `Testing/stale-tmp-run-lock-breaks-npm-test.md` | restraint failed                                | not-judged |
| `self-B-b4-NOTE-03` | restraint/B | pass    | create `testing/interrupted-run-lock.md`               | restraint failed                                | not-judged |

The unusable `self-B-b2-NOTE-04` produced a final answer, then the CLI exited
1 with `Cancelled a request for input this run cannot answer: Web Search`.
No retry was made. Its primary check passed; it is not counted as usable or
combined.

## Corrected NOTE-02 path exercised fresh

Nine of ten fresh NOTE-02 notes avoided the old literal. `self-B-b4-NOTE-02`
included:

> `scripts/check-node.mjs` enforces a minimum major version of 24 during
> `npm run setup`; Node 22 and older are rejected.

The repaired gate passed it and the frozen judge passed it. The judge's reason
says the note has "no trace of Node 22", which is inaccurate about the literal.
The verdict is preserved, but the rubric's acceptance of corrective mentions is
ambiguous and is recorded in the caveat below; this is not evidence that the
frozen rubric unambiguously permitted it. No retry or manual rewrite was made.
This is a fresh example of the corrected eligibility path, not a re-judgment of
the original trial.

## Judge provenance

- Eligible/attempted: 28/28, exactly one `attempt-001` each.
- Model: `opencode-go/glm-5.3-flash`; no substitution.
- Errors/retries: 0/0; no manual upgrades.
- Rubric hashes unchanged: NOTE-01 `62591053…`, NOTE-02 `81a1c31c…`,
  NOTE-03 `1222df13…`, NOTE-04 `9922c98a…`.
- Evidence: frozen rubric, final answer, mutation report, primary-check record
  and actual resulting or preserved note excerpt. Arm label hidden.

## Full identity ledger

| Item                          | Full value                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Shared repaired measurement   | `9744c8bde192508b250858ce6a4ff1bed6bedb4a`                                                  |
| Repaired harness SHA-256      | `eea1b23267526bd69f2a511a92eebf37fa55864fd684d962cf6bf68367ca6005`                          |
| Arm A commit / tree           | `bc422184ab140be701be032418f991420917e8be` / `835486355f90b734c1b4167d3eecbfe384643afc`     |
| Arm B commit / tree           | `2fd0935f816816eba9870f73ccc1e50bc0511b15` / `18a4b13cd22571d056c0f8e27aa22070c430405d`     |
| Arm A plugin hash             | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8`                          |
| Arm B plugin hash             | `553d9e64d4321c3586fc577fffd44aa20ac32f75abac0eceaf79ea327177c535`                          |
| NOTE-02 rubric SHA-256        | `81a1c31c36da9e12ca7a48d1e875819a6c5d29e00461855650da3b4f2d4d0827`                          |
| NOTE-02 primary-check SHA-256 | `55d708a0defabc5c5487591c70f208135e40a133acb8e4997930f3499f276f7f`                          |
| Fresh manifest                | 2074 files; file SHA-256 `33690118ba58336f79088525dad41c5c739f7385f9a6c7cc20ea3a168938d16d` |
| Workhorse / judge             | `opencode-go/deepseek-v4.1-flash` / `opencode-go/glm-5.3-flash`                             |

## Integrity and exposure

- 40/40 sessions: plugin load, cwd/PWD/host cwd, arm plugin hash, arm commit,
  prompt hash, `AGENTS.md` hash, run description and freeze receipt agree.
- 40/40 signed operation journals verify; 40/40 answer hashes match; 28/28
  judge attempts match model and rubric.
- 4/4 controls pass their criteria.
- The fresh manifest excludes `node_modules`, `.git` internals and `*.key`
  files; signing-key contents were never printed or hashed.
- Assigned configuration is established; exact delivery of the appended
  paragraph to non-callers is not. Native advertisement is established only
  for sessions with a completed native call.
- All 18 document mutations are plugin-attributed. The Code Mode twin add in
  `self-B-b3-NOTE-03` omits an explicit `path` in its DTO; its target derives
  from Area and H1, matching the recorded file, so it is a journal-attributed
  twin write, not a shell write.

## Restraint versus consultation (NOTE-03/04)

NOTE-03 had no documentation mutation in A 3/5 and B 3/5; each arm wrote two
unnecessary notes. NOTE-04 had no documentation mutation in 5/5 each. Across
both restraint scenarios the raw no-write result is **A 8/10, B 8/10
attempted; A 8/10, B 7/9 usable**. Combined restraint success is **A 7/10,
B 7/10 attempted; A 7/10, B 7/9 usable**. These are different measures: an
unnecessary permitted note is a restraint failure, while a no-write attempt
that is unusable is an observed no-write outcome, not a successful usable
session.

Required NOTE-04 consultation was verified for A 4/5 and B 4/5. The unverified
cases are `self-A-b3-NOTE-04` (no completed read) and `self-B-b2-NOTE-04`
(unusable session). The original combined rule is unchanged.

## Rubric and judge caveat (review correction, 2026-11-09)

The frozen NOTE-02 rubric says the existing note "states Node 24 and no longer
states Node 22". The fresh `self-B-b4-NOTE-02` note instead says:

> `scripts/check-node.mjs` enforces a minimum major version of 24 during
> `npm run setup`; Node 22 and older are rejected.

The repaired deterministic gate passed it and the frozen judge passed it, but
the judge's reason says the note has "no trace of Node 22", which is factually
wrong about the literal. The verdict is preserved; no rejudge or manual
upgrade was made.

The repair changes deterministic eligibility only. It does **not** change the
frozen rubric, and the judge's pass is not evidence that the rubric
unambiguously permitted corrective mentions. The rubric remains ambiguous
between literal absence and absence of the stale assertion. If a future
rubric version is authorised, the proposed accept bullet is: "The existing
setup note is replaced in place: it states Node 24 as the supported version
and does not present Node 22 as current; a corrective statement that Node 22
is rejected is acceptable, while nvm and CI facts survive." The proposed
tempting wrong answer is: "Fixing the script and config but leaving the stale
claim that the repository uses Node 22." This wording was not applied and no
trial was rejudged against it.

## Telemetry

| Phase    | Sessions/steps | Input   | Output | Reasoning | Cache-read |
| -------- | -------------- | ------- | ------ | --------- | ---------- |
| Controls | 4 / 8          | 28,714  | 1,903  | 3,847     | 24,192     |
| Trials   | 40 / 389       | 632,179 | 47,416 | 50,176    | 3,133,568  |
| Judges   | 28 / 39        | 144,570 | 5,504  | 11,818    | 134,784    |

Recorded step cost is 0 in the saved telemetry, which is not evidence of zero
billing. Actual billing is unavailable.

## Facts

- Observed positive recording counts were 7/10 per arm; observed combined
  restraint was 7/10 per arm. These are counts, not equivalence claims.
- Raw no-write restraint across NOTE-03/04 was A 8/10 and B 8/10 attempted
  (usable-only A 8/10, B 7/9); combined restraint was A 7/10 and B 7/10
  attempted (usable-only A 7/10, B 7/9).
- NOTE-02 was 5/5 in both arms; one B note used the corrected rejection
  sentence and passed the repaired gate and the judge.
- Primary checks passed 40/40 attempted and 39/39 usable; one B NOTE-04
  session was unusable after a CLI exit 1 and is not counted as combined.
- No policy violations and no shell-written documents occurred.
- The append produced no demonstrated positive-recording advantage in this
  sample.

## Inferred

- The selective append does not show a demonstrated recording gain in this
  fresh population; the observed counts are not proof of zero effect or
  equivalence, and five pairs cannot establish either.
- The repaired gate is installable in both arms and accepts corrective prose;
  one fresh trial demonstrates that path outside the motivating original.
- The fresh NOTE-02 result differs markedly from the original (original A 2/5,
  B 3/5; fresh 5/5 each). That is model variation across draws, not a
  treatment effect.

## Tested

- Four controls, forty fresh natural sessions in the frozen schedule, then
  twenty-eight first-attempt judges.
- 40/40 plugin, cwd, prompt, AGENTS, receipt, journal-MAC and answer-hash
  checks; 28/28 judge model and rubric checks.
- Byte-identical fixed prompts, rubrics and fixture trees against the
  historical campaign, apart from generation timestamps and manifest metadata.

## Failed approaches

- Treating the fresh counts as a replication of the original counts: the
  populations are separate and the NOTE-02 draws differ.
- Using the generic shell-written heuristic on a Code Mode add that omits
  `path`: the target derives from Area and H1 and the signed journal proves
  plugin attribution.
- Retrying the unusable B NOTE-04 session: forbidden; it is preserved as an
  incomplete first attempt.

## Open questions

- Would a larger sample separate the observed positive counts from model
  variation? Five pairs cannot.
- Does the judge's rationale quality need a separate check when its verdict is
  correct but its wording is imprecise? Not part of this measurement; the
  preserved error is recorded above.

## Recommendation

**Reject this exact candidate for production on the fresh evidence.** It gave
no demonstrated positive-recording advantage (7/10 vs 7/10), no demonstrated
combined-restraint advantage (7/10 vs 7/10) and no primary-task advantage
(40/40 vs 40/40, with one unusable B session), while B remains over the
production 2100 combined ceiling. The sample is exploratory; observed
non-regression is not proof of zero effect or equivalence. No production
adoption, further candidate or external action is authorised.

## Artefacts

- Campaign root (dev-box only):
  `/home/mark/tmp/docs-desc-selective-fresh-20261109T1715Z/` with `RUN_PLAN.md`,
  `IDENTITY.json`, `CONTROLS-VERIFY.json`, `VERIFY.json`, `ANALYSIS.json`,
  `ANALYSIS.txt`, control/trial/judge logs, preserved arms and its own manifest.
- Tracked plan:
  `docs/testing/description-recording-selective-budget-fresh-plan-2026-11-09.md`.
- Derived correction:
  `docs/testing/description-recording-selective-budget-derived-2026-11-09.md`.
- Original findings:
  `docs/testing/description-recording-selective-budget-findings-2026-11-09.md`.
