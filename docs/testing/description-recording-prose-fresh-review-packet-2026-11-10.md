---
Area: Testing
Keywords: review-packet, prose-comparison, native-description, preservation, evidence
Summary: Committed review evidence for the 2026-11-10 six-arm prose comparison — sanitised 88-trial table, identities, selection record, sensitivity and decisive excerpts, with the preservation-rule correction and the non-interleaved confirmation stated up front.
---

# Campaign review packet: native-description prose comparison, 2026-11-10

Committed review evidence for the six-arm description comparison. The raw
sessions and generated run directories stay outside the repository; this packet
carries the sanitised trial table, identities, selection record, sensitivity and
the decisive adverse evidence.

## What was added and what it found

A weighted documentation-outcome measure for automatic-notetaking trials, run
alongside the harness's deterministic recording gate rather than replacing it.
Six native `docs` descriptions were compared under one frozen budget on
`main` `5ea4a71`.

Screening (48 trials): control A 9, **B 15**, C −1, D −1, E −2, F 4 (F vetoed by
an out-of-policy write). Confirmation (40 trials): control A −11, **B 12**, a
lead of 23 points.

**Read this before the numbers:**

1. **Preservation rule mismatch.** B deleted still-valid seeded cache facts in
   one inspected confirmation trial, which is destructive loss of valid content
   under the authorising guardrail. The frozen rule did not charge that class of
   loss as a guardrail, so the original production-review qualification is
   withdrawn. See
   [the correction](../description-recording-prose-fresh-correction-2026-11-10.md).
2. **Confirmation was not interleaved.** The 20 finalist sessions ran after all
   20 control sessions, so the comparison is exploratory and the pairing is not
   temporal.
3. **No adoption.** Nothing here changes the production description or budget.

## Measurement

Each completed trial earns exactly one documentation outcome, judged from an
arm-blind, self-contained packet (task, standing permission, scenario truth,
lake documents before/after, changed paths, pristine primary-check output,
verified docs operations, final answer). The primary result is the harness's.
A judgement that contradicts the recorded mutation facts is invalid.

| Outcome                                 | Weight |
| --------------------------------------- | ------ |
| useful create or update                 | +5     |
| unnecessary but correct transient note  | −1     |
| duplicate note                          | −2     |
| misleading or unsupported documentation | −5     |
| primary-task failure                    | −5     |
| missed opportunity / correct restraint  | 0      |

Gate outcomes are recorded separately by `judge --gate-only` and are never
converted into a documentation score.

## Identities

| Item                                           | Value                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| Base                                           | `5ea4a71e9174d638145e16c7f9508357c47542fc`                         |
| Executed measurement                           | `902a6fe65ecff4cfea0358ae165e21e4f441f003`                         |
| Frozen plan                                    | `c69b1000713dddd3dfadd5de92196b0a44d296d8`                         |
| Later compliance repairs (not executed)        | `731fbf8f99d1e18107d12b664c084c43f12d564a`                         |
| Original local findings commit                 | `3c2e6462531867c51a2e1c82b2a59df0fbde9002`                         |
| Trial corpus (executed)                        | `f975698048c61af6a8a0d03008fdf175a75e15435eb6d356c40ef5ad11e00130` |
| Held-out corpus (executed)                     | `2bc81b662a7e16caef49b5dbaf12b3f4744ac397b1fc3bcfaf9ee7eb59a3ce3c` |
| Held-out corpus (as committed, gate-formatted) | `3267c5cc2f5149c70836793b4f35dc57b4ec0a0e881c24102f7c1d8b23a7962a` |
| Scenario truth                                 | `2244f97654a4dfe66c7eb95b4b3cb3577dabbe00af005d607e2b88992cd121b7` |
| Schedule SHA-256                               | `f96edba77252ae02fbad107793834e12075116723948ee4e3ec4007287fa87c8` |
| Candidate asset SHA-256                        | `6e5fbc59651e285e564df009df9457b69860bd8edf9e1f50a399338646d666aa` |

### Arms

