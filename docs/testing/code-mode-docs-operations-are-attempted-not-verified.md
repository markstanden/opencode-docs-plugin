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
  tools.docs.docs_search(…).
- The harness's docs telemetry counts native `docs`, the twin name
  `docs_search`, and executes whose code attempts the twin separately;
  deduplication of multi-event tool calls keys on the call id. A code-mode
  entry is "attempted"; its nested success is unknown and is never reported
  as verified, because the CLI emits no event for the nested call.
- Exposure classification labels each rule hit with the entry's completion;
  a failed read of a rubric path renders `<label> (attempt)`, and a missing
  trail renders "no trail" rather than a benign zero.
- Near-zero docs-call counts in a trail say nothing about code-mode usage;
  historical zero-call cases must not be read as evidence the twin was (or
  was not) used — that was a measurement limit in earlier sweeps.

### Tested

- `tests/harness.test.ts` F07 group: duplicate pending/completed events
  dedup, twin detection, attempted-not-verified, error-status labelling,
  unparsable lines surfaced, absent trail rendering, and truncated dossier
  projections advertising themselves as projections.
