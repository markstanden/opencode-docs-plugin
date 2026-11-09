---
Area: Testing
Keywords: automatic-notetaking, note, proposal, standing-permission, fixtures, experiment-spec, note-01, note-02, note-03, note-04
Summary: Draft four-scenario specification for automatic notetaking during ordinary work: two positive cases requiring one useful note or correction, and two restraint cases where the correct behaviour is no lasting documentation mutation; includes literal prompts, synthetic fixtures, scoring groups, standing permission, capture gaps and later baseline/comparison rules.
---

# Automatic-notetaking experiment: four-scenario specification, draft 2026-11-09

## Status and scope

Draft for review before implementation. No active corpus, production plugin,
harness, historical D02/D03 definition or policy was changed. No model
session, control or campaign was run. IDs are draft and are not added to the
scenario naming map until implementation.

The product behaviour under test is active automatic notetaking during
ordinary work: recognise useful knowledge and preserve it when authorised,
without a task-level documentation request. Restraint is part of the same
behaviour: do not create unnecessary notes or duplicates. The experiment
therefore has two positive scenarios and two restraint scenarios, reported
separately. An always-write strategy must fail the restraint group; a
never-write strategy must fail the positive group.

## Common fixture and permission

Every scenario uses the same small Node project layout:

```
work/                     ordinary task workspace (the session cwd)
work/AGENTS.md            standing permission, identical bytes in every case/arm
lakes/docs/               configured repository knowledge lake (writable)
config-home/opencode/     harness-generated session config (not a task surface)
```

The standing permission is loaded from `work/AGENTS.md`:

> You may create or update repository documentation within the configured
> documentation lake as part of your work, without further confirmation. Keep
> changes within the permitted workspace.

It is a permission, not an instruction to document every task. It is
byte-identical in every scenario and both later arms. It names no filename, no
finding, no expected note and no experimental criterion. The permission is not
an arm-specific treatment.

Proposed sandbox profile for implementation: shell and edit may operate inside
`work/**`; writes through the docs tool, or by shell/edit, may target
`lakes/docs/**`; every other path is out of policy. This is a **future
per-case permission profile**: the current harness applies a global
`SANDBOX_PERMISSIONS` that denies shell and edit, so these scenarios cannot run
their practical tasks under the existing global set. See “Implementation
gaps”.

All facts, logs, code and documents below are synthetic. No real user files,
credentials or secrets are used.

## NOTE-01 — Diagnose the retry boundary

**Draft display name:** NOTE-01 — Diagnose the retry boundary (positive
create). **Draft id:** `NOTE-01`.

### Literal user prompt

> Webhook deliveries from `src/consumer.ts` are sometimes handled twice after a
> timeout. `src/retry.ts` currently allows five attempts. Work out the safe
> retry boundary for this consumer and make the smallest change that stops the
> duplicate handling. Run `npm test` when done.

No documentation request, no note request, no lake or filename.

### Proposed fixture tree

```
work/AGENTS.md
work/package.json
work/src/retry.ts
work/src/consumer.ts
work/test/retry.test.ts
work/logs/retry-trace.log
work/README.md
lakes/docs/ops/on-call.md          seeded unrelated document, must be preserved
```

`work/package.json`:

```json
{
    "name": "webhook-fixture",
    "private": true,
    "type": "module",
    "scripts": { "test": "node --test" }
}
```

`work/src/retry.ts`:

```ts
export const maxAttempts = 5;

export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
        try {
            return await operation();
        } catch (error) {
            attempt += 1;
            if (attempt >= maxAttempts) throw error;
        }
    }
}
```

`work/src/consumer.ts` (before the fix):

```ts
import { withRetry } from "./retry.ts";

let deliveries = 0;

export async function handle(event: { id: string; payload: string }) {
    await withRetry(async () => {
        // Synthetic transport: the fixture test replays evt_42 after a reconnect.
        deliveries += 1;
    });
}

export function deliveryCount() {
    return deliveries;
}
```

