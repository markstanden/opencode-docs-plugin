---
Area: testing
Keywords: glossary, scenario-names, placement-trials, display-ids, conditions, reporting
Summary: Display-only scenario names for the placement corpora, the reporting vocabulary, and the rule that historical ids and saved run metadata are never silently renamed.
---

# Test glossary and readable scenario names

Readable names are a **reporting projection**. Every fixture id remains the
stable selector, corpus key and audit trail; new run descriptions snapshot the
display value so editing the map cannot rename an old stamp.

## Names people see

Use a full-word prefix, a stable number and a short task title:

> REUSE-01 — Read and reuse the existing test instructions (R01)

New summaries and dossiers include the title and keep the historical id in
parentheses. A run saved before the naming map has no display snapshot: report
its recorded id (and its recorded claim when one exists), never a newly
assigned historical title.

| Prefix       | Plain meaning                                  | Question                                                                                        |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PLACE`      | Choose the owner and destination               | Where does this knowledge belong, or must ownership be clarified?                               |
| `DISCOVER`   | Find configured documentation                  | Can the agent discover the available lakes through the tool?                                    |
| `NOTICE`     | Recognise knowledge worth preserving           | Does the agent propose recording a finding without an explicit request?                         |
| `NOTE`       | Preserve or withhold knowledge during work     | Does the agent complete the right note, or properly withhold one, while doing an ordinary task? |
| `REUSE`      | Consult existing documentation                 | Does the agent read and reuse, update or reference what is already recorded?                    |
| `RECORD`     | Create or replace documentation                | Does the agent complete the authorised document change correctly?                               |
| `CONTROL`    | Diagnose the execution environment             | Are tools registered, advertised, callable and observable?                                      |
| `REGRESSION` | Check harness/plugin behaviour with assertions | Does the software enforce its contract?                                                         |

Behavioural scenarios (`PLACE`, `DISCOVER`, `NOTICE`, `REUSE`, `RECORD`) are run
against models. `CONTROL` cases diagnose whether the environment can support
them. `REGRESSION` checks are implementation tests, often with synthetic tool
trails. Report these separately.

The primary purpose decides the prefix. A `REUSE` scenario may include a write
after consulting an existing document; `RECORD` scenarios concentrate on the
resulting document and preservation rules.

## Current scenario map

The authoritative copy for code is
`tests/fixtures/placement-harness/scenario-names.mts`, version
`namingMapVersion` 1. The map is display-only: CLI selection, fixture paths and
corpus expectations still use the historical ids.

### Placement

| Historical id | Display id | Title                                               |
| ------------- | ---------- | --------------------------------------------------- |
| E01           | PLACE-01   | Place the search-index design decision              |
| E02           | PLACE-02   | Place Kylo's Secure Boot requirement                |
| E03           | PLACE-03   | Place personal editor preferences                   |
| E04           | PLACE-04   | Place the organisation's deployment identity rule   |
| E05           | PLACE-05   | Keep the SDK finding within its proven scope        |
| E06           | PLACE-06   | Choose where test instructions belong               |
| E07           | PLACE-07   | Place a diagnosed regression and its evidence       |
| E08           | PLACE-08   | Route an onboarding narrative to the wiki           |
| E09           | PLACE-09   | Place a service exception to an existing policy     |
| E10           | PLACE-10   | Place a bug's cause and failed workaround           |
| E11           | PLACE-11   | Choose the workstation lake for a desktop fix       |
| E12           | PLACE-12   | Handle a missing personal documentation destination |
| E13           | PLACE-13   | Preserve the payments team's policy boundary        |
| E14           | PLACE-14   | Place an expired personal CLI session finding       |
| E15           | PLACE-15   | Place the repository's formatter decision           |
| E16           | PLACE-16   | Clarify personal preference versus team policy      |
| E17           | PLACE-17   | Choose the correct lake among nested roots          |
| E18           | PLACE-18   | Place a household appliance warranty                |
| R04           | PLACE-19   | Defer placement when ownership is unresolved        |

R04 sits in `PLACE` because its assertion is about clarification, with no
required retrieval. It remains distinct from E16: similar purpose does not
establish identical prompts or evidence.

### Discovery and preservation triggers

| Historical id | Display id  | Title                                                          |
| ------------- | ----------- | -------------------------------------------------------------- |
| D01           | DISCOVER-01 | Discover the workstation lake through docs help                |
| D02           | NOTICE-01   | Recognise the retry-limit finding as knowledge worth recording |
| D03           | NOTICE-02   | Recognise the formatter decision as knowledge worth recording  |

D02 and D03 test whether recording is proposed; they do not establish that a
document was written. DISCOVER-01 requires a successful observable help
operation, not a destination inferred from prompt text.

### Automatic notetaking

`NOTE` scenarios measure completed documentation while the agent does an
ordinary practical task under standing permission. They differ from `NOTICE`:
`NOTICE` measures a proposal in a decision-only session, `NOTE` measures the
actual create/update or the restraint outcome. Positive and restraint cases
are reported separately.

| Historical id | Display id | Title                        |
| ------------- | ---------- | ---------------------------- |
| NOTE-01       | NOTE-01    | Diagnose the retry boundary  |
| NOTE-02       | NOTE-02    | Correct the stale setup rule |
| NOTE-03       | NOTE-03    | Handle the interrupted run   |
| NOTE-04       | NOTE-04    | Reuse the replay diagnosis   |

### Reuse and recording

| Historical id | Display id | Title                                                     |
| ------------- | ---------- | --------------------------------------------------------- |
| R01           | REUSE-01   | Read and reuse the existing test instructions             |
| R02           | REUSE-02   | Read and update the stale hook-guard finding              |
| R05           | REUSE-03   | Reference the existing policy when recording an exception |
| R06           | REUSE-04   | Read the wiki page and follow its owners' workflow        |
| W01           | RECORD-01  | Create one focused document within the permitted lake     |
| W02           | RECORD-02  | Replace the existing document and preserve its marker     |

There is no R03 in the current corpus. Do not fabricate a missing test to
complete an old sequence.

### Environment controls

`A01` is the implemented report-only tool-availability diagnostic:
**CONTROL-02 — Confirm docs help through the harness launch (A01)**.

The remaining controls are **proposed**, not implemented scenarios. Do not
generate a control suite merely to populate this table.

| Display id | Proposed title                                      | Controlled comparison                                        |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------ |
| CONTROL-01 | Confirm docs help through the known working launch  | Working invocation with a fixed model and harmless prompt    |
| CONTROL-02 | Confirm docs help through the harness launch        | Same inputs, actual harness child process (A01, implemented) |
| CONTROL-03 | Check native docs advertisement and dispatch        | Explicit native route, where advertised                      |
| CONTROL-04 | Check Code Mode docs advertisement and dispatch     | Explicit supported Code Mode route                           |
| CONTROL-05 | Check whether availability changes within a session | Bounded repeated request with timestamps                     |
| CONTROL-06 | Check consistency across fresh sessions             | Identical setup, independent session state                   |

### Conditions

Condition letters describe the instruction given to a model; they are not
scenario ids (`A01`) or regression labels (`C01`). New run descriptions record
the phrase with `--condition` and reports render the phrase, not the letter.

| Condition | Report phrase                |
| --------- | ---------------------------- |
| A         | native instruction           |
| A2        | sharpened native instruction |
| B         | Code Mode instruction        |
| C         | natural task                 |

Natural tasks remain behavioural trials, not environment-control successes.
The explicit read control used for access checks reports as
`explicit read control`. It is a separate diagnostic corpus
(`tests/fixtures/read-control-cases.json`) that keeps the `R01` selector and
seed, asks for an operation-level docs read, and remains unjudged.

## Reporting glossary

| Term                    | Meaning                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Scenario                | The task definition, fixture and expected behaviour                                                                           |
| Trial                   | One model attempting one scenario in one isolated session                                                                     |
| Repetition              | Another independent trial of the same scenario and setup                                                                      |
| Campaign                | A recorded collection of trials with identified revisions and configurations                                                  |
| Workhorse               | The model performing the task                                                                                                 |
| Judge                   | A separate model assessing an answer against a rubric; its verdict can be wrong                                               |
| Rubric                  | Expectations written before judging                                                                                           |
| Deterministic check     | A software assertion about captured evidence, such as a required successful read                                              |
| Fixture                 | The prepared workspace, seeded documents and configuration                                                                    |
| Frozen setup            | The recorded source/configuration/prompt versions associated with a run                                                       |
| Registration            | The host loads and registers a tool                                                                                           |
| Advertisement           | A tool definition is supplied to the model                                                                                    |
| Dispatch                | A requested tool operation reaches its implementation                                                                         |
| Attempt                 | A requested operation, regardless of whether it executed or succeeded                                                         |
| Successful operation    | Result evidence establishes the requested operation succeeded                                                                 |
| Verified read           | Observable operation evidence establishes retrieval of the required document                                                  |
| Verified write          | Filesystem evidence establishes the required document change; this alone does not establish plugin use                        |
| Observable operation    | The capture identifies the individual operation and its result                                                                |
| Wrapper-only evidence   | Code Mode completed, but its nested docs operation lacks an independently captured event                                      |
| Exposure                | A session read guidance, case lists, configuration or harness surfaces; the surface decides whether expected or contaminating |
| Contamination           | Access to information that compromises the intended task, such as a hidden expected answer                                    |
| Pass / fail             | The recorded expectations were met / were not met                                                                             |
| Criterion unmet         | A required operation or artefact was not established; current harness verdicts may call this invalid                          |
| Capture failure         | The trial evidence could not be collected reliably                                                                            |
| Environment unavailable | Evidence establishes that a required capability was unavailable                                                               |
| Judge error             | The judge failed to produce a usable assessment                                                                               |
| Inconclusive            | Available evidence cannot establish the relevant claim                                                                        |

A criterion-unmet result does not identify the cause. Missing tool access,
model non-use and unobservable execution require different explanations.
Successful process exit does not establish task success. A model's inventory
answer does not by itself establish the host's registered or advertised tool
set.

Historical `C01`/`M04` and similar identifiers are implementation regressions.
In reports, use `REGRESSION — <existing descriptive test title>` and retain the
exact test name and source file as the stable reference.

## Facts

- The current map covers 34 cases: E01–E18, R04, D01–D03, R01, R02, R05, R06,
  W01, W02, A01 and NOTE-01–NOTE-04.
- New run descriptions record `namingMapVersion` and each case's display
  identity; prompts are unchanged.
- `tests/harness.test.ts` asserts completeness, uniqueness and the rendering
  split between new and legacy stamps.

## Tested

- Run a new experiment with a unique stamp: its summary and dossier render the
  readable name and keep the historical id.
- A legacy stamp without a saved display snapshot renders its recorded id and
  claim; the current map is not applied retroactively.
- Conditions render as phrases; historical condition letters are not treated
  as scenario ids.

## Open questions

- None recorded.
