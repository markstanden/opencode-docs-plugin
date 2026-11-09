---
Area: Testing
Keywords: recording, w01, w02, deepseek, crouton, controls, zero-write, baseline, placement-trials
Summary: Ten-repetition recording baseline on merged 4e66fc5: DeepSeek completed 14 of 20 trials, all six zero-write outcomes were proposal-only, and Crouton's natural batch was paused after its help control failed the criterion.
---

# Recording baseline: ten repetitions on the merged harness, 2026-11-09

## Facts

### Frozen setup

- Code: HEAD `4e66fc58f6023fb9521f32c27425e286c6032688`, version 0.13.1,
  clean tree. The reviewed PR head `720b5fc1daaf4fb153d009767b14982eb871b57b`
  has the same tree `de564a9906cc9d957a43d67ae88661d10f021d57`; the merge was
  a squash, so the campaign ran the reviewed bytes.
- Models: trial `opencode-go/deepseek-v4.1-flash` and
  `opencode-go/crouton-alpha-free`; judge `opencode-go/glm-5.3-flash`.
  All three resolved as active `opencode-go` models.
- Tasks: checked-in `W01` (RECORD-01) and `W02` (RECORD-02) from
  `tests/fixtures/trial-cases.json` (sha256 `601a5519…`), condition C
  (natural task), unmodified prompts, seeds, destinations and rubrics.
- Container image `localhost/opencode-placement-trials`, id
  `58505eac…643beb`; host/CLI `opencode v2.2.6`; Node 26.13.0.
- Campaign window: started 2026-11-09T07:28:21Z; the two-hour deadline was
  09:28:21Z and was not reached.
- Serial execution: one trial child at a time. The models share the host
  provider proxy and host CPU, and the wrapper starts containers serially;
  running serially kept measured latency comparable.

### Controls (four, unjudged)

| Model | Control     | cwd / child PWD / host cwd | Plugin load | Operation evidence                                                                                                                      | Writes | Verdict  |
| ----- | ----------- | -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| dv4f  | A01 help    | match                      | observed    | native `docs {search:"help"}` and journaled nested `docs_search {search:"help"}`, configured inventory returned                         | 0      | pass     |
| dv4f  | seeded read | match                      | observed    | native `docs {read:"kb/test-commands.md"}`, revision `1193e96a…` equals the seeded file sha256                                          | 0      | pass     |
| crut  | A01 help    | match                      | observed    | native and journaled nested `docs_search {search:""}` only; both returned `No knowledge docs matched.`; **no help/inventory operation** | 0      | **fail** |
| crut  | seeded read | match                      | observed    | native `docs {read:"kb/test-commands.md"}`, revision `1193e96a…` equals the seeded file sha256                                          | 0      | pass     |

The Crouton A01 failure is a control-criterion failure, not proof that the
tool is unreachable: its read control proves read access, and both blank
searches dispatched. The prompt asks for help or the configured inventory;
Crouton chose a blank search, which lists recent docs (none here) rather than
the inventory. Under the frozen rule, a failed control pauses that model's
natural trials. It was not retried.

### Natural trials

Crouton's natural batch was not run, so its combined results are reported as
not run / N/A rather than as measured rates. Its behaviour is not described by
this campaign.

| Model | Task | Planned | Attempted | Completed | Usable | Mutations satisfied | Gate passed | Gate blocked     | Semantic P / F / JE / NJ | Combined (planned) | Combined (usable) |
| ----- | ---- | ------- | --------- | --------- | ------ | ------------------- | ----------- | ---------------- | ------------------------ | ------------------ | ----------------- |
| dv4f  | W01  | 10      | 10        | 10        | 10     | 6                   | 6           | 4 (zero-write 4) | 6 / 0 / 0 / 4            | **6/10**           | 6/10              |
| dv4f  | W02  | 10      | 10        | 10        | 10     | 8                   | 8           | 2 (zero-write 2) | 8 / 0 / 0 / 2            | **8/10**           | 8/10              |
| crut  | W01  | 10      | 0         | 0         | 0      | 0                   | 0           | 0                | 0 / 0 / 0 / 0            | not run            | N/A               |
| crut  | W02  | 10      | 0         | 0         | 0      | 0                   | 0           | 0                | 0 / 0 / 0 / 0            | not run            | N/A               |

All 20 sessions completed without timeout, cancellation, invalid session or
tool-unavailability. Every gate block was the required-mutation policy
(`recording case wrote 0 file(s), policy requires 1`); there were no
docs-criterion, artefact/preservation, policy or session blocks.

Repetition-level outcomes (W = write/pass, B = zero-write block):

