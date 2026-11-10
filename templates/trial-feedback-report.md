# Trial feedback report

Append the relevant sections to [Agent handback](agent-handback.md) and return
one self-contained response. Use the campaign module for fresh executions and
comparisons; use the derived module for replay, reanalysis or reassessment.
For a mixed task, keep those populations and identities separate.

This is a reporting contract, not authority to run sessions, judge, change
acceptance criteria, publish or adopt a candidate. The task prompt and frozen
plan define those decisions. Omit modules that do not apply.

## Authoring and interpretation rules

- Freeze acceptance criteria, weights, guardrails, denominators, judging and
  stopping rules before scored sessions. If absent, report Not defined; do not
  invent them after seeing outcomes.
- Report raw counts and individual acceptance criteria alongside aggregates.
  A weighted score expresses priorities; it does not establish reliability,
  equivalence or causation in a small sample.
- Keep useful creates, useful updates, unnecessary correct notes, duplicates,
  misleading content, primary-task completion and policy breaches distinct.
- Keep raw no-write restraint, required consultation, plugin-mediated route
  compliance and combined scenario success distinct. A filesystem read can
  establish content access while failing a plugin-specific criterion.
- Preserve historical verdicts. A new weighting or assessment of old evidence
  is a separately labelled retrospective analysis, not a fresh result.

## Acceptance criteria and weighted utility

Populate from the frozen plan; this template chooses no numerical defaults.
State whether weights were selected prospectively or retrospectively.

| Criterion | Evidence / unit | Weight | A count / denominator | B count / denominator | Contribution A / B |
| --- | --- | --- | --- | --- | --- |
| Useful verified create | {{definition}} | {{weight}} | {{}} | {{}} | {{}} |
| Useful verified update | {{definition}} | {{weight}} | {{}} | {{}} | {{}} |
| Unnecessary but correct note | {{definition}} | {{weight}} | {{}} | {{}} | {{}} |
| Duplicate note | {{definition}} | {{weight}} | {{}} | {{}} | {{}} |
| Misleading or unsupported content | {{definition}} | {{weight}} | {{}} | {{}} | {{}} |
| Primary-task failure | {{definition}} | {{weight}} | {{}} | {{}} | {{}} |

Add or remove rows to match the plan. Define the counting unit, overlapping
categories, precedence and whether distinct consequences may both contribute.
Do not count one defect several times without an explicit rule. Unknown
semantic quality must not silently become a zero penalty or an accepted note;
state coverage and how missing assessments affect the score.

| Scoring item | Frozen value / actual result |
| --- | --- |
| Policy version / selection timing | {{identity; prospective or retrospective}} |
| Utility formula and normalisation | {{formula; denominator; missing-data rule}} |
| Adoption / further-investigation threshold | {{rule or Not defined}} |
| Non-compensable guardrails | {{criteria and observed breaches, or Not defined}} |
| Weighted result and B minus A | {{score and population}} |
| Sensitivity / practical uncertainty | {{assumptions that affect interpretation}} |

Do not infer adoption from weighted utility alone. Report the frozen decision
rule, uncertainty and guardrail outcomes; keep evidence separate from the
recommendation. A reporting template does not set a zero-regression policy.

# Additional section: campaign results


## Frozen setup and execution

| Item                  | Actual value                                |
| --------------------- | ------------------------------------------- |
| Question / hypothesis | {{frozen question}}                         |
| Workhorse             | {{resolved provider/model}}                 |
| Judge                 | {{resolved provider/model}}                 |
| Arm identities        | {{code/config SHA/hash per arm}}            |
| Changed variable      | {{exact intervention or none}}              |
| Fixed inputs          | {{prompt/fixture/rubric/policy identities}} |
| Runtime / image       | {{actual identities}}                       |
| Schedule              | {{reference and deviations}}                |
| Window                | {{actual start/end, timezone}}              |
| Budget                | {{deadline/limit and whether reached}}      |

For comparisons, state whether all scored arms were fresh.
Keep historical baselines separate.

## Controls

| Control     | Arm/config   | Attempts  | Criterion evidence   | Outcome               |
| ----------- | ------------ | --------- | -------------------- | --------------------- |
| {{control}} | {{identity}} | {{count}} | {{operation/result}} | {{pass/fail/not run}} |

State whether controls preceded natural sessions.
Explain the consequence of any failed control.

## Per-task results

| Task     | Arm     | Planned | Attempted | Completed | Usable | Primary pass | Gate pass | Gate blocked | Semantic P/F/JE/NJ | Combined/planned | Combined/usable |
| -------- | ------- | ------- | --------- | --------- | ------ | ------------ | --------- | ------------ | ------------------ | ---------------- | --------------- |
| {{task}} | {{arm}} | {{N}}   | {{N}}     | {{N}}     | {{N}}  | {{N}}        | {{N}}     | {{N}}        | {{counts}}         | {{x/N}}          | {{x/N}}         |

