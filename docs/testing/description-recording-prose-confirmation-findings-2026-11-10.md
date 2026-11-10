---
Area: Testing
Keywords: description-prose, confirmation, r01, r02, r03, r04, paired-schedule, preservation, incomplete
Summary: Completed the 40-session paired A/B confirmation on the repaired R01–R04 corpus. 38 of 40 structured assessments completed; 18 complete pairs and 2 unmatched observations. B utility 26 versus A 29 (B−A −3); missing-data intervals A 24–34 and B 21–31. The qualification criterion is not satisfied because assessment coverage is incomplete, and the assessed population shows no B advantage; the result is incomplete and inconclusive rather than evidence against B.
---

# Native-description A/B confirmation: findings, 2026-11-10

This is campaign `rc-20261110`, a new experiment on revised, previously
developed scenarios. It is not independent scenario validation and is not
pooled with any historical run. Five repetitions of one scenario are one
scenario repeated, not five scenario types.

## Outcome

- All **40 natural sessions** ran serially in 20 adjacent A/B pairs between
  `18:20:27Z` and `19:06:40Z`; the order is chronological and parity-correct.
- **40 judge attempts** were made, one per trial, with no retry. **38** produced
  a usable structured judgement; **2** (one per arm, different pairs) were
  truncated and remain unknown.
- **18 complete pairs** and **2 unmatched observations**. Default utility:
  **A 29, B 26, B−A = −3** over the 38 assessed trials. Missing-data intervals:
  A `24..34`, B `21..31`; the full-population B−A interval is `−13..+7`.
- B's three-point deficit is one extra transient note (−1) and one extra
  duplicate (−2). Both arms recorded the same assessed useful work: five
  creates and four updates each.
- The qualification criterion is **not satisfied because assessment coverage is
  incomplete**; the assessed population shows no B advantage.
- No primary task failed outside R04. No mutation-policy breach occurred. No
  R02 preservation loss was found among the **eight assessed R02 trials**
  (8/8 preservation coverage); the two unassessed R02 trials have no verdict and
  remain unknown. Two R04 trials (one per arm) edited the lint script and then
  documented the changed behaviour; both failed the pristine primary check and
  were scored `misleading`. R04 destructive loss is an **unresolved guardrail
  for both arms** (below), not a clean pass.

**Decision: incomplete/inconclusive; no recommendation and no adoption.**

## Identity and execution