| Rep | Block order  | W01 | W02 |
| --- | ------------ | --- | --- |
| r01 | W01 then W02 | W   | W   |
| r02 | W02 then W01 | W   | W   |
| r03 | W01 then W02 | B   | W   |
| r04 | W02 then W01 | W   | B   |
| r05 | W01 then W02 | B   | W   |
| r06 | W02 then W01 | B   | W   |
| r07 | W01 then W02 | W   | B   |
| r08 | W02 then W01 | W   | W   |
| r09 | W01 then W02 | B   | W   |
| r10 | W02 then W01 | W   | W   |

### Per-trial evidence

`A/C` means attempted/completed; add and replace counts are docs calls, not
proven mutations. Access means invoked cwd, child PWD and host-logged cwd
agree and the plugin load was observed.

| Trial        | Order | Start (UTC) | Access        | Native/nested | Read A/C | Add A/C | Replace A | Writes | Mutation      | Gate                | Semantic   | Elapsed | Tokens in/out |
| ------------ | ----- | ----------- | ------------- | ------------- | -------- | ------- | --------- | ------ | ------------- | ------------------- | ---------- | ------- | ------------- |
| dv4f r01 W01 | 1     | 07:37:54    | match, loaded | 10/0          | 1/1      | 1/1     | 0         | 3      | satisfied     | passed              | pass       | 31s     | 11219/1161    |
| dv4f r01 W02 | 2     | 07:38:26    | match, loaded | 8/0           | 2/2      | 1/1     | 1         | 2      | satisfied     | passed              | pass       | 28s     | 11657/1229    |
| dv4f r02 W02 | 1     | 07:38:55    | match, loaded | 0/6           | 1/1      | 2/2     | 2         | 2      | satisfied     | passed              | pass       | 24s     | 11047/1884    |
| dv4f r02 W01 | 2     | 07:39:20    | match, loaded | 0/11          | 1/1      | 1/1     | 0         | 3      | satisfied     | passed              | pass       | 48s     | 12778/1862    |
| dv4f r03 W01 | 1     | 07:40:09    | match, loaded | 0/10          | 0/0      | 0/0     | 0         | 0      | not satisfied | blocked: zero-write | not judged | 35s     | 6305/901      |
| dv4f r03 W02 | 2     | 07:40:44    | match, loaded | 0/11          | 1/1      | 1/1     | 1         | 2      | satisfied     | passed              | pass       | 31s     | 12422/2058    |
| dv4f r04 W02 | 1     | 07:41:16    | match, loaded | 0/3           | 0/0      | 0/0     | 0         | 0      | not satisfied | blocked: zero-write | not judged | 31s     | 9403/772      |
| dv4f r04 W01 | 2     | 07:41:48    | match, loaded | 3/11          | 1/1      | 1/1     | 0         | 3      | satisfied     | passed              | pass       | 34s     | 11604/1280    |
| dv4f r05 W01 | 1     | 07:42:22    | match, loaded | 0/6           | 0/0      | 0/0     | 0         | 0      | not satisfied | blocked: zero-write | not judged | 30s     | 8793/814      |
| dv4f r05 W02 | 2     | 07:42:52    | match, loaded | 10/0          | 3/3      | 2/2     | 2         | 2      | satisfied     | passed              | pass       | 40s     | 13635/2048    |
| dv4f r06 W02 | 1     | 07:43:33    | match, loaded | 11/0          | 5/5      | 1/1     | 1         | 2      | satisfied     | passed              | pass       | 31s     | 11615/1495    |
| dv4f r06 W01 | 2     | 07:44:04    | match, loaded | 0/3           | 0/0      | 0/0     | 0         | 0      | not satisfied | blocked: zero-write | not judged | 38s     | 9055/833      |
| dv4f r07 W01 | 1     | 07:44:43    | match, loaded | 0/5           | 0/0      | 1/1     | 0         | 3      | satisfied     | passed              | pass       | 32s     | 11587/1293    |
| dv4f r07 W02 | 2     | 07:45:15    | match, loaded | 0/2           | 1/1      | 0/0     | 0         | 0      | not satisfied | blocked: zero-write | not judged | 17s     | 9186/743      |
| dv4f r08 W02 | 1     | 07:45:32    | match, loaded | 0/10          | 2/2      | 2/2     | 2         | 2      | satisfied     | passed              | pass       | 36s     | 13371/2251    |
| dv4f r08 W01 | 2     | 07:46:09    | match, loaded | 0/13          | 4/4      | 1/1     | 0         | 3      | satisfied     | passed              | pass       | 37s     | 12188/1222    |
| dv4f r09 W01 | 1     | 07:46:47    | match, loaded | 0/11          | 0/0      | 0/0     | 0         | 0      | not satisfied | blocked: zero-write | not judged | 55s     | 9838/1097     |
| dv4f r09 W02 | 2     | 07:47:43    | match, loaded | 0/6           | 2/2      | 2/2     | 2         | 2      | satisfied     | passed              | pass       | 25s     | 11553/1980    |
| dv4f r10 W02 | 1     | 07:48:09    | match, loaded | 8/0           | 1/1      | 1/1     | 1         | 2      | satisfied     | passed              | pass       | 30s     | 33211/1275    |
| dv4f r10 W01 | 2     | 07:48:39    | match, loaded | 9/0           | 1/1      | 1/1     | 0         | 3      | satisfied     | passed              | pass       | 32s     | 11565/1234    |

