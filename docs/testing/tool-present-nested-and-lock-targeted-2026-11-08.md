---
Area: Testing
Keywords: code-mode, operation-journal, docs-lock, placement-trials, deepseek, crouton, glm-judge, nested-operations
Summary: Targeted follow-up after the tool-present campaign — the plugin journal verifies served Code Mode calls and the recording gate permits the empty plugin lock directory; three selected scenarios ran on both workhorses, with DeepSeek passing all three in one repetition and Crouton writing nothing.
---

# Nested-operation evidence and lock housekeeping — targeted follow-up, 2026-11-08

## Facts

### The two measurement defects and their fixes

- **Code Mode operations were unobservable.** The CLI trail records only the
  outer `execute` part. Its result metadata lists dispatched nested calls
  (`tool`, `status`, `input`) but no per-call result, so a successful read or
  write could not be verified. The plugin now appends one record per served
  `docs`/`docs_search` call to the file named by the opt-in
  `DOCS_OPERATION_JOURNAL` environment variable: schema version, registered
  tool, registration surface (`native` or `codemode-twin`), status, exact
  input, and the result envelope or error. It is silent when unset and
  fail-quiet, so production behaviour is unchanged.
- The harness sets that path per case beside `tools.jsonl` (outside the
  snapshot surfaces), folds only `codemode-twin` records into the trail as
  `nested` operations, runs the existing success verifier on them, dedupes a
  direct twin call against its journal copy, and never reads another case's
  journal. The `execute` wrapper stays attempted-only. Wrapper output, printed
  JSON, forged model text, refusals, errors, wrong verbs and wrong paths still
  cannot satisfy a criterion.
- **The plugin's `.docs-lock` directory was treated as an unrelated mutation.**
  A successful write creates `.docs-lock` beside its target and removes only
  the lock file, leaving an empty directory. The recording gate now permits
  exactly that shape: an added, empty, readable directory named `.docs-lock`
  whose parent is an ancestor of the expected document. A stale lock file, a
  symlink, an unreadable directory, a lock directory away from the expected
  document, further unrelated changes and a lock directory with no created
  document all still fail the gate.
- Code revision for the finished work and all primary live runs:
  `4b75b581a6db54d6744af58bdaf30a29b8d69bef` on branch
  `fix/nested-op-evidence-and-lock-housekeeping` (base `9ea07b8`). Validation:
  **683 tests pass**, `npm run typecheck` clean, `defined comply` →
  `{"status":"compliant"}`. No push, merge or release.
- Raw evidence root: `/home/mark/tmp/docs-family-c20261108-nested-lock/`
  (`IDENTITY.txt`, `CORPORA.sha256`, `SELECTION.md`,
  `targeted-analysis.json`, `targeted-analysis.tsv`, `historical-derived/`).

### Controls (clean revision, four sessions)

| Control               | Model               | cwd / child PWD / host cwd | Plugin load | Evidence                                                                                     | Result        |
| --------------------- | ------------------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------------- | ------------- |
| A01 help (CONTROL-02) | DeepSeek V4.1 Flash | match / match / match      | observed    | native help **and** plugin-journaled nested help; observability operation-level              | positive      |
| A01 help (CONTROL-02) | Crouton Alpha Free  | match / match / match      | observed    | native help **and** plugin-journaled nested help; observability operation-level              | positive      |
| Explicit seeded read  | DeepSeek V4.1 Flash | match / match / match      | observed    | Code Mode nested read of `kb/test-commands.md`; revision `1193e96a…` equals the seed SHA-256 | criterion met |
| Explicit seeded read  | Crouton Alpha Free  | match / match / match      | observed    | native read of the same seed; revision `1193e96a…` equals the seed SHA-256                   | criterion met |

All four made zero writes. DeepSeek's read control is the first live proof that
a Code Mode read is verified from the plugin journal rather than a wrapper.
No control consumed a semantic judge call.

### Selected scenarios and clean natural results

Frozen before the runs; identical selection for both workhorses, two
repetitions each (12 natural trials).

| Scenario                                                                | DeepSeek V4.1 Flash                                                                                                      | Crouton Alpha Free                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| REUSE-04 — Read the wiki page and follow its owners' workflow (R06)     | rep 1 **pass** (6 nested, verified wiki read); rep 2 gate-blocked (0 docs ops)                                           | rep 1 and rep 2 gate-blocked (0 docs ops; criterion unmet)   |
| RECORD-01 — Create one focused document within the permitted lake (W01) | rep 1 **pass** (9 nested, 1 verified nested add, doc + ancestor + `.docs-lock`); rep 2 gate-blocked (4 native, 0 writes) | rep 1 and rep 2 gate-blocked (10/4 nested, 0 writes)         |
| RECORD-02 — Replace the existing document and preserve its marker (W02) | rep 1 **pass** (7 native, target + `.docs-lock`); rep 2 gate-blocked (6 nested, 2 verified reads, 0 writes)              | rep 1 and rep 2 gate-blocked (6 nested / 5 native, 0 writes) |

Judged outcomes: **3 passes, 0 semantic fails, 9 deterministic gate blocks**
(3 docs-criterion, 6 zero-write), 0 invalid sessions, 3 semantic judge calls
(`opencode-go/glm-5.3-flash`, serial). DeepSeek rep 2 varied sharply from rep 1
in the same case; two repetitions are not a model-disposition claim.

### Operations, mutations and policy (clean natural trials)

