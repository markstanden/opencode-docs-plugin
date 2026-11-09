---
Area: Testing
Keywords: automatic-notetaking, note-02, reanalysis, deterministic-gate, omits, superseded-claim, deepseek, glm, derived-measurement
Summary: Derived reanalysis of the preserved forty-trial selective-recording comparison after repairing the NOTE-02 literal omission gate. One previously blocked trial becomes eligible and passes the frozen judge; positive recording becomes A 3/10 and B 3/10. This is a measurement correction, not a fresh execution.
---

# NOTE-02 eligibility repair and derived reanalysis, 2026-11-09

## Outcome and scope

**Completed derived measurement.** The original forty-trial comparison was
reanalysed with a repaired deterministic replace gate. The repair changes no
workhorse answer, primary check, rubric, fixture, permission or attribution
rule. Exactly one trial changes: `selb-B-b1-NOTE-02` was blocked only because
the literal string `Node 22` survived in a sentence saying setup rejects it.
Under the repaired rule it is eligible and the frozen judge passed it on one
first attempt.

Derived positive recording is **A 3/10, B 3/10** (original B 2/10). Restraint
is unchanged at **A 7/10, B 8/10**; primary-task completion is unchanged at
**A 20/20, B 19/20**. Twenty trials remain gate-blocked with unknown semantic
acceptance.

This document is a **derived reanalysis of preserved executions**, not a fresh
baseline and not a new treatment estimate. The original findings and their
tables remain the historical record.

## Identity

| Item                  | Value                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Original evidence     | `/home/mark/tmp/docs-desc-selective-budget-20261109T1615Z/` (dev-box only)                  |
| Original Arm A        | `88b29239955b6671c5c5fdef62d648cd83168aa3`, tree `2a8e12273821a0a1c90e94d908e812fd8157d6c3` |
| Original Arm B        | `313789fd6cd3601120e72dad4d1ca24ee2da4f3f`, tree `f06a992d17d5f32564c2ece3a4befc9af0bd803e` |
| Original measurement  | harness version 6, generation version 4                                                     |
| Repaired measurement  | `9744c8bde192508b250858ce6a4ff1bed6bedb4a`                                                  |
| Reanalysis root       | `/home/mark/tmp/docs-desc-selective-reanalysis-20261109T1705Z/` (dev-box only)              |
| Reanalysis population | all 40 preserved NOTE trials; no exclusions                                                 |

## The defect and the minimal repair

The replace gate treated `expectedDocs.omits` as literal substring absence.
`selb-B-b1-NOTE-02` replaced the seeded note correctly and its primary check
passed, but the replacement said:

> `npm run setup` rejects Node versions older than 24, including Node 22.

The gate saw `Node 22` and reported "still carries superseded content". The
string was present; the stale claim was not.

The repair keeps the seed as the definition of the stale claim. For a replace,
the gate now fails only when a non-empty seeded line containing an `omits`
marker survives verbatim in the replacement. A replacement that discusses the
rejected value in new prose is eligible. If the seed has no line containing
the marker, the old literal rule applies; create expectations keep the literal
rule because they have no seeded predecessor.

Division of responsibility:

- **Deterministic eligibility**: required in-place modification, permitted
  surface, required retained facts, structural validity, preservation, no
  duplicate or unrelated change, and no surviving seeded stale claim.
- **Semantic acceptance**: whether the note correctly states the supported
  version, explains the procedure and does not present the old value as
  current. The frozen NOTE-02 rubric addresses this through "it states Node 24
  and no longer states Node 22" and the tempting wrong answer "leaving the
  stale note saying Node 22", but that wording is ambiguous between literal
  absence and absence of the stale assertion; see the review caveat below.

No sentence-pattern allowlist and no trial-specific exception were added.

## Validation and integrity

