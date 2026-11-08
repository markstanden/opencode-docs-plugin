---
Area: testing
Keywords: telemetry, code-mode, docs_search, execute, exposure, attempted, dedup, tool, trail
Summary: Docs telemetry separates native calls, the twin name and code-mode attempts; nested code-mode docs operations count as attempted, never verified.
---

# Code Mode docs operations are attempted, not verified

### Facts

- The plugin registers a native `docs` tool and a Code Mode twin
  `docs_search`; the twin's calls are NOT separate CLI events — they are
  outer `execute` tool calls whose `input.code` text mentions
  tools.docs.docs_search(…). Source-code regexes cannot prove nested
  execution: an unobserved nested operation is unknown, never success, and
  dead code mentioning the twin (`if (false) { … }`) proves nothing.
- The harness's docs telemetry reports each docs surface at two levels:
  attempted operations (any status, plus code-mode attempts by code text)
  and verified completions (observable native or twin operations that
  actually completed). Deduplication of multi-event tool calls keys on the
  call id. A code-mode entry is always "attempted"; its nested success is
  unknown and never reported as verified, because the CLI emits no event
  for the nested call. Every retrieval-facing docs gate consumes verified
  completions only: a failed or denied read, and a completed outer execute
  whose nested call cannot be observed, make a verified criterion
  inconclusive — recorded as `invalid` with the reason, never a pass.
- Retrieval gates can name the relevant document (`paths`): a completed
  read of some unrelated document does not satisfy a relevant-path
  criterion. Legacy saved definitions using `minDocsCalls` keep their
  historical attempted-operations semantics at judge time, with the label
  visible in the reason — never silently reinterpreted.
- Exposure classification labels each rule hit with the entry's completion;
  a failed read of a rubric path renders `<label> (attempt)`, and a missing
  trail renders "no trail" rather than a benign zero. The Discovery column
  now reports verified help use (`help×N`) apart from attempted help
  (`no help (N attempted)`).
- Near-zero docs-call counts in a trail say nothing about code-mode usage;
  historical zero-call cases must not be read as evidence the twin was (or
  was not) used — that remains a measurement limitation of those stamps.

### Tested

- `tests/harness.test.ts` F07 + M04 groups: duplicate pending/completed
  events dedup, twin detection, attempted-not-verified, error-status
  labelling, unparsable lines surfaced, absent trail rendering, and
  truncated dossier projections advertising themselves as projections; plus
  the M04 counterexamples (denied read, unrelated read, code-mode-only
  inconclusive, dead-code discovery) all failing against the pre-fix
  harness and passing after.