### No-write outcomes

All six were proposal-only; none refused and none attempted a write that
failed. Four explicitly asked for confirmation or clarification, and two
offered only optional clarification while still not writing.

| Trial        | Route       | Label                                                | Supporting excerpt                                                                                         |
| ------------ | ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| dv4f r03 W01 | nested only | proposed action only; awaited go-ahead               | “If you want me to proceed, I will create the doc … then run `check` on the lake.”                         |
| dv4f r04 W02 | nested only | proposed action only; confirmation requested         | “Confirm the in-place replace of `kb/lake-identity.md` … I've made no changes yet.”                        |
| dv4f r05 W01 | nested only | proposed action only; optional clarification only    | “None blocking — I can write it from the supplied facts alone.”                                            |
| dv4f r06 W01 | nested only | proposed action only; clarification requested        | “If the answer to (1) is ‘this repo’ and (2) is acceptable, I'll create the single doc…”                   |
| dv4f r07 W02 | nested only | proposed action only; confirmation requested         | “Confirm you want the in-place **replace** executed now… I will stop at this plan.”                        |
| dv4f r09 W01 | nested only | proposed action only; optional identifiers requested | “None blocking under the ‘supplied facts’ instruction. However, the evidence descriptions do not include…” |

### Routes, operations and policy

| Measure                                      | W01   | W02     |
| -------------------------------------------- | ----- | ------- |
| Native docs operations                       | 22    | 37      |
| Journal-backed nested operations             | 85    | 47      |
| Verified docs operations (incl. search/help) | 86    | 67      |
| Read calls / verified                        | 8 / 8 | 18 / 18 |
| Add calls / writing trials                   | 6 / 6 | —       |
| Replace calls / writing trials               | —     | 12 / 8  |
| Required mutations satisfied                 | 6     | 8       |
| Policy violations                            | 0     | 0       |

- Successful trials used native, nested and mixed routes. All six zero-write
  trials were nested-only, but nested-only trials also produced seven
  successful writes, so the route alone does not explain the outcome.
- Four of the twelve replace calls used the destination label (`repo`, `kb`)
  as the lake name and were rejected (`no lake named…`) before a successful
  retry with `lake:"docs"`. These are tool-level retries, not gate failures.
- The empty `.docs-lock` housekeeping directory and created parent
  directories were accepted by the merged gate; no unrelated change or
  out-of-policy write occurred.

### Latency and telemetry

- Trial latency: mean 33.2s (W01 37.1s, W02 29.4s), range 16.8–55.2s.
- 170 recorded steps: 242,032 input, 27,432 output, 32,047 reasoning,
  1,206,656 cache-read tokens.
- Recorded step cost: **0**. This is not evidence of zero billed cost.
  At DeepSeek list prices (input $0.15, output $0.60, cache read
  $0.003 per million tokens) the trial steps estimate to roughly **$0.08**;
  actual billing is not available. Judge token and cost telemetry is not
  captured.

### Integrity and capture

- All 20 freeze receipts match their stamp, case and `run.json` digest.
- Plugin hash, image id and each case's generation inputs hash are constant
  across all trials; corpus hash matches the frozen trial corpus.
- 20/20 sessions: matching cwd/PWD/host cwd, observed plugin load, journal
  present, every journal line carrying a MAC, signing key mode `0600`.
- No tampering or key anomaly was observed. This is a tamper-evident capture
  channel, not adversarially secure authentication: a shell-capable child
  could obtain the signing key. No key or credential is reproduced here.
- One journal record (W02 r04, a read) was present but not credited as a
  verified operation. It is reported as unverified evidence, not as proof of
  no tool use; that trial was zero-write and gate-blocked regardless.

### Pilot and deviations

