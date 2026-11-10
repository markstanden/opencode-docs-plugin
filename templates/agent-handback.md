# Agent handback

Use this template for review, design, implementation and shipping handbacks.
For trials or reanalysis, append the relevant sections of
[Trial feedback report](trial-feedback-report.md) to the same response.

This is an output contract, not authority to perform additional work.
The task prompt supplies scope, permissions and stopping conditions.

## Instructions for the prompt author

Include the core sections and only the additional modules needed for the task.
Remove unused modules and authoring notes. Do not require irrelevant tables.

Add this instruction to the execution prompt:

> Return one self-contained final handback suitable for a single copy and paste
> into the reviewer chat. Populate it from inspected evidence. Distinguish
> verified facts, earlier reports and inference. Mark missing information
> explicitly. Do not perform extra work merely to fill an optional field.

## Rules for the responding agent

- Lead with the outcome and material limitation.
- Include decisive excerpts or diff hunks needed to assess the result.
- Paths and links support the response; they do not replace required facts.
- Keep bulky evidence in named artefacts. A dev-box path or local-only branch
  is not automatically accessible to the reviewer.
- Use full commit SHAs in identity tables. Separate implementation, execution,
  measurement and findings revisions where relevant.
- Distinguish checks run now, earlier checks reused and CI observed at a pinned
  SHA. Never claim an inspection, check or external action without evidence.
- Preserve original results and label corrections or derived interpretations.
- Redact credentials and signing keys.

Use these labels accurately:

| Label          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| Not run        | Execution or check was not performed.                        |
| Not applicable | The field does not apply; explain if unclear.                |
| Unknown        | Evidence does not establish the answer.                      |
| Blocked        | Name the blocker and affected work.                          |
| Reported       | Supplied by another source, not independently verified here. |

Never use zero for unknown or unperformed work. Do not invent identities,
timestamps, counts, causes or accessibility.

# Core response contract

## Outcome

{{Completed / partially completed / blocked}}: {{concrete result}}.

{{Main finding or behaviour, and the most important limitation.}}

## Identity and working state

| Item                             | Actual value                                       |
| -------------------------------- | -------------------------------------------------- |
| Repository / checkout            | {{URL and actual local checkout}}                  |
| Branch                           | {{branch}}                                         |
| Starting HEAD                    | {{full SHA}}                                       |
| Reviewed or executed revision(s) | {{full SHA, clearly labelled by role}}             |
| Implementation commit(s)         | {{full SHA or not applicable}}                     |
| Findings commit                  | {{full SHA or not applicable}}                     |
| Current HEAD                     | {{full SHA}}                                       |
| Working tree                     | {{clean, or list relevant dirty/untracked paths}}  |
| Remote state                     | {{local only / pushed and verified ref / unknown}} |

Record implementation, execution and later findings revisions separately.
A findings commit is not automatically the code executed in a campaign.

## Scope and deviations

Completed:

- {{deliverable}}

Authorised work not completed:

- {{item and reason, or none}}

Material deviations:

- {{planned versus actual, reason, consequence, or none}}

External actions actually taken:

- {{push/PR/comment/merge/release/cleanup, with targets, or none}}

## Validation

| Check                   | Revision/scope | Result                | Evidence                        |
| ----------------------- | -------------- | --------------------- | ------------------------------- |
| {{command or CI check}} | {{SHA/files}}  | {{pass/fail/not run}} | {{output summary or link/path}} |

Separate:

- Checks run in this task.
- CI observed at a pinned SHA.
- Earlier results reused, with the reason they still apply.

If a check modifies files, report the repairs and their disposition.
For failures, give the decisive error and its consequence.

## Evidence and review access

| Artefact | Location                           | Accessibility                          | Purpose                 |
| -------- | ---------------------------------- | -------------------------------------- | ----------------------- |
| {{name}} | {{pinned URL, attachment or path}} | {{reviewer-accessible / dev-box only}} | {{what it establishes}} |

For unavailable underlying material, include the decisive excerpt, hunk or
scrubbed record in this handback or an accessible review packet.

Integrity:
{{What was checked, population covered, result and exclusions.
Use not applicable for tasks without preserved evidence.}}

## Limitations and next boundary

Established:

- {{conclusion directly supported by evidence}}

Unresolved:

- {{specific uncertainty and its practical effect}}

Recommended next action:
{{One bounded action, or no further action needed.}}

Further execution:
{{Stopped / continuing only within previously authorised scope.}}

# Additional section: review findings

Review target:
{{PR/range/files/evidence and exact revision}}.

| Severity             | Finding            | Trigger and consequence | Source                              |
| -------------------- | ------------------ | ----------------------- | ----------------------------------- |
| {{blocker/optional}} | {{specific issue}} | {{concrete example}}    | {{file/line or evidence reference}} |

For meaningful findings include:

- Reproduction or counterexample, if performed.
- Expected versus observed behaviour.
- Minimum suggested correction.
- Whether this is code, fixture, rubric, capture or interpretation.

Reviewer conclusion:
{{Ready / changes needed / inconclusive, with scope and limits.}}

“No findings” must state what was actually reviewed and what was not.

# Additional section: design decisions

| Decision     | Selected design     | Reason                 | Status                        |
| ------------ | ------------------- | ---------------------- | ----------------------------- |
| {{decision}} | {{concrete choice}} | {{evidence/trade-off}} | {{resolved / needs decision}} |

Implementation gaps:

- {{specific missing capability and smallest proposed addition}}

Acceptance:
{{Exact behaviour/checks that will establish completion.}}

Open decisions:
{{Only decisions that materially affect implementation or interpretation.}}

Do not present proposed fixtures, rubrics or controls as implemented.

# Additional section: implementation and validation

| Behaviour changed | Before             | After              | Affected surface     |
| ----------------- | ------------------ | ------------------ | -------------------- |
| {{behaviour}}     | {{trigger/result}} | {{trigger/result}} | {{files/API/config}} |

Boundary preserved:
{{Relevant compatibility, defaults and invariant evidence.}}

Regression proof:

- Before fix: {{test/counterexample and actual failure, if applicable}}.
- After fix: {{actual result}}.
- Negative boundaries: {{meaningful counterexamples checked}}.

Include the decisive diff hunk when it is small or central to review.
Do not dump unrelated code.

For prose-only changes:

- Give exact old/new text or the complete addition.
- Identify the changed model-visible surface.
- State which other relevant surfaces were checked unchanged.

# Additional section: external actions

| Action                | Target             | Pinned SHA | Outcome           | Evidence |
| --------------------- | ------------------ | ---------- | ----------------- | -------- |
| {{authorised action}} | {{ref/PR/release}} | {{SHA}}    | {{actual result}} | {{URL}}  |

Where applicable, distinguish:

- Reviewed head.
- Final PR head.
- Merge/squash commit.
- Deployment/release identity.

Report failed or rejected actions plainly.
Do not infer success from command submission alone.