The synthetic transport in `work/test/retry.test.ts` replays `evt_42` once
after the third successful attempt. The test asserts the handler observes one
delivery, not two, and imports `maxAttempts` to require three. It fails before
the fix and passes after capping at three and deduplicating by `event.id`.

`work/logs/retry-trace.log`:

```text
2026-01-14T09:12:01Z attempt=3 event=evt_42 result=ok
2026-01-14T09:12:02Z reconnect transport=queue-sdk
2026-01-14T09:12:03Z attempt=4 event=evt_42 result=duplicate
2026-01-14T09:12:03Z sdk=@acme/queue@2.4.1 delivery=at-least-once
```

`work/README.md` contains the ordinary clue, not a labelled finding:

```markdown
# Webhook fixture

Run `npm test`. The queue SDK is at-least-once; consumers must ignore repeated
event IDs. Retry behaviour lives in `src/retry.ts`.
```

`lakes/docs/ops/on-call.md` is an unrelated seeded document (rotation and
escalation); it must survive untouched.

### Durable or not durable

Durable: the repository-specific boundary of three attempts for this consumer,
the reconnect/replay reason, the at-least-once SDK behaviour, and the required
dedupe by event ID. These are non-obvious, reusable facts tied to this
repository and SDK version.

Not durable: the raw timestamps, the failing test's transient output, and any
claim that the SDK itself requires three attempts everywhere. The evidence
does not support a universal SDK rule.

### Primary task and decisive check

Expected primary result: `src/retry.ts` uses a three-attempt boundary and
`src/consumer.ts` ignores a repeated `event.id`; the test suite is green.

Decisive check (host-side, after the session, against `live/work`):

1. copy `live/work/src` plus the **pristine** `test/retry.test.ts` from the
   generated fixture into a temporary directory;
2. run `npm test` there and require exit 0;
3. require a test named `replays after reconnect without duplicate delivery`
   to pass;
4. inspect that the retry boundary is three and the consumer's dedupe is
   present (or prove equivalent behaviour with the pristine test).

Using the pristine test prevents a model from deleting or weakening the check.

### Allowed surfaces and policy

- Task code: `work/src/retry.ts`, `work/src/consumer.ts`.
- Documentation: any path under `lakes/docs/**` (one new doc expected).
- Tests: `work/test/**` is **not** an allowed mutation; the pristine test is
  the check.
- Policy: allow `work/src/**` and `lakes/docs/**`; require at least one
  document write; preserve `lakes/docs/ops/on-call.md`.
- Gate expectation: `expectedDocs.kind: "create"` with no target (one new
  Markdown document anywhere in the docs surface), structural validity,
  required content tokens chosen at implementation (for example `retry`,
  `three`, `duplicate`), and the seeded on-call doc in `preserve`.

### Hidden scoring

Pass: practical test green, one useful new repository note, policy compliant.
The note names the three-attempt boundary, the reconnect/replay reason, the
at-least-once SDK and dedupe requirement, and scopes the claim to this
repository/SDK. It need not use an exact filename; a justified destination
under the repository lake is enough.

Fail: no note; a code comment/test only; a note saying five attempts or an
unqualified "SDK requires three everywhere"; a duplicate/wrong-scope note; a
practical fix that does not stop the duplicate.

Policy violation: mutation outside `work/src/**`/`lakes/docs/**`, test edits,
or a docs write outside the lake.

## NOTE-02 — Correct the stale setup rule

**Draft display name:** NOTE-02 — Correct the stale setup rule (positive
update). **Draft id:** `NOTE-02`.

### Literal user prompt

> `npm run setup` now fails on Node 24 because `scripts/check-node.mjs` still
> requires Node 22. Make setup succeed on Node 24.

No documentation request.

### Proposed fixture tree

```
work/AGENTS.md
work/package.json
work/scripts/check-node.mjs
work/.nvmrc
work/README.md
lakes/docs/setup/node-version.md     seeded stale note, expected replacement
lakes/docs/ops/release.md            seeded unrelated note, preserve
```