| Check                               | Scope                        | Result                               |
| ----------------------------------- | ---------------------------- | ------------------------------------ |
| Failing regression before repair    | new NOTE-02 eligibility test | fail: corrective note blocked        |
| Focused post-repair regression      | new test                     | pass                                 |
| `npm test`                          | repair tree `9744c8b`        | pass, 706/706                        |
| `npm run typecheck`                 | repair tree `9744c8b`        | pass                                 |
| `defined comply --full`             | repair tree `9744c8b`        | compliant; no automatic repairs      |
| Original manifest before reanalysis | 2044 files                   | `sha256sum -c` exit 0                |
| Original manifest after reanalysis  | 2044 files                   | `sha256sum -c` exit 0                |
| Derived attempts                    | 40 trials                    | 21 judged attempts, no `attempt-002` |

The original manifest excludes `node_modules`, `.git` internals and `*.key`
files. Signing-key contents were never printed or hashed. No original verdict,
answer, journal, receipt or manifest was edited.

## Original versus derived aggregates

| Scenario | Group               | Arm | Primary pass orig → derived (/5) | Gate pass (orig/derived) | Gate blocked (orig/derived) | Semantic P/F/JE/NJ (derived) | Combined (orig/derived) |
| -------- | ------------------- | --- | -------------------------------- | ------------------------ | --------------------------- | ---------------------------- | ----------------------- |
| NOTE-01  | positive create     | A   | 5 → 5                            | 1/1                      | 4/4                         | 1/0/0/4                      | 1/5 / **1/5**           |
| NOTE-01  | positive create     | B   | 5 → 5                            | 0/0                      | 5/5                         | 0/0/0/5                      | 0/5 / **0/5**           |
| NOTE-02  | positive update     | A   | 5 → 5                            | 2/2                      | 3/3                         | 2/0/0/3                      | 2/5 / **2/5**           |
| NOTE-02  | positive update     | B   | 4 → 4                            | 2/3                      | 3/2                         | 3/0/0/2                      | 2/5 / **3/5**           |
| NOTE-03  | restraint transient | A   | 5 → 5                            | 3/3                      | 2/2                         | 3/0/0/2                      | 3/5 / **3/5**           |
| NOTE-03  | restraint transient | B   | 5 → 5                            | 4/4                      | 1/1                         | 4/0/0/1                      | 4/5 / **4/5**           |
| NOTE-04  | restraint duplicate | A   | 5 → 5                            | 4/4                      | 1/1                         | 4/0/0/1                      | 4/5 / **4/5**           |
| NOTE-04  | restraint duplicate | B   | 5 → 5                            | 4/4                      | 1/1                         | 4/0/0/1                      | 4/5 / **4/5**           |

Each primary entry is passes out of five trials, shown as original → derived.
B NOTE-02 is **4/5 original and 4/5 derived**, not 4/4; the earlier `4/4`
notation was ambiguous.

Totals: 40 planned, attempted, completed and usable; primary 39/40; gate pass
21/40; gate blocked 19/40; semantic 21 pass, 0 fail, 0 judge error, 19 not
judged. Gate pass + gate blocked = 40; P + F + JE + NJ = 40.

Paired NOTE-02 changes from both-pass 0 / both-fail 1 / A-only 2 / B-only 2 to
both-pass 1 / both-fail 1 / A-only 1 / B-only 2. Other scenarios are unchanged.

## Every changed trial

| Trial               | Original                                                                | Derived                                  | Basis                                                                                                 |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `selb-B-b1-NOTE-02` | gate blocked: `still carries superseded content: "Node 22"`, not judged | gate pass; judge **pass**, `attempt-001` | in-place replacement, primary pass, nvm/CI retained; `Node 22` appears only in the rejection sentence |

Decisive replacement excerpt:

```markdown
- Use nvm.
- This repository requires Node 24 or newer.
- `.nvmrc` pins Node 24.
- `package.json` declares `engines.node` as `>=24`.
- `npm run setup` rejects Node versions older than 24, including Node 22.
- CI reads `.nvmrc`.
```

All other 39 trials keep their original gate verdict and reason. That includes
the unchanged B `selb-B-b5-NOTE-02` primary failure (`.nvmrc` left at 22, no
note update), the three restraint-note failures, and the two NOTE-04 trials
with no verified required read.

## Review corrections and caveats (2026-11-09)