- A pre-control DeepSeek pilot (stamps `nat-r01`–`nat-r04`, plus `nat-r05`
  W01; nine trials) ran before the controls because of an orchestration-script
  error. It is preserved untouched under `dv4f/results/` and excluded from
  every count above. The baseline batch used fresh `nat2-*` stamps after the
  controls.
- The first judge pass stopped after `nat2-r03` because the wrapper returns
  non-zero for a gate-blocked trial and the orchestrator used `set -e`.
  Stamps `r04`–`r10` were judged in a second pass; every eligible trial has
  exactly one judge attempt, and `r01`–`r03` were not re-judged.
- The four controls ran before the baseline batch. The campaign was serial and
  completed inside the deadline.

## Inferred

- DeepSeek's baseline is 14/20 combined passes: W02 (8/10) was more reliable
  than W01 (6/10), with within-task streaks rather than a uniform rate. Ten
  repetitions describe this variability; they do not estimate a population
  rate or rank the two models.
- The six zero-write outcomes are not tool failures, refusals or environment
  failures. They are proposal-only responses, often awaiting confirmation,
  despite the prompt saying the trial is authorised to record documentation.
  The closing checklist (“State … any clarification needed before proceeding”)
  is a plausible prompt-level cause, not a measured one.
- Crouton's natural recording behaviour is unmeasured here. Its read access is
  proven, but its help control did not satisfy the criterion even though the
  session ran, so the campaign cannot say whether it would have written.
- The lake-name confusion (`repo`/`kb` instead of `docs`) is a recoverable
  operation error, not a policy breach; the model retried successfully in
  every observed case.

## Tested

- `container-run.sh` generate/run/judge/summary/export on the merged harness;
  four unjudged controls; twenty natural trials; serial judging with
  `--judge-jobs 1`; freeze, generation, journal and cwd/PWD integrity checks
  from the raw evidence. The full test suite was not repeated on unchanged
  code.

## Failed approaches

- Running the natural batch before the controls (the excluded pilot) wasted
  nine trials and could not be pooled.
- Retrying the failed Crouton A01 control to obtain a pass would have violated
  the frozen control rule; it was left failed and Crouton's batch was paused.

## Open questions

- Why did W02 fail to write in r04 and r07 while the other eight wrote? The
  answers are proposals, not failures; no motive is inferred.
- Would a direct “record it now” instruction lift the six proposal-only
  outcomes, or are they a stable model disposition?
- Does Crouton write under a passing control? Unknown until an authorised
  control and batch run.
- Judge-side token and cost telemetry remains uncaptured.

## Candidate intervention (not implemented)

Change one thing: replace the natural-task closing checklist (“State your
intended action… Any clarification needed before proceeding”) with a direct
instruction to perform the recording and then report the destination and
reason. Keep the claim, evidence, destinations, authorisation and rubric
byte-identical. The evidence for this candidate is the 6/20 zero-write set:
every one proposed an action, and several explicitly waited for confirmation
despite the existing write authorisation. Test it with fresh, interleaved
original/revised trials: equal numbers of each arm for both tasks, alternating
the arm within each block, fresh stamps and sessions throughout. Retain this
historical baseline for context; do not pool it with the new arm.

## Resume commands

Crouton's 20 natural trials remain unstarted because its A01 control failed.
They must not be retried automatically; a fresh control must pass first under
a new stamp, for example `ctl2-a01`, using the same command shape as above.

After an authorised, freshly passing Crouton control, resume from a
checkout of the frozen code, not this documentation branch:

```sh
ROOT=/home/mark/tmp/docs-record-baseline-20261109T072821Z
git -C /home/mark/repos/opencode-docs-plugin worktree add \
  /home/mark/tmp/record-baseline-code 4e66fc58f6023fb9521f32c27425e286c6032688
REPO=/home/mark/tmp/record-baseline-code $ROOT/campaign.sh nat crut nat2 1 10
REPO=/home/mark/tmp/record-baseline-code $ROOT/campaign.sh judge crut nat2
REPO=/home/mark/tmp/record-baseline-code $ROOT/campaign.sh report crut nat2
```

To resume an unfinished DeepSeek block range (none outstanding here):

```sh
$ROOT/campaign.sh nat dv4f nat2 <first> <last>
$ROOT/campaign.sh judge dv4f nat2
```

Raw evidence: `/home/mark/tmp/docs-record-baseline-20261109T072821Z/`
(`IDENTITY.txt`, `CORPORA-AND-CODE.sha256`, `RUN_PLAN.md`, `CONTROLS.md`,
`logs/`, `analysis/`, `dv4f/results/`, `crut/results/`).