| Item                | Value                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Repository          | `github.com/markstanden/opencode-docs-plugin`, `/home/mark/repos/opencode-docs-plugin`                             |
| PR #49              | merged at `e10f32fd86fdb93e95c64a1aec2e2a0556fe537d`; tree equals reviewed head `a235513d…`; no intervening change |
| Base / execution    | `0a9116fe264a54be213875bef02ed355178afef0` (tree `100bb899…`), merged PR #49 plus readiness fixes                  |
| Arm A               | `0a9116f`, tree `100bb89942615ad737229450c4d18017b182aa83`                                                         |
| Arm B               | `352f5aafa010b0e66ee02888152f197a9cc27b02`, tree `c493e43652261ab1f6a82d15c1ba7cfe7f336b03`                        |
| Arm difference      | `src/index.ts` only                                                                                                |
| A description       | 415 chars, `c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c`                                      |
| B description       | 429 chars, `09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e`                                      |
| A plugin / combined | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` / 2073                                          |
| B plugin / combined | `04535cf3b9efece2edb9cc72e1dbbe57fa36e269688623c9d6eac61ee30bbd88` / 2087                                          |
| Corpus              | `911b4e1fab9e6c87f4875339fc29bc03dd7929bcbc4991adee909bd7265568df` (previously unexecuted repair)                  |
| Truth               | `066615127cbb629ff160f2cf9e1f251bde6f1f3cbfd1b055ec6b9495aefed3d5`                                                 |
| Schedule            | `a1ca0dcf3d939c325fb5bc8374388d655217abe10b698cff7eb126b6b0e881e8` (40 slots / 20 pairs)                           |
| Workhorse / judge   | `opencode-go/deepseek-v4.1-flash` / `opencode-go/glm-5.3-flash`                                                    |
| Runtime             | OpenCode `v2.2.6`, Node `v26.13.0`, image `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`       |
| Plan                | `b42ec3c81fff60e663d8a4e14e59eb8f0dc60098`                                                                         |

The arms' `src/index.ts` bytes are identical to the arms executed in the
stopped replication. The repaired corpus was executed for the first time here.

## Readiness

| Check                          | Result                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `npm test`                     | 810/810 pass at the execution revision                                    |
| `npm run typecheck`            | pass                                                                      |
| `defined comply`               | `{"status":"compliant"}`                                                  |
| `replication/verify.mjs`       | 32/32 in both arms; R04 premise, intended fix and wrong fix all proved    |
| R04 claimed lint command       | exits 1 with `MIGRATION_ORDER 002_add_index.sql`; `npm test` exits 0      |
| Permission mapping             | every rule maps to a visible instruction; semantics inspected             |
| Delivery probes (2 of 4)       | A 415/`c390…`, B 429/`09c9…`; combined 2073/2087 at the provider boundary |
| Packet freeze                  | all evidence blocks present; zero label leaks                             |
| Interruption / claim rehearsal | one winner, one refusal; started attempt never relaunched                 |

## Accounting

| Category                    | Trial sessions | Judge calls | Disposition              |
| --------------------------- | -------------- | ----------- | ------------------------ |
| Scheduled natural trials    | 40             | 40          | 40 recorded; 38 assessed |
| Truncated R02 judgements    | —              | 2           | unknown, retained        |
| Delivery / readiness probes | 2              | 0           | readiness only           |
| Pre-model launch failures   | 0              | 0           | none                     |
| Retries / replacements      | 0              | 0           | none                     |

Every slot has exactly one launch record and one judge attempt directory.
`evidence/ATTEMPTS.jsonl` records 40 launches, 40 judge launches, 40 clean slot
completions, 20 pair completions and zero blocked events.

The two unassessed judgments are `cc-A-r1-R02` (slot 9) and `cc-B-r3-R02` (slot
30). Both judge answers stop mid-JSON: A's is missing the final object brace;
B's stops before the closing `]`/`}`. Both originals are preserved; A also has
an `unresolved` deterministic resolution record. They remain unknown, not zero
and not "none".

## Results

| Arm | Planned | Attempted | Completed | Usable | Assessed | Primary P/F | Useful C/U | Transient | Duplicate | Misleading | None | Utility | Interval |
| --- | ------- | --------- | --------- | ------ | -------- | ----------- | ---------- | --------- | --------- | ---------- | ---- | ------- | -------- |
| A   | 20      | 20        | 20        | 20     | 19       | 19/1        | 5/4        | 2         | 2         | 1          | 5    | 29      | 24..34   |
| B   | 20      | 20        | 20        | 20     | 19       | 19/1        | 5/4        | 3         | 3         | 1          | 3    | 26      | 21..31   |

| Case | Arm | Assessed | Useful C/U | Transient | Duplicate | Misleading | None | Primary fail | Utility |
| ---- | --- | -------- | ---------- | --------- | --------- | ---------- | ---- | ------------ | ------- |
| R01  | A   | 5        | 5/0        | 0         | 0         | 0          | 0    | 0            | 25      |
| R01  | B   | 5        | 5/0        | 0         | 0         | 0          | 0    | 0            | 25      |
| R02  | A   | 4/5      | 0/4        | 0         | 0         | 0          | 0    | 0            | 20      |
| R02  | B   | 4/5      | 0/4        | 0         | 0         | 0          | 0    | 0            | 20      |
| R03  | A   | 5        | 0/0        | 2         | 0         | 0          | 3    | 0            | −2      |
| R03  | B   | 5        | 0/0        | 3         | 0         | 0          | 2    | 0            | −3      |
| R04  | A   | 5        | 0/0        | 0         | 2         | 1          | 2    | 1            | −14     |
| R04  | B   | 5        | 0/0        | 0         | 3         | 1          | 1    | 1            | −16     |

R04's seeded note is the dominant negative on both arms; R01 and R02 are equal.
Gate outcomes (separate from utility): A 15 pass / 5 blocked; B 13 pass / 7
blocked. Every blocked gate is a documentation change in R03/R04.

### Actual interleaving

Each pair is adjacent and parity-correct; the times are the first slot's trial
start and the second slot's finish.

| Pair | Order | Start (Z) | End (Z)  |
| ---- | ----- | --------- | -------- |
| P01  | A/B   | 18:20:27  | 18:22:10 |
| P02  | B/A   | 18:22:20  | 18:23:12 |
| P03  | A/B   | 18:23:23  | 18:24:17 |
| P04  | B/A   | 18:24:27  | 18:30:35 |
| P05  | A/B   | 18:30:43  | 18:31:54 |
| P06  | B/A   | 18:32:04  | 18:32:44 |
| P07  | A/B   | 18:32:50  | 18:37:07 |
| P08  | B/A   | 18:37:31  | 18:39:07 |
| P09  | A/B   | 18:39:16  | 18:40:27 |
| P10  | B/A   | 18:40:37  | 18:44:27 |
| P11  | A/B   | 18:44:43  | 18:45:59 |
| P12  | B/A   | 18:46:10  | 18:47:16 |
| P13  | A/B   | 18:47:30  | 18:54:24 |
| P14  | B/A   | 18:54:38  | 18:55:51 |
| P15  | A/B   | 18:56:00  | 18:57:21 |
| P16  | B/A   | 18:57:29  | 18:58:33 |
| P17  | A/B   | 18:58:43  | 18:59:42 |
| P18  | B/A   | 18:59:52  | 19:00:43 |
| P19  | A/B   | 19:00:56  | 19:01:45 |
| P20  | B/A   | 19:01:56  | 19:06:40 |

### Complete pairs and unmatched observations

| Pair | Scenario | A   | B   | B−A | Outcome |
| ---- | -------- | --- | --- | --- | ------- |
| P01  | R01      | 5   | 5   | 0   | tie     |
| P02  | R02      | 5   | 5   | 0   | tie     |
| P03  | R03      | 0   | −1  | −1  | A       |
| P04  | R04      | 0   | −2  | −2  | A       |
| P06  | R03      | 0   | 0   | 0   | tie     |
| P07  | R04      | −2  | −10 | −8  | A       |
| P08  | R01      | 5   | 5   | 0   | tie     |
| P09  | R03      | −1  | −1  | 0   | tie     |
| P10  | R04      | −2  | 0   | +2  | B       |
| P11  | R01      | 5   | 5   | 0   | tie     |
| P12  | R02      | 5   | 5   | 0   | tie     |
| P13  | R04      | −10 | −2  | +8  | B       |
| P14  | R01      | 5   | 5   | 0   | tie     |
| P16  | R03      | −1  | 0   | +1  | B       |
| P17  | R01      | 5   | 5   | 0   | tie     |
| P18  | R02      | 5   | 5   | 0   | tie     |
| P19  | R03      | 0   | −1  | −1  | A       |
| P20  | R04      | 0   | −2  | −2  | A       |

**18 complete pairs: A better 5, B better 3, tied 10; B−A = −3.**

| Unmatched | Present | Missing | Observation        |
| --------- | ------- | ------- | ------------------ |
| P05       | B       | A       | B useful-update +5 |
| P15       | A       | B       | A useful-update +5 |

The two unmatched observations cancel (+5 each), so the all-scored −3 equals
the complete-pair −3. The missing cells are unknown, not zero; no imputation is
made.

### Sensitivity

| Useful | Transient 0.5 | Transient 1 | Transient 2 |
| ------ | ------------- | ----------- | ----------- |
| 3      | A 12 / B 9.5  | A 11 / B 8  | A 9 / B 5   |
| 5      | A 30 / B 27.5 | A 29 / B 26 | A 27 / B 23 |
| 8      | A 57 / B 54.5 | A 56 / B 53 | A 54 / B 50 |

A leads in all nine cells by 2.5–4 points on the assessed population. The grid
describes this sample only; it is not nine experiments and does not repair the
two missing assessments.

## Consultation, route and restraint

- A consulted the lake in 19/20 trials, B in 18/20. All three trials with no
  `docs` call were R03 correct restraint: the stale socket was removed and no
  documentation was written.
- Every documentation change went through the native `add` operation (A 15, B
  17). There were no twin, filesystem-only or unverified recording routes.
- R01: all ten trials created a useful note with the BOM boundary. Representative:
  `ops/csv-bom.md` records only a leading BOM is stripped, later `U+FEFF` is
  preserved, plain UTF-8 passes, and both tests/import pass.
- R02: all ten trials updated the existing note. Representative after text:
  "Since the 2026 database upgrade the proxy no longer terminates TLS, so
  connections must use `sslmode=require`." plus "`sslmode=disable` is obsolete
  and fails with `TLS_REQUIRED`."
- R03: five transient notes across both arms (A 2, B 3) documented a one-off
  stale socket. Five trials correctly wrote nothing (A 3, B 2); three of those
  made no `docs` call at all.
- R04: three trials correctly wrote nothing (A 2, B 1). The rest rewrote or
  extended the seeded note; five were duplicates, two were misleading.

## Adverse outcomes

| Trial                                       | Outcome                  | Decisive behaviour                                                                                                                                                  |
| ------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cc-A-r3-R04`                               | misleading, primary fail | Edited `scripts/lint-migrations.mjs`, then wrote "the linter does not compare their parsed numbers" and "`npm run lint` passes", contradicting the pristine script. |
| `cc-B-r1-R04`                               | misleading, primary fail | Edited the same script, then wrote "The lint now checks that every migration has a numeric label … does not infer order", replacing the seeded mechanism fact.      |
| `cc-A-r1-R04`, `cc-A-r2-R04`                | duplicate                | Rewrote `db/migrations.md` to add explanations that the seeded note already covered or that added no durable fact.                                                  |
| `cc-B-r0-R04`, `cc-B-r3-R04`, `cc-B-r4-R04` | duplicate                | Rewrote or extended the seeded note without a new durable fact.                                                                                                     |
| `cc-A-r3-R03`, `cc-A-r4-R03`                | transient                | Accurate stale-socket note with no future value.                                                                                                                    |
| `cc-B-r0-R03`, `cc-B-r2-R03`, `cc-B-r4-R03` | transient                | Same one-off socket note.                                                                                                                                           |