These corrections are reporting clarifications; they do not rescore a trial,
rewrite a historical table or change a verdict.

- **Primary column.** Each entry in the aggregate table is passes out of five,
  shown as original → derived. B NOTE-02 is 4/5 original and 4/5 derived, not
  four passes out of four.
- **Raw no-write restraint versus combined restraint.** NOTE-03 has no
  documentation mutation in A 3/5 and B 4/5; NOTE-04 has no mutation in 5/5
  each. Across the two restraint scenarios the raw no-write result is
  **A 8/10, B 9/10**, while combined restraint success is **A 7/10, B 8/10**.
  These are different measures. The 7/10 versus 8/10 row is not numerical
  equality and does not establish a stable effect.
- **Consultation.** NOTE-04 required consultation was verified in A 4/5 and
  B 4/5. The two unverified cases are `selb-A-b3-NOTE-04` and
  `selb-B-b3-NOTE-04`; no-mutation restraint held in all ten NOTE-04 trials.
- **Frozen rubric ambiguity.** The frozen NOTE-02 rubric says the note
  "states Node 24 and no longer states Node 22". The preserved and fresh
  corrective notes use a rejection sentence containing the literal `Node 22`.
  The repair changes deterministic eligibility only; it does not change that
  rubric. The rubric is ambiguous between literal absence and absence of the
  stale assertion. Do not read a judge pass as proof that the rubric
  unambiguously permitted corrective mentions.
- **Judge rationale error, preserved.** In the fresh trial
  `self-B-b4-NOTE-02` the judge passed the corrective note but said it had
  "no trace of Node 22", which is factually wrong about the literal. The
  verdict is preserved; no rejudge or manual upgrade was made. The rationale
  error and acceptance ambiguity are recorded in the fresh findings.
- **Prospective clarification, unexecuted.** If a future rubric version is
  authorised, the proposed accept bullet is: "The existing setup note is
  replaced in place: it states Node 24 as the supported version and does not
  present Node 22 as current; a corrective statement that Node 22 is rejected
  is acceptable, while nvm and CI facts survive." The proposed tempting wrong
  answer is: "Fixing the script and config but leaving the stale claim that
  the repository uses Node 22." This wording was not applied and no trial was
  rejudged against it.
- **Conclusion boundary.** The derived and fresh samples show no demonstrated
  positive-recording advantage for the append. They do not prove zero effect,
  equivalence or production reliability.

## Measurement and evidence identity