`work/package.json` scripts: `"setup": "node scripts/check-node.mjs"`,
`"test": "node --test"`; engines currently `"node": ">=22"`.

`work/scripts/check-node.mjs`:

```js
const major = Number(process.versions.node.split(".")[0]);
if (major !== 22) {
    console.error(`setup requires Node 22, found ${process.version}`);
    process.exit(1);
}
console.log(`setup ok on ${process.version}`);
```

`work/.nvmrc` contains `22`.

Seeded `lakes/docs/setup/node-version.md`:

```markdown
---
Area: Setup
Keywords: node, version, nvm, setup
Summary: This repository uses Node 22; setup enforces it.
---

# Node version

- Use nvm.
- This repository uses Node 22.
- `npm run setup` enforces the version.
- CI reads `.nvmrc`.
```

The note's other facts (nvm, setup, CI) must survive; only the version changes.

### Durable or not durable

Durable: the supported Node version and the corrected setup rule, as a
repository decision; the existing note is the right home. Not durable: the
one-off command output and the transient failure message.

### Primary task and decisive check

Expected primary result: `npm run setup` exits 0 on Node 24; `check-node.mjs`,
`.nvmrc` and the package engine agree on 24.

Decisive check:

1. run `npm run setup` in `live/work` and require exit 0;
2. read `.nvmrc` and require `24`;
3. run a small version assertion against `check-node.mjs` (or invoke it) and
   require it accepts 24;
4. inspect the replaced note: it contains 24, the seeded claim that the
   repository uses 22 has not survived, and the nvm/CI facts are retained.
   A corrected note may discuss Node 22 as rejected; the deterministic gate
   checks that the seeded claim did not survive verbatim, and the semantic
   judge decides whether the note still presents 22 as current.

### Allowed surfaces and policy

- Task code/config: `work/scripts/check-node.mjs`, `work/.nvmrc`,
  `work/package.json`.
- Documentation: exactly `lakes/docs/setup/node-version.md` (replace in place).
- No new document; `lakes/docs/ops/release.md` preserved.
- Policy: allow those four paths; require the note replacement; no other
  mutation.
- Gate expectation: `expectedDocs.kind: "replace"`, target
  `setup/node-version.md`, `retains` for the surviving nvm/CI statements,
  `omits` for the old Node 22 claim (the seeded claim line must not survive;
  corrective discussion of the rejected version is eligible), `preserve` for
  `ops/release.md`.

### Hidden scoring

Pass: setup green, code/config corrected, existing note updated in place,
unrelated content preserved, no duplicate.

Fail: code fix only (missing required update); a new `node-24.md` duplicate;
deleting or rewriting the note without its unrelated facts; leaving the stale
claim that the repository uses Node 22; changing unrelated files.

Policy violation: mutation outside the allowed paths or a new document where
the case requires replacement.

## NOTE-03 — Handle the interrupted run

**Draft display name:** NOTE-03 — Handle the interrupted run (restraint,
transient). **Draft id:** `NOTE-03`.

### Literal user prompt

> `npm test` is failing after the last run was interrupted. Get the suite green
> again; don't change the tests.

No documentation request.

### Proposed fixture tree

```
work/AGENTS.md
work/package.json
work/src/sum.ts
work/test/sum.test.ts
work/.tmp/run.lock                 stale lock from the interrupted run
work/.tmp/last-run.log             interrupted-run marker
lakes/docs/ops/on-call.md          seeded unrelated note, preserve
```

`work/.tmp/run.lock` contains `pid 99999`; `work/test/sum.test.ts` fails while
the lock exists because the test harness refuses to start a run with a stale
lock. `work/src/sum.ts` and the test are correct. Removing `.tmp/run.lock` and
rerunning `npm test` is the whole fix. The lock is session-local, not a
repository condition or an unresolved incident.

### Durable or not durable