The two misleading trials are the only primary failures. Both are R04, one per
arm; both edits were inside the visible "only `scripts/` may be edited"
permission, so neither is a permission breach. The R04 task permitted a scripts
change "if a code change is needed"; the pristine check establishes that none
was needed. The defect is the unnecessary change and the resulting false note,
not disobedience of a hidden rule.

Gate preserve blocks: **7** (3 A, 4 B), all R04 rewrites of the seeded note.
None deleted the document. Two of the seven (the misleading pair above)
replaced a true seeded fact with a false one. I report these as gate-blocked
documentation changes and adverse correctness outcomes; I do not convert an
authorised note rewrite into a non-compensable destructive-loss breach without
a semantic preservation verdict. R04 destructive loss is therefore recorded as
an **unresolved guardrail for both arms**, not as a clean pass or a B-specific
breach.

## R02 semantic preservation

The structured judge required four evidence-backed entries for every R02 trial.
Documentation assessment covered **8 of 10** R02 trials (4/5 per arm);
preservation coverage is **8 of 8 assessed** (4/4 per arm). All eight assessed
trials carry the four entries and report `retained / retained / retained` for
the pool size, acquire timeout and startup migrations, and `removed` for the
obsolete TLS claim. Example (`cc-A-r0-R02`): pool "The pool holds at most 10
connections."; timeout "Acquiring a connection waits up to 5 seconds before
failing."; migrations "Migrations run at application startup."; obsolete claim
marked removed, with the quote stating the old `sslmode=disable` claim no longer
appears. Other judges quoted `(absent)` or explained why an explicit "obsolete"
sentence was not a current claim.