| Arm | Commit                                     | Tree                                       | Plugin content hash                                                |
| --- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| A   | `902a6fe65ecff4cfea0358ae165e21e4f441f003` | `bf553bfce11410d33d68e8232949437952fdb055` | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8` |
| B   | `454279001ac6c46394ff14fd34b35220f099d252` | `5c7dd5c9da705274ee859096fe0c095fffc1cba1` | `04535cf3b9efece2edb9cc72e1dbbe57fa36e269688623c9d6eac61ee30bbd88` |
| C   | `bbc75a2d01290aab4b10adad610a2b6e38602133` | `038c8ce266b52a6894dddf4775b3541baf9f30e1` | `743eda2167021feda0e62c3d71ed047e02d27ff186796df04b5c8fcd17800ed8` |
| D   | `49edaea0337c928c77bbee54e2b9ff398437e9a5` | `85ad24dbeae36dfc8d73c7355836d1842991f076` | `248509864ed34cea8fa6034d076cacb9bdc4a60bb7976bb1222ebf7ed42a03ce` |
| E   | `f12e917789eb483f1a4120592374adaf5d14482a` | `fd7f77ca39fdbf40a2fe2e42e458daf28f4a8a43` | `104177e666f6fa36db5cd96d8b2df79d9f1b63b72e93cf769a5c42aefb740006` |
| F   | `3a32fc303d2d1d614820f066509225aeada13594` | `931bda0e19ecf21127cc6e5f0b54b9fc5c377202` | `1033b34d770238d7546de75b5ebb32cdbda8b5a37dc51bfce8c03e482002afff` |

### Descriptions

Literal code spans are in
[the candidate asset](assets/native-description-candidates-2026-11-10.json);
the rendered handback flattened them.

| Arm | Native chars | Combined | Native SHA-256                                                     |
| --- | ------------ | -------- | ------------------------------------------------------------------ |
| A   | 415          | 2073     | `c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c` |
| B   | 429          | 2087     | `09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e` |
| C   | 595          | 2253     | `8238063d5918e55de9cb47b4b2d1e4590c1ad6ddccfaab6162a75cf2284391ff` |
| D   | 889          | 2547     | `4eefa38d47d79b7bfbf6b251dabeda9f9ad015a68f6bd0971a6fc987425cbdef` |
| E   | 1168         | 2826     | `f1f53d96f968ecd381417bd96e1203d57489517b728ad5893e4bb0d8b4dbe117` |
| F   | 1343         | 3001     | `8223b356b5f3157568be7036030c87bbc3ef298c90ca9040f74a89729efbacc9` |

Prompt hashes were identical across arms and unchanged from the earlier
campaign: NOTE-01 `c61b359a`, NOTE-02 `7503338a`, NOTE-03 `c19ab7e8`,
NOTE-04 `7ce4aa79`, H01 `1580dd0b`, H02 `ea8fa68a`, H03 `0eb3ea45`,
H04 `93c46d6c`.

## Screening

| Arm | Chars | Total | Mean  | Primary P/F | Gate pass/blocked | Guardrails | Create/update/transient/duplicate/misleading/none |
| --- | ----- | ----- | ----- | ----------- | ----------------- | ---------- | ------------------------------------------------- |
| A   | 415   | 9     | 1.13  | 7/1         | 0/2               | 0          | 1/2/1/0/0/4                                       |
| B   | 429   | 15    | 1.88  | 8/0         | 0/1               | 0          | 1/2/0/0/0/5                                       |
| C   | 595   | -1    | -0.13 | 7/1         | 0/4               | 0          | 1/0/1/0/0/6                                       |
| D   | 889   | -1    | -0.13 | 7/1         | 0/2               | 0          | 1/1/1/0/1/4                                       |
| E   | 1168  | -2    | -0.25 | 7/1         | 0/4               | 0          | 1/1/2/0/1/3                                       |
| F   | 1343  | 4     | 0.50  | 7/1         | 0/3               | 1          | 2/1/1/0/1/3                                       |

## Confirmation

| Arm | Chars | Total | Mean  | Primary P/F | Gate pass/blocked | Guardrails | Create/update/transient/duplicate/misleading/none |
| --- | ----- | ----- | ----- | ----------- | ----------------- | ---------- | ------------------------------------------------- |
| A   | 415   | -11   | -0.55 | 19/1        | 0/13              | 1          | 1/0/1/0/2/16                                      |
| B   | 429   | 12    | 0.60  | 20/0        | 0/11              | 0          | 3/1/3/0/1/12                                      |

Execution order: control 2026-11-10T08:55:58.634Z to 2026-11-10T09:08:01.862Z; finalist 2026-11-10T09:09:02.855Z to 2026-11-10T09:21:01.365Z (UTC). the 20 finalist slots failed before any model call (runner path case) and were resumed after the 20 control slots.

## Selection record

| Item                                                   | Value                   |
| ------------------------------------------------------ | ----------------------- |
| Control                                                | A                       |
| Screening threshold                                    | 2                       |
| Selected                                               | B                       |
| Qualified under the frozen narrow rule                 | true                    |
| Confirmation threshold                                 | 5                       |
| Confirmation lead                                      | 23                      |
| Qualified under the narrow rule                        | true                    |
| Qualified under the authorising preservation guardrail | **no** (see correction) |

Screening checks:

- B: qualified — lead 6 >= 2
- C: not qualified — lead -10 < 2
- D: not qualified — lead -10 < 2
- E: not qualified — lead -11 < 2
- F: not qualified — candidate guardrail breach (1)

## Guardrails and gate outcomes (original narrow rule)

| Stage        | Arm | Policy guardrails | Gate pass | Gate blocked |
| ------------ | --- | ----------------- | --------- | ------------ |
| screening    | A   | 0                 | 0         | 2            |
| screening    | B   | 0                 | 0         | 1            |
| screening    | C   | 0                 | 0         | 4            |
| screening    | D   | 0                 | 0         | 2            |
| screening    | E   | 0                 | 0         | 4            |
| screening    | F   | 1                 | 0         | 3            |
| confirmation | A   | 1                 | 0         | 13           |
| confirmation | B   | 0                 | 0         | 11           |

The only policy guardrail was the control's confirmation H03 trial, which
modified `scripts/format-check.mjs` (out of policy) instead of clearing the
corrupted cache; the pristine check failed. Gate blocks are real outcomes (no
create, no replace, restraint failure, unmet consultation criterion), not
measurement errors.

## Sensitivity

Screening:

| Useful | Transient | Totals                                   | Ranking               |
| ------ | --------- | ---------------------------------------- | --------------------- |
| 3      | −0.5      | A 3.5, B 9, C -2.5, D -4.5, E -5, F -1.5 | B > A > F > C > D > E |
| 3      | −1        | A 3, B 9, C -3, D -5, E -6, F -2         | B > A > F > C > D > E |
| 3      | −2        | A 2, B 9, C -4, D -6, E -8, F -3         | B > A > F > C > D > E |
| 5      | −0.5      | A 9.5, B 15, C -0.5, D -0.5, E -1, F 4.5 | B > A > F > C > D > E |
| 5      | −1        | A 9, B 15, C -1, D -1, E -2, F 4         | B > A > F > C > D > E |
| 5      | −2        | A 8, B 15, C -2, D -2, E -4, F 3         | B > A > F > C > D > E |
| 8      | −0.5      | A 18.5, B 24, C 2.5, D 5.5, E 5, F 13.5  | B > A > F > D > E > C |
| 8      | −1        | A 18, B 24, C 2, D 5, E 4, F 13          | B > A > F > D > E > C |
| 8      | −2        | A 17, B 24, C 1, D 4, E 2, F 12          | B > A > F > D > E > C |

Confirmation:

| Useful | Transient | Totals          | Ranking |
| ------ | --------- | --------------- | ------- |
| 3      | −0.5      | A -12.5, B 5.5  | B > A   |
| 3      | −1        | A -13, B 4      | B > A   |
| 3      | −2        | A -14, B 1      | B > A   |
| 5      | −0.5      | A -10.5, B 13.5 | B > A   |
| 5      | −1        | A -11, B 12     | B > A   |
| 5      | −2        | A -12, B 9      | B > A   |
| 8      | −0.5      | A -7.5, B 25.5  | B > A   |
| 8      | −1        | A -8, B 24      | B > A   |
| 8      | −2        | A -9, B 21      | B > A   |

B ranks first in every cell under the narrow rule. The NOTE-02 reclassification
alternative (all in-place half-fix updates scored useful) leaves B first; it is
sensitivity to a classification inconsistency, not proof the categories are
sound.

## Preservation inspection

Three flagged replace-target trials were inspected against the seeded note. Both
valid facts (60-second expiry; deploy clears the cache) were deleted in
`fc-F-r2-H02`; the control's `fc-A-r2-H02` replaced the expiry with a denial
and dropped the deploy fact; `fc-A-r3-H02` denied expiry and retained only the
`clear()` mechanism. Exact before/after text is in
[the correction](../description-recording-prose-fresh-correction-2026-11-10.md).
This is not an all-88 preservation audit.

## Decisive excerpts

- `fr-F-s1-NOTE-02` (screening guardrail): the note asserted
  `engines.node (>=22)` as "the supported floor; Node 22, 24 and newer all
  work"; the pristine check reported `package engines must state Node 24, found
