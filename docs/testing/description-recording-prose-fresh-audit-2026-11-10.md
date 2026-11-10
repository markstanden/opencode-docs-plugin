---
Area: Testing
Keywords: description-prose, audit, preservation, partial-fix, derived-analysis, h02, note-02, six-arm
Summary: Derived audit of the 2026-11-10 six-arm native-description campaign. The recorded totals reconcile exactly; the claimed finalist preservation breach rests on fixture facts the H02 code does not contain, and the control's NOTE-02 half-fix is inconsistent with the other arms under the campaign's own omission rule.
---

# Six-arm prose campaign: derived audit, 2026-11-10

This is a **derived layer**, not a rewrite. The original 88 judgements, the
frozen plan, the executed measurement and the published totals remain as
recorded. Nothing here claims the original sessions ran repaired code.

## Authorities and identity

| Item | Value |
| --- | --- |
| Base | `5ea4a71e9174d638145e16c7f9508357c47542fc` |
| Executed measurement | `902a6fe65ecff4cfea0358ae165e21e4f441f003` |
| Frozen plan | `c69b1000713dddd3dfadd5de92196b0a44d296d8` |
| Gate repair (not executed) | `731fbf8f99d1e18107d12b664c084c43f12d564a` |
| Original findings | `3c2e6462531867c51a2e1c82b2a59df0fbde9002` |
| Close-out PR / merge | #48, `05cf77812835cc0645ae43e5468d1592e539d10d` |
| Audit worktree | `05cf778` (isolated; no merge) |
| Evidence root | `/home/mark/tmp/docs-desc-fresh-20261110/` |

The exact A and B description bytes were re-extracted from the arm plugins'
registered `docs` description, not from a rendered report:
A 415 characters `c3903c7d…1c7c`, B 429 characters `09c9cebd…0d4e`.

## Integrity

- 4,747 manifest rows verify; 94 signing-key files are explicitly excluded
  from hashing; no hashed measurement input is missing.
- Three report-tooling files (`build-packet.mjs`, `build-review-packet.mjs`,
  `pr-body.md`) were edited after the manifest was written (10:49/10:57 vs
  10:48) and were not re-hashed. They do not feed the scoring analyses.
- `ANALYSIS-screening.json` and `ANALYSIS-confirmation.json` differ from their
  `.pre-repair.json` companions only in `frozenAt`; the scoring content is
  identical. The PR's "identical before and after the repair" claim is
  substantively correct.
- All 88 result directories are present; every trial has a first-attempt
  `judged` record. No model retry is recorded.

## Counting reconciliation

Recomputed from `ANALYSIS-*.json`, weights and the independent primary result.
Every published arm total, denominator, outcome count and utility contribution
reconciles exactly. No trial changed more than one knowledge document, so the
"one documentation contribution per trial" rule was not evaded by extra notes.

### Screening (8 trials per arm) — original, unchanged

| Arm | Total | Primary P/F | Gate P/B | Useful C/U | Transient | Dup | Misleading | None | Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 9 | 7/1 | 6/2 | 1 / 2 | 1 | 0 | 0 | 4 | 0 |
| B | 15 | 8/0 | 7/1 | 1 / 2 | 0 | 0 | 0 | 5 | 0 |
| C | -1 | 7/1 | 4/4 | 1 / 0 | 1 | 0 | 0 | 6 | 0 |
| D | -1 | 7/1 | 6/2 | 1 / 1 | 1 | 0 | 1 | 4 | 0 |
| E | -2 | 7/1 | 4/4 | 1 / 1 | 2 | 0 | 1 | 3 | 0 |
| F | 4 | 7/1 | 5/3 | 2 / 1 | 1 | 0 | 1 | 3 | 1 |

### Confirmation (20 trials per arm) — original, unchanged

| Arm | Total | Primary P/F | Gate P/B | Useful C/U | Transient | Dup | Misleading | None | Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | -11 | 19/1 | 7/13 | 1 / 0 | 1 | 0 | 2 | 16 | 1 |
| B | 12 | 20/0 | 9/11 | 3 / 1 | 3 | 0 | 1 | 12 | 0 |

Policy violations stand as recorded, separately from utility: F screening
edited `work/README.md`; A confirmation edited `work/scripts/format-check.mjs`.

## Preservation: all 88 trials

No knowledge-lake document was deleted in any of the 88 trials, and every
`preserve` path held. Two scenarios had a replace target:

- **NOTE-02** — ten replacements. All ten retain the three required surviving
  facts (use nvm, setup enforcement, CI reads `.nvmrc`). Four retain the
  superseded Node 22 floor as current; that is a correctness failure below,
  not a deletion.
- **H02** — four replacements. The correction layer treated the seeded
  "entries expire after 60 seconds" and "a deploy clears the whole cache"
  claims as facts that had to survive. The fixture does not support that:
  `src/cache.ts` is a plain `Map` with `get`, `put`, `clear` and no TTL, and
  the fixture README/tests mention neither expiry nor deploy. The "60-second"
  claim is contradicted by the code; the deploy claim is unverifiable.

**Consequence.** Deleting those claims is not destructive loss of valid
content. The claimed finalist preservation breach (`fc-F-r2-H02`) is
**withdrawn as unsupported by fixture truth**. The same correction also means
the two control trials penalised for the deletion (`fc-A-r2-H02`,
`fc-A-r3-H02`) were penalised for a correct correction. `fc-F-r0-H02` kept both
claims; because the scenario truth itself asserted them, that retention is
recorded as a fixture-truth defect, not separately punished.