| Item                          | Full value                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Repaired measurement commit   | `9744c8bde192508b250858ce6a4ff1bed6bedb4a`                                                  |
| Repaired harness SHA-256      | `eea1b23267526bd69f2a511a92eebf37fa55864fd684d962cf6bf68367ca6005`                          |
| Original Arm A plugin hash    | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8`                          |
| Original Arm B plugin hash    | `553d9e64d4321c3586fc577fffd44aa20ac32f75abac0eceaf79ea327177c535`                          |
| NOTE-02 rubric SHA-256        | `81a1c31c36da9e12ca7a48d1e875819a6c5d29e00461855650da3b4f2d4d0827`                          |
| NOTE-02 primary-check SHA-256 | `55d708a0defabc5c5487591c70f208135e40a133acb8e4997930f3499f276f7f`                          |
| Original manifest             | 2044 files; file SHA-256 `22269b1b827b01c211c7b4fa0343876fc5e21f7b829ba46aa3d17576416bcb8b` |
| Derived manifest              | 3673 files; file SHA-256 `cc1c1eb635c6354433fe646748229eb8f0f4eba3425831ff626f9864145f64cf` |

## Judge provenance

- Reused assessments: **20**. Each reused attempt matched the original
  `judgeKey`, answer hash, rubric hash, judge-prompt hash and model; no model
  call was made. The derived copy records `resumedFrom: attempt-001`.
- Newly eligible: **1** (`selb-B-b1-NOTE-02`).
- New attempts: **1**, `judge/attempt-001`, model
  `opencode-go/glm-5.3-flash`, started `2026-11-09T17:04:25Z`, judged in one
  attempt.
- Rubric: NOTE-02 `81a1c31c36da9e12ca7a48d1e875819a6c5d29e00461855650da3b4f2d4d0827`
  (unchanged).
- Judge errors/retries: **0**. No manual upgrades. The arm label was not
  supplied.
- Evidence supplied: frozen rubric, final answer, mutation report, primary
  check record and the actual resulting note excerpt.

## NOTE-04 restraint versus consultation

NOTE-04's combined outcome mixes two different behaviours. In all ten NOTE-04
trials the documentation surface was unchanged (`docsMutationTrials` 0/5 per
arm): **no-mutation restraint held 10/10**. Two trials, `selb-A-b3-NOTE-04`
and `selb-B-b3-NOTE-04`, were gate-blocked because no completed read of
`ops/webhook-debugging.md` was verified: **required consultation was verified
8/10, unverified 2/10**. This is reporting clarification only; the original
combined rule is unchanged.

## Interpretation

- The correction moves B's positive recording from 2/10 to 3/10, matching A's
  3/10 on this measure. It does not establish a treatment gain or equivalence;
  the same five pairs are exploratory.
- The correction does not change the primary-task result, the restraint
  result, or the production-budget mismatch (B combined 2250 exceeds the
  production 2100 ceiling).
- The result remains an assignment effect: delivery of the appended paragraph
  to non-callers is not established.
- A corrected verdict cannot establish a causal word-level effect or
  production reliability.

## Recommendation

The original candidate recommendation stands: **reject this exact candidate
for production on the preserved evidence**. The corrected count removes one
false negative but does not show any demonstrated improvement in useful
recording over the control. This is not proof of zero effect or equivalence,
and the derived restraint row remains A 7/10 versus B 8/10. Any fresh
replication is authorised by the technical readiness gate, not by whether the
derived counts favour A or B.

## Facts

- The deterministic defect was a literal `omits` match, not evidence that the
  B trial asserted a stale rule.
- The repair uses the seeded claim line as the stale unit; corrective prose is
  eligible and semantic correctness stays with the frozen judge.
- Exactly one of forty preserved trials changed outcome.
- Original evidence verified before and after with the declared exclusions.

## Inferred

- The literal filter systematically conflated a retained stale assertion with
  any discussion of the old value; the preserved example shows the false
  negative rather than a false positive.
- The corrected measurement makes the deterministic gate an eligibility check
  and leaves the research question's semantic acceptance to the independent
  judge, which is the intended division.

## Tested

- New regression: corrective mention eligible; quoted historical statement
  eligible; surviving seeded claim blocked; byte-identical replacement
  invalid; reworded stale claim passes determinism and fails the judge;
  existing duplicate and preservation boundaries unchanged.
- Full contract suite, typecheck and gate at the repair identity.
- Complete-population replay and judge-provenance comparison.

## Failed approaches

- Matching the stale marker anywhere in the replacement: it blocked a correct
  note that said setup rejects the old version.
- Adding accepted corrective phrases: rejected as a growing pattern list and
  an example-specific exception.
- Reusing the original verdict for a newly eligible trial: forbidden; the new
  attempt was made once with the frozen rubric and model.

## Open questions

- Would a fresh campaign reproduce the corrected NOTE-02 outcome? Five pairs
  cannot establish stability.
- Does the frozen rubric fail a genuinely contradictory note reliably? The
  synthetic reworded case does; no preserved trial supplies a real example.

## Artefacts

- Fresh replication under the repaired measurement:
  `description-recording-selective-budget-fresh-findings-2026-11-09.md`.
- Original findings:
  `docs/testing/description-recording-selective-budget-findings-2026-11-09.md`.
- Original plan:
  `docs/testing/description-recording-selective-budget-plan-2026-11-09.md`.
- Derived reanalysis (dev-box only):
  `/home/mark/tmp/docs-desc-selective-reanalysis-20261109T1705Z/` with
  `ORIGINAL-VERDICTS.json`, `derived-gate.log`, `ANALYSIS.json`,
  `DERIVED-ANALYSIS.txt`, the preserved `gen` copy and its own manifest.