| Measure                               | DeepSeek | Crouton | Total |
| ------------------------------------- | -------- | ------- | ----- |
| Natural trials attempted              | 6        | 6       | 12    |
| Native docs operations                | 11       | 5       | 16    |
| Plugin-journaled nested operations    | 21       | 20      | 41    |
| Verified successful docs operations   | 30       | 25      | 55    |
| Wrapper-only Code Mode attempts       | 17       | 12      | 29    |
| Nested reads (verified read envelope) | 3        | 1       | 4     |
| Nested adds attempted / successful    | 1 / 1    | 0 / 0   | 1 / 1 |
| Required mutations satisfied          | 2        | 0       | 2     |
| Files written by those mutations      | 5        | 0       | 5     |
| Policy violations                     | 0        | 0       | 0     |
| Semantic judge calls                  | 3        | 0       | 3     |

`Verified successful docs operations` includes searches and help; it is not a
read count. Every natural session had matching invoked cwd, child PWD and
logged host cwd and an observed plugin load.

The successful RECORD-01 and RECORD-02 runs both wrote the exact
`lakes/docs/.docs-lock` housekeeping directory that invalidated the old
Crouton creation, at the lake root and beside the target respectively. Under
the previous gate they would have been refused as unrelated changes.

### Historical re-evaluation (derived, not re-run)

`historical-derived/COMPARISON.json` copies three old case directories to an
isolated root and runs the **new deterministic gate** with a stub judge binary;
the semantic step is a stub, never a new judgement, and no old file was
modified. Original campaign revision `0f75a84…`, new evaluator `4b75b58…`,
input hashes recorded per case.

- Crouton W01 `crut-nat-r2`: before **invalid** — `unrelated change(s)…
added lakes/docs/.docs-lock (dir)`; after the deterministic gate **passes**
  (stub judge, so no semantic pass is claimed). This is the lock fix against
  the original evidence.
- DeepSeek R02 `dv4f-nat-r1` and W02 `dv4f-nat-r2`: still **invalid** with
  the same docs-criterion reasons. They have no journal, so their Code Mode
  operations remain unknown; the lock fix does not promote unverifiable old
  evidence, and no old stamp is relabelled.

## Inferred

- DeepSeek's REUSE-04 rep 1 pass is a measurement correction, not a new
  behaviour: the wiki read happened through Code Mode and is now proven by the
  plugin journal. Its RECORD-01 rep 1 pass likewise used a verified nested add.
- The Crouton outcomes are task outcomes, not measurement artefacts: it made
  no knowledge write in any of the six trials, and in both REUSE-04 trials it
  made no docs call at all. The lock fix deliberately does not convert zero
  writes into passes.
- DeepSeek rep 2 wrote nothing in all three cases despite reading in RECORD-02,
  so the observed rep 1 sweep should not be read as a stable disposition.

## Tested

- `tests/operation-journal.test.ts`: unset writes nothing; a served twin call
  records tool/input/session/result; a thrown call records an error and
  rethrows.
- `tests/harness.test.ts` N01: nested success satisfies a verb/path criterion;
  nested error, refusal, wrong path, wrong verb, wrapper-only and forged
  printed success do not; two nested calls count once each without the
  wrapper; a direct twin plus its journal copy counts once; another case's
  journal cannot satisfy the case.
- `tests/harness.test.ts` L01: empty lock directory beside a valid creation
  and replacement passes; stale lock file, symlink, non-ancestor lock and a
  lock directory with no document all fail.
- A01 reporting: a journaled nested help call is operation-level, not
  wrapper-only.
- Full suite, typecheck, `defined comply`; controls and natural runs through
  `container-run.sh` generate/run/judge/summary/export with `--print-logs`,
  frozen corpora and serial judging.

## Failed approaches

- A pre-freeze pilot batch (stamps `*-nl-nat-r*`) ran while the diagnostic
  reporting delta was uncommitted; those results are preserved but are not the
  primary evidence. The primary clean runs are `*-nl2-*`.

## Open questions

- Does DeepSeek's Code Mode preference and its rep-to-rep write variance
  persist beyond two repetitions? This comparison cannot say.
- Judge-side token and cost telemetry is still not captured. Trial steps
  reported cost 0 (64 step records; 169,379 input, 8,687 output, 8,367
  reasoning tokens), which is not proof of zero billed cost.

## Resume commands

From `/home/mark/repos/opencode-docs-plugin/tests/fixtures/placement-harness`,
with `ROOT=/home/mark/tmp/docs-family-c20261108-nested-lock`:

```sh
# One primary natural stamp (fresh stamp only; never reuse an existing one)
PLACEMENT_CASES=/home/mark/repos/opencode-docs-plugin/tests/fixtures/trial-cases.json \
PLACEMENT_PROMPTS=$ROOT/dv4f-natural/prompts \
PLACEMENT_FIXTURES=$ROOT/dv4f-natural/fixtures \
PLACEMENT_RUBRICS=$ROOT/dv4f-natural/rubrics \
PLACEMENT_RESULTS=$ROOT/results \
PLACEMENT_RUN_FIXTURES=$ROOT/dv4f-natural/run-fixtures \
./container-run.sh run W01 R06 W02 --stamp dv4f-nl2-nat-r3 \
  --model opencode-go/deepseek-v4.1-flash --condition C --print-logs --jobs 1

# Judge that stamp, serially
PLACEMENT_RESULTS=$ROOT/results ./container-run.sh judge \
  --stamp dv4f-nl2-nat-r3 --judge-model opencode-go/glm-5.3-flash --judge-jobs 1
```

Controls use the same shape with `diagnostic-cases.json` (A01, no condition)
and `read-control-cases.json` (R01, `--condition explicit-read-control`).