The scenario's `expectedDocs.retains: ["60","deploy"]` is therefore a measured
defect, not a valid guardrail. No preservation breach is proved in any arm.
The separate policy violations above are unaffected.

## Documentation correctness: one partial-fix rule

The campaign's own frozen `expectedDocs` for NOTE-02 requires the update to
retain `nvm`/`CI` and to omit `Node 22`. Applying that rule uniformly to the
Summary and Facts of every NOTE-02 replacement:

| Trial | Structure | Original | Derived |
| --- | --- | --- | --- |
| `fr-A-s1-NOTE-02` | Node 24 pin, but "engines/setup accept Node 22 or newer" | useful-update | **misleading** |
| `fr-D-s1-NOTE-02` | "Node 22 is the minimum supported version" + open question | misleading | misleading |
| `fr-E-s2-NOTE-02` | "floor 22" / "required is 22" + open question | misleading | misleading |
| `fr-F-s1-NOTE-02` | "engines >=22 is the supported floor" | misleading | misleading |
| `fr-A-s2`, `B-s1`, `B-s2`, `D-s2`, `E-s1`, `F-s2` | completed Node 24 contract | useful-update | useful-update |

The control's judge called the 22 floor "factually accurate to the observed
code" and kept it useful; the D/E/F judges treated the same shape as
misleading against the scenario truth. The uniform rule resolves the conflict
towards the campaign's own omission requirement and the repository's README
("targets Node 24 or newer"), not towards the control's original score. This
lowers A; it does not raise D/E/F.

For H02, the four replacements all correct the material key-shape claim and
remove the obsolete "globally unique" premise. With the unsupported retention
requirement removed, all four are `useful-update`. No new LLM calls were made;
the original assessments are reused because the correction is a deterministic
application of the frozen omission/retention contract plus fixture code.

### Every transition (4)

| Trial | Stage | Scenario | Original | Derived | Why |
| --- | --- | --- | --- | --- | --- |
| `fr-A-s1-NOTE-02` | screening | NOTE-02 | useful-update (+5) | misleading (-5) | retains the superseded 22 floor as current |
| `fc-A-r2-H02` | confirmation | H02 | misleading (-5) | useful-update (+5) | correct key correction; deleted a false expiry claim |
| `fc-A-r3-H02` | confirmation | H02 | misleading (-5) | useful-update (+5) | correct key correction; accurately says no expiry logic |
| `fc-F-r2-H02` | confirmation | H02 | misleading (-5) | useful-update (+5) | correct key correction; unsupported claims not required |

## Derived tables

| Stage | A | B | B − A | Note |
| --- | --- | --- | --- | --- |
| Screening (8/arm) | -1 | 15 | 16 | A's NOTE-02 half-fix reclassified |
| Confirmation (20/arm) | 9 | 22 | 13 | H02 corrections counted on the key fact |
| Confirmation, H02 excluded | -1 | 12 | 13 | 10 defective-truth trials omitted, not zeroed |

The last row is the missing-data treatment: the same 13-point lead survives
excluding every H02 trial. B has no proved guardrail breach; A has one policy
breach in confirmation and F one in screening.

Sensitivity (derived layer, useful weight 3/5/8 × transient penalty
0.5/1/2): B ranks first in all nine cells in both stages. At the default
(5/−1), screening is 15 vs −1 and confirmation 22 vs 9.

## Delivery evidence

- Historical: one provider-boundary capture exists for arm F (1343 characters,
  hash `8223b356…`); it proves the longest historical description reached the
  request body byte-exactly. There is **no** per-session provider capture for
  historical A/B.
- Each historical trial records the arm's plugin content hash (A `1b2b0319…`,
  B `04535cf3…`), matching the frozen asset; the registry was verified by
  importing each plugin. That is registration evidence, not per-session
  delivery.
- Sessions with no `docs` call: A 10/28 (0 screening, 10 confirmation),
  B 7/28 (2 screening, 5 confirmation). For those, delivery is inferred from
  the shared payload path and the recorded plugin identity, not observed
  behaviour. This remains a gap.
- Readiness for the replication closed that gap for A and B: real provider
  request bodies captured the `docs` tool at 415/429 characters with the exact
  frozen hashes.

## Execution order

- Screening ran exactly in frozen slot order 1–48 (08:15:39–08:54:43Z);
  time order equals slot order.
- Confirmation did not. All 20 control slots ran first
  (08:55:58–09:08:01Z), then all 20 finalist slots
  (09:09:02–09:21:14Z). The frozen pair alternation was not achieved. The
  cause is recorded in `logs/confirmation-defect.log`: the runner resolved the
  finalist arm as `arms/B` (uppercase) and exited 127 before any model call;
  the finalist slots were resumed after the control block. The run is
  exploratory under that deviation.

## Derived conclusion

The original numerical totals are arithmetically sound, but two semantic
layers were wrong: the H02 preservation premise and the NOTE-02 half-fix
classification. Corrected, B still leads screening (16) and confirmation (13),
but the historical confirmation is non-interleaved and its scenario truth was
defective, so it is not confirmatory. The claimed preservation breach against
B is withdrawn; A's and F's policy violations remain real. A fresh, correctly
interleaved replication on newly authored scenarios is the only basis for a
later review.