Adapt “primary pass” only where a separate practical task exists.
Define every denominator. Label eligible-only rates separately.

For a standard pipeline over evaluated usable trials, reconcile:

- Gate pass + gate blocked = evaluated usable trials.
- P + F + JE = eligible trials for which judging was attempted.
- P + F + JE + NJ = evaluated usable trials; explain eligible but unjudged cases.
- Combined success follows the frozen definition, including primary-task and
  policy requirements where applicable, as well as gate and semantic acceptance.

Show attempted-population and usable-only tables separately when invalid or
unusable attempts have recorded gate/primary outcomes. Locate every excluded
attempt and explain its disposition; do not force attempted totals to equal
usable totals. Define P (pass), F (fail), JE (judge error), NJ (not judged).

If the pipeline differs, explain the accounting instead of forcing equality.

For interrupted or unusable sessions, account for the difference between
attempted and usable explicitly.

## Behaviour and guardrails

Report the measures selected in the frozen plan:
- Required mutations and useful completed documents.
- Proposal-only / zero-write outcomes.
- Appropriate restraint and unnecessary documentation.
- Preservation, duplicates, unsupported claims and policy violations.
- Verified plugin recording versus filesystem-only recording.
- Native/nested/shell attempts and verified results.

Do not infer document count from filesystem entry count.
Do not call unjudged content semantically correct.

## Comparison, if applicable

| Task     | A outcome | B outcome | B − A                           | Paired outcomes                |
| -------- | --------- | --------- | ------------------------------- | ------------------------------ |
| {{task}} | {{x/N}}   | {{y/N}}   | {{count and percentage points}} | {{A-only/B-only/both/neither}} |

Keep positive recording, restraint and primary-task quality separate.
Report exact counts before interpreting small samples.

## Judge exposure and provenance

| Exposure dimension | Directly supplied | Accessible | Observed accessed | Evidence / limit |
| --- | --- | --- | --- | --- |
| Arm / treatment identity | {{}} | {{}} | {{}} | {{}} |
| Hypothesis / expected winner | {{}} | {{}} | {{}} | {{}} |
| Other trials / original verdicts | {{}} | {{}} | {{}} | {{}} |

Describe prompt, cwd, mounts, tool/network access and actual isolation checks.
A request to ignore labels is not an enforced access boundary. Labels in a path
are not proof the judge knew their treatment meaning. Keep trial-agent exposure
separate from judge exposure. State Unknown when capture cannot establish it.

For blinded reassessment, preserve original verdicts and report neutral-ID
mapping isolation, evidence transformations, all transitions, errors and
breaches. Repeated verdict differences do not by themselves establish
label-caused bias; agreement does not prove bias was impossible.


- Eligible trials: {{N}}.
- Judge attempts: {{N}}, with model and attempt identifiers.
- Reused assessments: {{N and validation basis}}.
- Errors/retries: {{counts and dispositions}}.
- Rubric identity: {{hash/reference}}.
- Judge evidence: {{actual material supplied}}.

Preserve original verdicts.
Any manual disagreement is a separate assessment layer.

## Capture, integrity and costs

Capture:
{{Assigned configuration, plugin loading, established content delivery,
actual use, unmatched evidence and criterion impact.}}

Integrity:
{{Manifest/receipt checks, counts covered, result and explicit exclusions.}}

| Phase    | Calls/steps | Input | Output | Reasoning | Cache-read | Estimate |
| -------- | ----------- | ----- | ------ | --------- | ---------- | -------- |
| Controls | {{}}        | {{}}  | {{}}   | {{}}      | {{}}       | {{}}     |
| Trials   | {{}}        | {{}}  | {{}}   | {{}}      | {{}}       | {{}}     |
| Judges   | {{}}        | {{}}  | {{}}   | {{}}      | {{}}       | {{}}     |

Define token fields where provider accounting may overlap.
Use unknown for unavailable telemetry.

Recorded step cost: {{value}}.
Actual billing: {{known value or unavailable}}.
List-price estimate: {{basis and limitations}}.

# Additional section: derived results

| Identity              | Value                                  |
| --------------------- | -------------------------------------- |
| Original execution    | {{SHA and evidence root}}              |
| Original measurement  | {{version}}                            |
| Repaired measurement  | {{SHA/version}}                        |
| Reanalysis population | {{complete declared population}}       |
| Original integrity    | {{before/after result and exclusions}} |

| Trial/item | Original outcome | Derived outcome | Reason changed |
| ---------- | ---------------- | --------------- | -------------- |
| {{ID}}     | {{outcome}}      | {{outcome}}     | {{evidence}}   |

Report:
- Original and derived aggregate tables.
- Every changed verdict.
- Unchanged failures and unresolved records.
- Reused/new judge provenance.
- Confirmation that originals were preserved.

Label this derived measurement, not a fresh execution baseline.