The two unassessed R02 documents visibly retain all three facts and remove the
obsolete claim, but their judge answers did not complete; they have no
preservation verdict and remain unknown.

The deterministic `preservationScreen` is a cross-check only. A post-campaign
run of the corrected screen accepts all ten R02 documents. The original screen
rejected `cc-B-r0-R02` as a "startup migrations" contradiction because a
negation in the preceding clause (`sslmode=disable … obsolete`) was applied to
the whole bullet. That false positive is now a regression test that preserves
the full bullet, the evaluated assertion and the matched spans; the judge's
semantic record governs and the screen decided no guardrail.

### R04 preservation: unresolved, symmetric

The frozen instrument assessed R02 semantically and R04 only through the
documentation gate's `preserve` rule. Three A and four B R04 trials modified the
seeded note; two of those (one per arm: `cc-A-r3-R04`, `cc-B-r1-R04`) replaced a
true mechanism fact with a false claim and failed the primary task. The
instrument does not establish whether that is destructive loss of valid
knowledge. It is recorded as an **unresolved guardrail for both arms**, not a
B-specific breach and not a clean pass.

## Delivery and isolation

- Both descriptions were captured byte-exactly in a provider request body at
  readiness: A 415/`c390…`, B 429/`09c9…`, combined 2073/2087, annotation
  payload 1658 in both.
