---
Area: Testing
Keywords: placement-harness, generateCase, redaction, id-only-case-list, prompt-staleness, kept-check
Summary: Placement harness kept check: content-compares prompts for full cases, must stay existence-based for the run container's id-only case list — computing the template there crashes or silently corrupts mounted prompts.
---

# Placement harness prompts regenerate by content — except in the redacted run container

## Facts

- `generateCase` decides kept vs created by comparing the on-disk prompt's
  bytes against the current `promptFor` template, but only when the case is
  full (`testCase.claim !== undefined`). A template or variant change thus
  regenerates prompts without `--force`, and a repeat generate is a no-op.
- The run container (`container-run.sh run`) mounts an id-only case list
  (`prepare_cases_run` strips everything but `id`) at `/fixtures/cases.json`,
  plus that case's prompt, config and sandbox; the harness call selects
  exactly that one id.
- For a redacted case `promptFor` cannot run at all: `testCase.destinations`
  is undefined, so the destinations `.map` throws. The template must never be
  computed on that path (the `promptComparable` guard).
- If the kept check ever compared content for a redacted case, every real
  mounted prompt would look stale and the fall-through would overwrite it
  with `undefined`-filled garbage before `runOne` reads it — silent trial
  corruption, not a crash.
- In the run container exactly one id is selected per harness call and its
  mounts exist, so the existence-based kept check returns there; the
  all-cases fall-through crash seen in the smoke cannot occur in a real run.

## Failed approaches

- Unconditional `const promptText = promptFor(testCase, options)` in
  `generateCase`: crashes on the redacted list ("destinations is not
  iterable"). Caught by a host-side smoke mimicking the container call
  before any container minutes were spent.
- Content staleness without the redaction guard: an instrumented smoke run
  showed E01/E02 judged stale and E03 falling through to `buildFixtureTree`
  with no destinations.
- Existence-only staleness across variant switches: the discovery variant
  would have silently reused the destinations-embedded prompts from the
  previous sweep, running the wrong experiment under the new stamp.

## Tested

- Host smoke: non-discovery generate byte-identical to the fixture-check-1
  prompts (E01, E02 diff clean); `--discovery` → created; repeat → kept;
  non-discovery again → created.
- Redacted smoke with the id-only fixture, one id: kept, exit 0, prompt
  bytes untouched (hash equal).
- Container `run E01` with the changed harness: exit 0, writes 0.

## Inferred

- Any future `generateCase` feature must pick a side of the redaction line:
  full-case knowledge (template, staleness, destinations) is unavailable in
  the run container; only mounted-surface existence checks work there.