Not durable: the stale lock, the interruption, the one-off pid, and the
transient command output. A note saying “delete `.tmp/run.lock` when tests
fail” would be a generic session-cleanup note, not reusable repository
knowledge. There is no unresolved diagnosis worth preserving.

If reviewers consider this premise too close to a runbook entry, substitute a
`node_modules/.cache` entry corrupted by the current session: removing it and
rerunning is routine, no durable fact remains.

### Primary task and decisive check

Expected primary result: `npm test` exits 0; source and tests are unchanged;
the stale lock is gone.

Decisive check:

1. run `npm test` in `live/work`; require exit 0;
2. hash `src/**` and `test/**` before and after; require no change;
3. require `.tmp/run.lock` absent;
4. require no docs mutation.

### Allowed surfaces and policy

- Task surface: `work/.tmp/**` only (removing the lock is permitted).
- Documentation: `lakes/docs/**` is writable by the standing permission, but
  no documentation mutation is expected or successful.
- Policy: allow `work/.tmp/**` and `lakes/docs/**`; forbid any docs mutation
  (restraint gate); any source/test/work mutation outside `.tmp` is a policy
  violation.
- Gate expectation: `forbidDocsMutations` (future support); no `expectedDocs`
  write expectation.

### Hidden scoring

Pass: suite green, no source/test change, no docs mutation.

Fail (behavioural restraint): a new or updated note about the transient lock,
even if it is inside the permitted lake. This is not a policy violation; the
permission allowed it, but it was unnecessary.

Policy violation: mutation outside `work/.tmp/**`/`lakes/docs/**`; editing
source or tests.

## NOTE-04 — Reuse the replay diagnosis

**Draft display name:** NOTE-04 — Reuse the replay diagnosis (restraint,
duplicate avoidance). **Draft id:** `NOTE-04`.

### Literal user prompt

> `npm run webhook:check` is reporting `EVENT_REPLAY`. Please get the webhook
> tests green without changing the replay fixture.

No documentation request.

### Proposed fixture tree

```
work/AGENTS.md
work/package.json
work/scripts/webhook-check.mjs     deliberate replay diagnostic
work/test/fixtures/replay.json     fixed replay fixture
work/test/webhook.test.ts          passing webhook tests
lakes/docs/ops/webhook-debugging.md  correct existing note, must be preserved
lakes/docs/ops/on-call.md            unrelated note, preserve
```

`work/scripts/webhook-check.mjs` reads `test/fixtures/replay.json` and exits
17 with `EVENT_REPLAY`. This is deliberate: it is a diagnostic, not a failing
webhook test.

Seeded `lakes/docs/ops/webhook-debugging.md`:

```markdown
---
Area: Ops
Keywords: webhook, replay, EVENT_REPLAY, tests
Summary: EVENT_REPLAY from webhook:check is a deliberate replay diagnostic; run the webhook tests instead of editing the fixture.
---

# Webhook replay check

### Facts

- `npm run webhook:check` exits 17 with `EVENT_REPLAY` when the replay
  fixture is present.
- This is expected; it is a diagnostic, not a failing webhook test.
- Run `npm test -- webhook` to validate the webhook handler.
- Do not edit `test/fixtures/replay.json` or the check script.
```

The note is correct and complete. The run output adds no new fact: same error,
same cause, same command, same prohibition. No update or duplicate is
justified.

### Durable or not durable

Durable: already recorded; nothing new. Not durable: the repeated
`EVENT_REPLAY` output and the current run's timestamps. An update would be
duplication or a gratuitous change.

### Primary task and decisive check

Expected primary result: `npm test -- webhook` exits 0; the replay fixture,
check script and tests are unchanged; the existing note is unchanged; no new
note.

Decisive check:

1. run `npm test -- webhook` in `live/work`; require exit 0;
2. hash `test/fixtures/replay.json`, `scripts/webhook-check.mjs`,
   `test/webhook.test.ts` and `lakes/docs/ops/webhook-debugging.md` before and
   after; require no change;
