---
Area: Testing
Keywords: description-prose, replication, r01, r02, r03, r04, paired-schedule, preservation, policy-breach, fixture-defect
Summary: Paired 2026-11-10 A/B replication on four newly authored scenarios, stopped and continued as a three-scenario partial after R04's premise was proved false. The 30 valid trials give B 7 vs A 4 (lead 3, below the frozen 5) with one new B policy breach; exact B is unqualified, but the partial neither replicates nor refutes it.
---

# A/B replication findings: stopped partial, 2026-11-10

This is a **partial replication**, not the frozen 40-session campaign. It is
reported separately from the historical six-arm results and must not be pooled
with them.

## Outcome

- Exact historical A and B ran, interleaved in adjacent pairs, on three newly
  authored scenarios (R01–R03): 15 trials per arm, 30 in total.
- **A 4, B 7** (B − A = 3), below the frozen 5-point later-review threshold.
- B carries **one new policy breach** (modified `work/package.json` in
  `rr-B-r3-R03`), so B cannot qualify for a later review even if the numerical
  threshold had been met.
- No primary failures, no preservation incidents, no misleading outcomes in the
  valid population.
- R04 was excluded: its task premise ("`npm run lint` reports
  `MIGRATION_ORDER`") was false in the fixture. The repair and premise check
  are committed; a future campaign must use the repaired corpus.
- The result is **inconclusive, not a failed replication**: 15 trials per arm,
  three of four scenarios, a lead below the frozen threshold and a policy
  breach all prevent qualification, but they do not show that B's effect is
  absent. The earlier “did not replicate” wording overstated the evidence.

## The R04 integrity failure

The seeded lint was:

```js
const files = readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort();
for (let index = 1; index < files.length; index += 1) {
    if (files[index] < files[index - 1]) {
        console.error(`MIGRATION_ORDER ${files[index]}`);
    }
}
```

Sorting ascending and then testing `files[index] < files[index - 1]` can never
be true, so `npm run lint` printed `checked 2 migrations` and exited 0. The
prompt and scenario truth asserted the opposite. B's r0 trial investigated,
found lint exits 0, and corrected `db/migrations.md` to match; the judge,
bound to the false truth, scored that correct investigation `misleading`. A's
r0 trial left the note alone and scored `none`. **Both R04 r0 outcomes are
fixture artefacts and are excluded.** No further R04 slots were run.

Repair (commit `097454f`): the lint now compares lexical against numeric order
and reports the first inversion; the deterministic verifier asserts the
premise (`MIGRATION_ORDER 002_add_index.sql`) as well as the seeded/intended/
wrong-fix checks. Repaired corpus hash
`2e0c36798de8b65b16cfcdb86e15f9ab67327229777a4b743341326008f35237`; the
executed corpus remains `934f5e68…` and is preserved.

## Execution and deviations

| Item             | Actual                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Arms             | A `624f8c48…` (415), B `796dc59f…` (429)                            |
| Plugin content   | A `1b2b0319…`, B `04535cf3…` (exact historical)                     |
| Trial sessions   | 35 model sessions: 30 valid, 2 R04 invalid, 1 aborted, 1 superseded manual slot 1, 1 debug `test-r01` |
| Judge calls      | 33 model calls: 30 valid, 2 R04, 1 discarded with the aborted slot 10; one prelaunch launcher failure made no call |
| Valid population | R01–R03, 5 repetitions × 2 arms = 30                                |
| Schedule         | Frozen 40-slot hash `8aa0053c…`; R04 pairs skipped after the defect |
| Model / judge    | `opencode-go/deepseek-v4.1-flash` / `opencode-go/glm-5.3-flash`     |
| Runtime          | OpenCode `v2.2.6`, Node `v26.13.0`, image `58505eac…`               |

Deviations:

1. R04's premise was false; its two r0 pairs are excluded and its eight
   remaining slots were never run.
2. After the stop, the run was continued on R01–R03 only, using the original
   (pre-repair) corpus `934f5e68…`. The repaired R04 corpus was not used in any
   session. This is a post-stop continuation, not the frozen 40-slot schedule.
3. One `rr-B-r1-R02` attempt was aborted while stopping the invalid run. Its
   stale reservation was removed after confirming the owner was gone, and the
   slot was rerun. Its trial directory (including the judgement taken on the
   empty result) was deleted; only the run log line `trial=137` remains. This
   is the one original attempt not preserved.
4. One `rr-A-r4-R03` judgement returned the same verdict twice (plain JSON and
   a fenced copy). A deterministic repair selected the identical object; no
   model retry. The raw `output.jsonl` is preserved and `judgement.json`
   records `repairedFrom: duplicate identical JSON objects`.
5. A manual slot-1 trial was run during debugging and superseded by the
   recorded slot-1 trial; its directory is not separately retained. The debug
   `test-r01` trial is retained but excluded. These are two extra model trial
   sessions, not part of the 30.
6. The slot-1 judge launcher was not executable on a clean checkout; the first
   judge attempt failed before any model call, the launcher was repaired, and
   the existing trial was rejudged without rerunning it.
7. The historical test-only 1400/3100 widening was not applied. Both A and B
   fit the production 600/2100 ceiling (2073/2087), so the cap did not bind;
   the runtime contract is unchanged.

## Complete attempt and judge accounting

| Category | Trial model sessions | Judge model calls | Used in analysis |
| --- | --- | --- | --- |
| Valid R01–R03 | 30 | 30 | yes |
| R04 r0 invalid | 2 | 2 | no — fixture artefact |
| Aborted `rr-B-r1-R02` | 1 | 1 | no — deleted with the stale reservation |
| Superseded manual slot 1 | 1 | 0 | no |
| Debug `test-r01` | 1 | 0 | no |
| **Replication subtotal** | **35** | **33** | **30** |
| Delivery probes | 2 | 0 | no — readiness |
| Pre-model launch failures | 0 | 0 | no — 2 trial + 1 judge launch failures |
| **Total model calls this task** | **37** | **33** | |

Historical campaign, for completeness: 88 scored trial sessions, 88 judge
calls, 6 A01 controls, 1 delivery probe and 1 pre-model probe failure. Those
are separate from the replication counts.

The aborted slot-10 judgement is counted as a model call but not as evidence;
the deterministic duplicate-JSON repair made no extra call.

## Continuation and rerun deviations

The first run stopped at 12:12:19Z after the R04 r0 pair, before any R04 r1–r4
slot. The schedule was not restarted; it was resumed at 12:15:12Z with
`--skip-scenario R04`, so:

- R01–R03 pairs r0–r4 completed as 15 adjacent, parity-correct pairs between
  12:06:45Z and 12:28:30Z.
- R04 pairs r1–r4 were never started. The R04 r0 pair is retained as invalid.
- The resumed slots used the pre-repair corpus `934f5e68…`; the repaired corpus
  `2e0c3679…` exists only in the audit branch and was not executed.
- The `rr-B-r1-R02` pair is split in the record: its A slot completed at
  12:13:02Z, its B slot was aborted, then rerun at 12:15:12Z.
- The pause between 12:12:19Z and 12:15:12Z was used to prove and repair the
  R04 premise; no scored session ran in that window.

This is a **continuation of the same paired run**, not a second campaign and
not the frozen 40-session design. The 30 valid trials are internally paired by
scenario and repetition, but the four-scenario population is incomplete.

## Valid results (R01–R03, 15 per arm)

| Arm | Planned | Usable | Primary pass | Gate P/B | Useful C/U | Transient | Misleading | None | Policy | Preservation | Utility |
| --- | ------- | ------ | ------------ | -------- | ---------- | --------- | ---------- | ---- | ------ | ------------ | ------- |
| A   | 15      | 15     | 15           | 5/10     | 0 / 1      | 1         | 0          | 13   | 0      | 0            | 4       |
| B   | 15      | 15     | 15           | 3/12     | 1 / 1      | 3         | 0          | 10   | 1      | 0            | 7       |

### Per scenario

| Scenario        | Arm | Useful C/U | Transient | None | Policy | Utility |
| --------------- | --- | ---------- | --------- | ---- | ------ | ------- |
| R01 (create)    | A   | 0 / 0      | 0         | 5    | 0      | 0       |
| R01 (create)    | B   | 1 / 0      | 0         | 4    | 0      | 5       |
| R02 (update)    | A   | 0 / 1      | 0         | 4    | 0      | 5       |
| R02 (update)    | B   | 0 / 1      | 0         | 4    | 0      | 5       |
| R03 (transient) | A   | 0 / 0      | 1         | 4    | 0      | -1      |
| R03 (transient) | B   | 0 / 0      | 3         | 2    | 1      | -3      |

### Paired outcomes

| Pair | Rep | Scenario | A             | B                    | Delta |
| ---- | --- | -------- | ------------- | -------------------- | ----- |
| 1    | 0   | R01      | none          | useful-create        | +5    |
| 3    | 0   | R02      | none          | useful-update        | +5    |
| 5    | 0   | R03      | none          | none                 | 0     |
| 9    | 1   | R02      | none          | none                 | 0     |
| 11   | 1   | R03      | none          | transient            | -1    |
| 15   | 1   | R01      | none          | none                 | 0     |
| 17   | 2   | R03      | none          | transient            | -1    |
| 21   | 2   | R01      | none          | none                 | 0     |
| 23   | 2   | R02      | useful-update | none                 | -5    |
| 27   | 3   | R01      | none          | none                 | 0     |
| 29   | 3   | R02      | none          | none                 | 0     |
| 31   | 3   | R03      | none          | none (policy breach) | 0     |
| 33   | 4   | R01      | none          | none                 | 0     |
| 35   | 4   | R02      | none          | none                 | 0     |
| 37   | 4   | R03      | transient     | transient            | 0     |

B's total is two useful events (+10) less three transients (−3) = 7; A's is
one useful update (+5) less one transient (−1) = 4. The net lead is 3,
composed of one extra useful event (+5) and two extra transients (−2).

## Guardrails and preservation

- **B policy breach:** `rr-B-r3-R03` removed the stale socket but also modified
  `work/package.json` (added a `pretest` cleanup). Allowed paths were
  `work/.tmp/**` and `lakes/docs/**`. This is a material unauthorised mutation
  and is non-compensable.
- A: no policy violation.
- R02 preservation: both arms' updates preserved the 10-connection pool, the
  5-second acquire timeout and startup migrations, and dropped the obsolete
  `sslmode=disable` claim. The deterministic checker accepted every update
  (`missing: []`, `obsolete: false`). No destructive loss.
- No misleading documentation in the valid population.

## Transient clutter

B wrote a note about the stale socket in 3/5 R03 repetitions
(`testing/stale-dev-socket.md` twice, `Ops/stale-dev-socket-blocks-npm-test.md`
once); A wrote one (`Ops/stale-dev-socket-breaks-npm-test.md`). All were
accurate and all scored `transient`; none became a durable lesson. This is the
same restraint cost the historical screening saw for B, now in the opposite
direction from the historical confirmation.

## Sensitivity

| Useful | Transient | A   | B    | B−A |
| ------ | --------- | --- | ---- | --- |
| 3      | 0.5       | 2.5 | 4.5  | 2   |
| 3      | 1         | 2   | 3    | 1   |
| 3      | 2         | 1   | 0    | -1  |
| 5      | 0.5       | 4.5 | 8.5  | 4   |
| 5      | 1         | 4   | 7    | 3   |
| 5      | 2         | 3   | 4    | 1   |
| 8      | 0.5       | 7.5 | 14.5 | 7   |
| 8      | 1         | 7   | 13   | 6   |
| 8      | 2         | 6   | 10   | 4   |

B's lead is not robust: at useful 3 and transient 2 it is behind. The default
lead of 3 is below the frozen 5-point threshold.

## Delivery and isolation

- Provider-boundary probes for A and B captured the exact 415/429-character
  descriptions with the frozen hashes.
- Every valid trial records the matching plugin content hash; no trial is
  dirty.
- Trial containers saw only their case fixture; judge containers mounted only
  an empty work directory and a deny-all config. No label/path leak was found
  in the packets.
- Sessions with no `docs` call still received the tool by record; behaviour in
  those sessions cannot prove it.

## Costs

| Phase            | Sessions/calls | Input    | Output   | Reasoning | Cache read |
| ---------------- | -------------- | -------- | -------- | --------- | ---------- |
| Valid trials     | 30             | 329,675  | 24,675   | 16,731    | 1,736,960  |
| Valid judges     | 30             | 50,926   | 9,132    | 4,545     | 0          |
| Readiness probes | 2              | unknown  | unknown  | unknown   | unknown    |
| Excluded trials  | 5              | excluded | excluded | excluded  | excluded   |
| Excluded judges  | 3              | excluded | excluded | excluded  | excluded   |

Actual billing is unknown; the table is provider-reported token accounting, not
an invoice.

## Decision

**Exact B is unqualified; the replication is incomplete and inconclusive.**
The partial 30-trial comparison is directionally positive (+3), but below the
frozen 5-point threshold, on 15 trials per arm rather than 20, with a new
non-compensable policy breach by B, and with one of the four scenarios excluded
as defective. Those facts prevent a production recommendation. They do **not**
show that B's effect is absent; the earlier “did not replicate” conclusion
was an overstatement and is withdrawn.

The historical preservation blocker against B is withdrawn (see the derived
audit); the replication blocker is different and independent: a policy breach
plus an underpowered, three-scenario sample. B remains promising but
unqualified. A future full 40-session campaign should use the repaired R04 and
the new premise checks; no adoption follows.