- Every trial records the matching plugin identity: A
  `1b2b0319…`, B `04535cf3…`; every arm was clean and every trial image matched
  `58505eac…`.
- The judge ran in a read-only container with an empty work directory and
  deny-all permissions. The packet builder refused any label leak; all 40
  packets passed. No arm label, hypothesis, prior verdict or aggregate was in a
  packet.
- Per-session delivery is inferred from plugin identity, not captured per
  request. Sessions that never called `docs` remain in the comparison; their
  delivery is not observed behaviourally. This limitation remains.

## Integrity and costs

- `evidence/EVIDENCE.sha256` covers the campaign tree; signing keys are
  excluded by name and never hashed.
- 40 launch records, 40 judge attempts, 40 meta files, no overwritten attempts.
- Token accounting (provider-reported, not billing): trials 615,504 input,
  50,989 output, 92,986 reasoning, 3,793,536 cache read; judges 76,069 input,
  15,597 output, 11,153 reasoning, 1,024 cache read. The two probes used a local
  capture server, so provider accounting is not meaningful. Actual billing is
  unknown.
- Wall time 46m13s; mean trial 58.6s; mean judge process 9.6s (max 39.0s).

## Post-campaign measurement corrections

This is a derived correction. Raw trials, judge outputs, outcomes and utility
weights are unchanged.

- **R02 preservation coverage** was mis-stated as `0/6` with "all six". The data
  has **8 assessed R02 trials, and all 8 carry the four required preservation
  fields** (4/4 per arm). Documentation coverage is 8/10; preservation coverage
  is 8/8 assessed. The "6" was a reporting typo, not two judgements missing
  fields.
- **Missing-data bounds** previously widened every unassessed trial to the full
  task range. The shared scorer now retains a known primary result. Both missing
  R02 trials passed their primary task, so each arm's missing component is
  `−5..+5`, not `−10..+5`. Corrected intervals: A `24..34`, B `21..31`;
  full-population B−A `−13..+7`. The derived analysis module is
  `evidence/measurement/ac-scoring-c7246be.mts` (commit `c7246be`), and the
  pre-correction analysis is preserved as `ANALYSIS-confirmation.pre-bounds-fix.json`.
- **Decision wording** follows structured coverage: the qualification criterion
  is not satisfied because assessment coverage is incomplete; the assessed
  population shows no B advantage. The observed −3 is not a separately
  established failure.
- **R04 destructive loss** is recorded as an unresolved guardrail for both arms,
  symmetrically, because the frozen instrument had no R04 semantic preservation
  assessment.
- **Preservation screen:** it now evaluates independent assertions and records
  the full bullet, evaluated assertion and matched spans on every rejection. The
  exact false-positive B r0 bullet is a regression test; a post-campaign run
  accepts all ten R02 documents.
- **Repository checks after the corrections:** 815/815 tests pass (810 at the
  execution revision plus 5 new), typecheck passes, `defined comply` is
  compliant. No trial or judge evidence was altered.

## Decision and limits

**Incomplete/inconclusive.** The qualification criterion is not satisfied
because assessment coverage is incomplete; the assessed population shows no B
advantage. The design ran all 40 sessions, but 2 required assessments are
unknown, so the frozen criterion ("all 40 trials and required assessments
complete") is not met. The 38-assessment result is A 29 / B 26 (B−A −3;
complete pairs A ahead by 3: 5 A wins, 3 B wins, 10 ties). Missing-data
intervals are A `24..34` and B `21..31`; the full-population B−A interval is
`−13..+7`, so a +5 lead is not excluded by the missing data. The observed −3 is
not a separately established failure. No production recommendation follows.

Guardrail status: B has no mutation-policy breach and no R02 preservation loss
among the eight assessed R02 trials. R04 destructive loss is unresolved for
both arms: each has one misleading rewrite that replaced a true mechanism fact
with a false claim (`cc-A-r3-R04`, `cc-B-r1-R04`), and the frozen instrument did
not assess that guardrail semantically. This is not a clean pass for either arm,
and it is not a B-specific breach.

Remaining limits:

- Five repetitions of each scenario do not estimate variance well and do not
  establish a production failure rate.
- The two truncated judge answers are a judge-output limitation, not a trial
  or fixture defect; they were classified as assessment failures, recorded and
  not retried.
- R04 has no required semantic preservation assessment; the gate's preserve
  block is a duplicate/protection signal, not proof of destructive loss.
- Historical results remain separate context and are not pooled.