3. require no new or modified docs file;
4. require a verified docs read of `ops/webhook-debugging.md` (hidden
   `docsCriterion`) so consultation is observable.

### Allowed surfaces and policy

- Task surface: no work mutation expected; the fixture and check script must
  remain byte-identical.
- Documentation: `lakes/docs/**` is writable by the standing permission, but
  no docs mutation is successful.
- Policy: allow `lakes/docs/**`; no work mutation allowed. Any work mutation
  is a policy violation. Any docs mutation is a restraint failure (permitted
  but unnecessary), not a policy violation.
- Gate expectation: `forbidDocsMutations` (future support); `docsCriterion`
  read of `ops/webhook-debugging.md`; no `expectedDocs` write.

### Hidden scoring

Pass: tests green, fixture/check/note unchanged, no duplicate, verified note
read.

Fail (behavioural restraint): a new note restating `EVENT_REPLAY`; an update
to the existing note with the same facts; editing the fixture or check to make
`webhook:check` exit 0; no note read.

Policy violation: a work mutation outside the permitted surface.

## Scoring model

Keep these distinct:

| Measure                                   | Definition                                                                                                                        | Evidence                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Primary task completion                   | The scenario's practical job passes the decisive check.                                                                           | Host-side check against `live/work` with pristine tests.   |
| Observable recognition/proposal           | The final answer names the useful knowledge as something to preserve, without being told to.                                      | Judge on the final answer; secondary to actual recording.  |
| Attempted recording                       | A docs add/replace attempt, a Code Mode nested attempt, or a shell/edit write attempt inside the docs surface.                    | `tools.jsonl`, journal, mutation snapshot.                 |
| Useful completed document creation/update | Exactly the required one new doc or in-place update, structurally valid, with the required facts and preserved unrelated content. | `expectedDocs` gate plus judge.                            |
| Verified plugin-mediated recording        | The create/update was served by the docs plugin and is journal-attributed or observable as a native/twin docs operation.          | `docs-operations.jsonl`, native/twin telemetry.            |
| Appropriate restraint                     | Restraint case: no unnecessary docs mutation.                                                                                     | `forbidDocsMutations` plus judge.                          |
| Duplication                               | A new near-duplicate of an existing correct note, or a gratuitous update that adds no fact.                                       | Mutation snapshot, note comparison, judge.                 |
| Unsupported claim                         | A note generalises beyond the evidence, or promotes a repo-local finding to an organisation-wide rule.                            | Judge; deterministic content expectations where practical. |
| Policy violation                          | Mutation outside the scenario's permitted paths.                                                                                  | Mutation snapshot/policy.                                  |
| Gate-blocked semantic                     | A required gate expectation failed, so the semantic judge did not run.                                                            | `verdict: invalid`; semantic outcome unknown.              |

A useful shell-written note is a filesystem success but **not** proof of
plugin-mediated recording. If the implementation allows shell/edit, report the
route separately; do not ban alternative routes to inflate plugin adoption and
do not count a filesystem note as plugin use.

Positive primary success requires **practical task + useful required
note/update + policy compliance**. Restraint primary success requires
**practical task + no unnecessary documentation mutation + policy
compliance**. Report positive and restraint groups separately; do not collapse
them into one aggregate. A permitted but unnecessary note is a behavioural
restraint failure; an out-of-scope mutation is a policy violation; they are
not the same.

Gate-blocked trials are not semantic failures. If a positive note is
out-of-policy, the gate blocks it and the semantic outcome remains unknown
unless separately reviewed.

The judge must receive the actual resulting document and relevant task
evidence, not only the final answer. The existing `expectedDocs` gate already
supplies bounded document excerpts to the judge; the campaign should add the
primary-check output and changed-path summary to the judge evidence. That is a
campaign-level addition, not a production-harness change.

## Minimum capture and gate support

Existing and sufficient:

- docs tool journal, native/twin telemetry and Code Mode attribution;
- mutation snapshot with path policy, `.docs-lock` housekeeping, and
  `expectedDocs` create/replace with `retains`, `omits`, `link`, `preserve`;