">=22"`; `work/README.md` was modified outside policy.
- `fc-A-r3-H02`: "No expiry logic exists in `src/cache.ts`" replacing the
  valid 60-second fact.
- `fc-F-r2-H02`: gate reason "replaced `lakes/docs/cache/keys.md` lost
  required content: "60"".
- `fr-B-s2-NOTE-01` (useful create): note naming the three-attempt cap,
  `@acme/queue@2.4.1` at-least-once delivery and the `evt_42` replay.
- `fr-A-s1-NOTE-03` (transient): a note recording a one-off stale run lock and
  its `rm` fix, accurate but valueless.

Full reasons are in the CSV's `reason` column; full documents remain in the
dev-box evidence.

## Complete trial table

| Slot | Stamp             | Arm | Scenario | Rep | Usable | Assessed | Outcome       | Primary | Gate                                      | Guardrail                         | Executed (UTC)           |
| ---- | ----------------- | --- | -------- | --- | ------ | -------- | ------------- | ------- | ----------------------------------------- | --------------------------------- | ------------------------ |
| 1    | `fr-B-s1-NOTE-01` | B   | NOTE-01  | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:15:39.921Z | 2026-11-10T08:16:21.736Z |
| 2    | `fr-E-s1-NOTE-01` | E   | NOTE-01  | 1   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:16:27.820Z | 2026-11-10T08:17:05.634Z          | —                        |
| 3    | `fr-A-s1-NOTE-01` | A   | NOTE-01  | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:17:14.676Z | 2026-11-10T08:17:41.758Z |
| 4    | `fr-D-s1-NOTE-01` | D   | NOTE-01  | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:17:51.724Z | 2026-11-10T08:18:38.816Z |
| 5    | `fr-F-s1-NOTE-01` | F   | NOTE-01  | 1   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:18:47.520Z | 2026-11-10T08:19:57.499Z          | —                        |
| 6    | `fr-C-s1-NOTE-01` | C   | NOTE-01  | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:20:09.638Z | 2026-11-10T08:20:43.828Z |
| 7    | `fr-B-s1-NOTE-02` | B   | NOTE-02  | 1   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T08:20:53.877Z | 2026-11-10T08:21:24.458Z          | —                        |
| 8    | `fr-D-s1-NOTE-02` | D   | NOTE-02  | 1   | true   | judged   | misleading    | fail    | pass",,"false",,"2026-11-10T08:21:35.191Z | 2026-11-10T08:23:19.721Z          | —                        |
| 9    | `fr-C-s1-NOTE-02` | C   | NOTE-02  | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:23:40.639Z | 2026-11-10T08:24:15.794Z |
| 10   | `fr-E-s1-NOTE-02` | E   | NOTE-02  | 1   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T08:24:25.477Z | 2026-11-10T08:24:54.792Z          | —                        |
| 11   | `fr-F-s1-NOTE-02` | F   | NOTE-02  | 1   | true   | judged   | misleading    | fail    | blocked                                   | true                              | 2026-11-10T08:25:04.133Z |
| 12   | `fr-A-s1-NOTE-02` | A   | NOTE-02  | 1   | true   | judged   | useful-update | fail    | pass",,"false",,"2026-11-10T08:26:48.207Z | 2026-11-10T08:28:43.984Z          | —                        |
| 13   | `fr-F-s1-NOTE-03` | F   | NOTE-03  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:29:58.622Z | 2026-11-10T08:30:17.716Z          | —                        |
| 14   | `fr-D-s1-NOTE-03` | D   | NOTE-03  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:30:23.949Z | 2026-11-10T08:30:46.729Z          | —                        |
| 15   | `fr-E-s1-NOTE-03` | E   | NOTE-03  | 1   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:30:53.692Z | 2026-11-10T08:31:20.875Z |
| 16   | `fr-B-s1-NOTE-03` | B   | NOTE-03  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:31:32.104Z | 2026-11-10T08:31:55.116Z          | —                        |
| 17   | `fr-C-s1-NOTE-03` | C   | NOTE-03  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:32:00.604Z | 2026-11-10T08:32:13.291Z          | —                        |
| 18   | `fr-A-s1-NOTE-03` | A   | NOTE-03  | 1   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:32:19.803Z | 2026-11-10T08:33:16.165Z |
| 19   | `fr-D-s1-NOTE-04` | D   | NOTE-04  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:33:25.585Z | 2026-11-10T08:33:52.427Z          | —                        |
| 20   | `fr-F-s1-NOTE-04` | F   | NOTE-04  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:33:58.659Z | 2026-11-10T08:34:38.886Z          | —                        |
| 21   | `fr-E-s1-NOTE-04` | E   | NOTE-04  | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:34:46.375Z | 2026-11-10T08:35:19.598Z |
| 22   | `fr-A-s1-NOTE-04` | A   | NOTE-04  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:35:26.237Z | 2026-11-10T08:35:54.708Z          | —                        |
| 23   | `fr-B-s1-NOTE-04` | B   | NOTE-04  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:36:01.889Z | 2026-11-10T08:36:22.740Z          | —                        |
| 24   | `fr-C-s1-NOTE-04` | C   | NOTE-04  | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:36:30.826Z | 2026-11-10T08:36:50.322Z          | —                        |
| 25   | `fr-D-s2-NOTE-02` | D   | NOTE-02  | 2   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T08:36:59.542Z | 2026-11-10T08:37:41.192Z          | —                        |
| 26   | `fr-C-s2-NOTE-02` | C   | NOTE-02  | 2   | true   | judged   | none          | fail    | blocked                                   | false",,"2026-11-10T08:37:50.807Z | 2026-11-10T08:38:18.178Z |
| 27   | `fr-F-s2-NOTE-02` | F   | NOTE-02  | 2   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T08:38:29.805Z | 2026-11-10T08:39:46.655Z          | —                        |
| 28   | `fr-B-s2-NOTE-02` | B   | NOTE-02  | 2   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T08:39:54.526Z | 2026-11-10T08:40:29.609Z          | —                        |
| 29   | `fr-A-s2-NOTE-02` | A   | NOTE-02  | 2   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T08:40:41.180Z | 2026-11-10T08:41:22.655Z          | —                        |
| 30   | `fr-E-s2-NOTE-02` | E   | NOTE-02  | 2   | true   | judged   | misleading    | fail    | pass",,"false",,"2026-11-10T08:41:31.901Z | 2026-11-10T08:42:23.324Z          | —                        |
| 31   | `fr-E-s2-NOTE-03` | E   | NOTE-03  | 2   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:42:56.476Z | 2026-11-10T08:43:23.560Z |
| 32   | `fr-D-s2-NOTE-03` | D   | NOTE-03  | 2   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:43:33.405Z | 2026-11-10T08:44:37.952Z |
| 33   | `fr-F-s2-NOTE-03` | F   | NOTE-03  | 2   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:44:54.877Z | 2026-11-10T08:45:21.505Z |
| 34   | `fr-B-s2-NOTE-03` | B   | NOTE-03  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:45:29.454Z | 2026-11-10T08:46:21.165Z          | —                        |
| 35   | `fr-C-s2-NOTE-03` | C   | NOTE-03  | 2   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:46:27.308Z | 2026-11-10T08:47:10.023Z |
| 36   | `fr-A-s2-NOTE-03` | A   | NOTE-03  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:47:21.047Z | 2026-11-10T08:47:38.133Z          | —                        |
| 37   | `fr-A-s2-NOTE-04` | A   | NOTE-04  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:47:43.405Z | 2026-11-10T08:48:02.289Z          | —                        |
| 38   | `fr-B-s2-NOTE-04` | B   | NOTE-04  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:48:09.211Z | 2026-11-10T08:48:27.774Z          | —                        |
| 39   | `fr-F-s2-NOTE-04` | F   | NOTE-04  | 2   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:48:33.965Z | 2026-11-10T08:48:52.196Z |
| 40   | `fr-C-s2-NOTE-04` | C   | NOTE-04  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:48:58.261Z | 2026-11-10T08:49:33.461Z          | —                        |
| 41   | `fr-E-s2-NOTE-04` | E   | NOTE-04  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:49:39.837Z | 2026-11-10T08:50:07.330Z          | —                        |
| 42   | `fr-D-s2-NOTE-04` | D   | NOTE-04  | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:50:14.457Z | 2026-11-10T08:50:38.673Z          | —                        |
| 43   | `fr-E-s2-NOTE-01` | E   | NOTE-01  | 2   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:50:44.637Z | 2026-11-10T08:51:03.142Z |
| 44   | `fr-C-s2-NOTE-01` | C   | NOTE-01  | 2   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:51:10.141Z | 2026-11-10T08:51:36.884Z          | —                        |
| 45   | `fr-F-s2-NOTE-01` | F   | NOTE-01  | 2   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:51:45.756Z | 2026-11-10T08:52:21.162Z          | —                        |
| 46   | `fr-A-s2-NOTE-01` | A   | NOTE-01  | 2   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:52:30.993Z | 2026-11-10T08:53:31.431Z          | —                        |
| 47   | `fr-B-s2-NOTE-01` | B   | NOTE-01  | 2   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:53:42.895Z | 2026-11-10T08:54:13.432Z          | —                        |
| 48   | `fr-D-s2-NOTE-01` | D   | NOTE-01  | 2   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:54:22.209Z | 2026-11-10T08:54:43.689Z          | —                        |
| 49   | `fc-F-r0-H01`     | B   | H01      | 0   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T09:09:02.855Z | 2026-11-10T09:09:48.695Z          | —                        |
| 50   | `fc-A-r0-H01`     | A   | H01      | 0   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T08:55:58.634Z | 2026-11-10T08:56:27.561Z          | —                        |
| 51   | `fc-A-r0-H02`     | A   | H02      | 0   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:56:41.171Z | 2026-11-10T08:56:52.723Z |
| 52   | `fc-F-r0-H02`     | B   | H02      | 0   | true   | judged   | useful-update | pass    | pass",,"false",,"2026-11-10T09:09:58.209Z | 2026-11-10T09:10:21.006Z          | —                        |
| 53   | `fc-F-r0-H03`     | B   | H03      | 0   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T09:10:30.595Z | 2026-11-10T09:10:53.804Z |
| 54   | `fc-A-r0-H03`     | A   | H03      | 0   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T08:56:59.417Z | 2026-11-10T08:57:43.162Z |
| 55   | `fc-A-r0-H04`     | A   | H04      | 0   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:57:55.594Z | 2026-11-10T08:58:29.052Z |
| 56   | `fc-F-r0-H04`     | B   | H04      | 0   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:11:01.746Z | 2026-11-10T09:11:23.228Z |
| 57   | `fc-F-r1-H02`     | B   | H02      | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:11:29.570Z | 2026-11-10T09:11:43.674Z |
| 58   | `fc-A-r1-H02`     | A   | H02      | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T08:58:42.420Z | 2026-11-10T08:58:53.339Z |
| 59   | `fc-A-r1-H03`     | A   | H03      | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:59:04.402Z | 2026-11-10T08:59:27.474Z          | —                        |
| 60   | `fc-F-r1-H03`     | B   | H03      | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:11:52.869Z | 2026-11-10T09:12:18.768Z          | —                        |
| 61   | `fc-F-r1-H04`     | B   | H04      | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:12:24.657Z | 2026-11-10T09:13:03.215Z          | —                        |
| 62   | `fc-A-r1-H04`     | A   | H04      | 1   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T08:59:34.170Z | 2026-11-10T09:00:09.741Z          | —                        |
| 63   | `fc-A-r1-H01`     | A   | H01      | 1   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:00:16.466Z | 2026-11-10T09:00:33.717Z |
| 64   | `fc-F-r1-H01`     | B   | H01      | 1   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T09:13:12.250Z | 2026-11-10T09:13:48.628Z          | —                        |
| 65   | `fc-F-r2-H03`     | B   | H03      | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:13:59.019Z | 2026-11-10T09:14:37.899Z          | —                        |
| 66   | `fc-A-r2-H03`     | A   | H03      | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:00:43.403Z | 2026-11-10T09:01:08.779Z          | —                        |
| 67   | `fc-A-r2-H04`     | A   | H04      | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:01:16.163Z | 2026-11-10T09:01:52.982Z          | —                        |
| 68   | `fc-F-r2-H04`     | B   | H04      | 2   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:14:45.567Z | 2026-11-10T09:15:15.560Z          | —                        |
| 69   | `fc-F-r2-H01`     | B   | H01      | 2   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:15:21.930Z | 2026-11-10T09:16:04.359Z |
| 70   | `fc-A-r2-H01`     | A   | H01      | 2   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:01:59.878Z | 2026-11-10T09:02:18.089Z |
| 71   | `fc-A-r2-H02`     | A   | H02      | 2   | true   | judged   | misleading    | pass    | blocked                                   | false",,"2026-11-10T09:02:24.984Z | 2026-11-10T09:02:54.309Z |
| 72   | `fc-F-r2-H02`     | B   | H02      | 2   | true   | judged   | misleading    | pass    | blocked                                   | false",,"2026-11-10T09:16:11.912Z | 2026-11-10T09:16:37.933Z |
| 73   | `fc-F-r3-H04`     | B   | H04      | 3   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:17:05.521Z | 2026-11-10T09:17:23.079Z          | —                        |
| 74   | `fc-A-r3-H04`     | A   | H04      | 3   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:03:25.946Z | 2026-11-10T09:03:52.905Z |
| 75   | `fc-A-r3-H01`     | A   | H01      | 3   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:03:58.435Z | 2026-11-10T09:04:52.486Z |
| 76   | `fc-F-r3-H01`     | B   | H01      | 3   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:17:29.276Z | 2026-11-10T09:17:42.802Z |
| 77   | `fc-F-r3-H02`     | B   | H02      | 3   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:17:49.981Z | 2026-11-10T09:18:05.213Z |
| 78   | `fc-A-r3-H02`     | A   | H02      | 3   | true   | judged   | misleading    | pass    | blocked                                   | false",,"2026-11-10T09:05:02.033Z | 2026-11-10T09:05:30.621Z |
| 79   | `fc-A-r3-H03`     | A   | H03      | 3   | true   | judged   | none          | fail    | blocked                                   | true                              | 2026-11-10T09:05:50.514Z |
| 80   | `fc-F-r3-H03`     | B   | H03      | 3   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T09:18:13.097Z | 2026-11-10T09:18:51.399Z |
| 81   | `fc-F-r4-H01`     | B   | H01      | 4   | true   | judged   | useful-create | pass    | pass",,"false",,"2026-11-10T09:19:01.574Z | 2026-11-10T09:19:56.563Z          | —                        |
| 82   | `fc-A-r4-H01`     | A   | H01      | 4   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:06:45.901Z | 2026-11-10T09:07:03.441Z |
| 83   | `fc-A-r4-H02`     | A   | H02      | 4   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:07:15.120Z | 2026-11-10T09:07:23.613Z |
| 84   | `fc-F-r4-H02`     | B   | H02      | 4   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:20:05.789Z | 2026-11-10T09:20:19.323Z |
| 85   | `fc-F-r4-H03`     | B   | H03      | 4   | true   | judged   | transient     | pass    | blocked                                   | false",,"2026-11-10T09:20:26.555Z | 2026-11-10T09:20:48.709Z |
| 86   | `fc-A-r4-H03`     | A   | H03      | 4   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:07:31.858Z | 2026-11-10T09:07:54.509Z          | —                        |
| 87   | `fc-A-r4-H04`     | A   | H04      | 4   | true   | judged   | none          | pass    | pass",,"false",,"2026-11-10T09:08:01.862Z | 2026-11-10T09:08:31.127Z          | —                        |
| 88   | `fc-F-r4-H04`     | B   | H04      | 4   | true   | judged   | none          | pass    | blocked                                   | false",,"2026-11-10T09:21:01.365Z | 2026-11-10T09:21:15.384Z |

## Evidence index and access

| Artefact                                                            | Location                               | Access                                                                           |
| ------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| This packet, trial CSV, provenance, candidate asset                 | committed under `docs/testing/assets/` | reviewer-accessible                                                              |
| Raw sessions, generated fixtures, judge packets, signing keys, logs | campaign root on the analysis dev box  | dev-box only; not published                                                      |
| Integrity manifest                                                  | dev-box `evidence/EVIDENCE.sha256`     | 4844 rows, 94 signing-key paths excluded from hashing (contents never published) |

## Reproduce

```sh
node tests/fixtures/placement-harness/ac/run.mjs schedule --out /tmp/schedule.json
npm test -- tests/ac-review-packet.test.ts
```

The test recomputes the published totals from the committed CSV and checks the
hash and character mappings above.