- `docsCriterion` verified read for NOTE-04;
- prepared-tree certificate and frozen `run.json`;
- final answer and judge artefact excerpts.

Necessary future changes, none implemented here:

1. **Per-case task permissions.** The current global sandbox profile denies
   shell and edit; the positive scenarios need ordinary workspace edits. Add a
   permission profile that allows shell/edit inside `work/**` and docs writes
   inside `lakes/docs/**` for these cases only.
2. **Restraint gate.** Add `expectedDocs.kind: "none"` or a
   `forbidDocsMutations` gate for NOTE-03/NOTE-04, so a permitted but
   unnecessary docs write fails the restraint case without being mislabelled a
   policy violation. Existing `expectedDocs` only expresses create/replace.
3. **Primary-check runner.** A campaign-level script runs the pristine
   scenario test/setup against `live/work` after the trial, records the exit
   code and changed-path summary, and feeds it to the judge. Existing live-tree
   capture is sufficient; no harness rewrite is required.
4. **Judge evidence.** Include the primary-check output and the resulting
   document excerpt; keep the final answer separate from task evidence.

## Later baseline and comparison

Proposed later baseline (not now): five repetitions per scenario, twenty
natural trials, plus one first-attempt A01 help control and one exact seeded
read control. Controls are unjudged and excluded from denominators.

Proposed later prose comparison, only if the baseline warrants it: five
repetitions per scenario per arm, forty fresh interleaved trials. Both arms
retain identical task prompts, standing permission, seeds, rubric, policies
and repaired measurement code. The historical D02/D03 baseline is context, not
arm A. Use one general prose intervention in one delivered surface, with no
fixture-specific answers. Do not grant permission only to the treatment arm.
Freeze the schedule and decisions before scored sessions; no outcome-driven
retries and no extra repetitions.

## Material unresolved decisions

1. Approve the per-case shell/edit permission profile, or accept that the
   positive scenarios need a different task shape.
2. Approve a restraint gate (`expectedDocs.kind: "none"` /
   `forbidDocsMutations`), or accept judge-only restraint scoring.
3. Choose the single prose surface for the later comparison after the
   baseline; this spec does not select or tune candidate prose.
4. Confirm the primary-check runner's location and whether its output enters
   the judge prompt.

## Facts

- The four scenarios are synthetic and small enough for a straightforward
  fixture implementation.
- Positive cases require one useful create or in-place update; restraint
  cases require no lasting documentation mutation.
- The same standing permission is present in every case and both arms.
- The current sandbox permissions and `expectedDocs` shape need the changes
  listed above before execution.

## Inferred

- Separating positive and restraint groups prevents an always-write or
  never-write policy from appearing successful in a single aggregate.
- Requiring a verified plugin-mediated recording as a separate measure keeps
  adoption visible without treating a shell-written note as plugin use.
- The D03 proposal rubric is not the primary measure for this experiment; the
  product behaviour is a completed, useful document, not a proposal sentence.

## Tested

- None; this is a specification. No fixture, campaign or model session was
  created or run.

## Failed approaches

- None yet. The draft deliberately avoids a fixed new-note filename, a
  task-level documentation request, a fixture-specific answer, and a
  treatment-only permission.

## Open questions

- Is the transient lock in NOTE-03 sufficiently non-durable, or should the
  premise be the session-local cache corruption alternative?
- Should NOTE-04 require the verified note read as a gate, or report
  consultation separately from primary-task success?
- Will a later prose intervention have uniform delivery across non-callers?
  Existing capture cannot establish native tool-definition delivery without a
  call; this remains a measurement limitation.

## Artefacts

- This specification: `docs/testing/automatic-notetaking-experiment-spec-2026-11-09.md`.
- Scoring correction and boundary review:
  `docs/testing/notice-scoring-and-boundary-review-2026-11-09.md`.
- Corrected historical findings:
  `docs/testing/notice-natural-baseline-2026-11-09.md`.
