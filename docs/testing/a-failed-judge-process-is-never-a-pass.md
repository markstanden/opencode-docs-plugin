---
Area: testing
Keywords: judge, process, verdict, pass, invalid, gate, harness, trial
Summary: A judge process that did not succeed, or an invalid verdict object, becomes a judge-error verdict — never a pass.
---

# A failed judge process is never a pass

### Facts

- The placement harness judge gate requires three things before any verdict
  gets a pass/fail pointer: the judge process completed (exit 0, no signal,
  no spawn error, no timeout), it emitted exactly one JSON object, and that
  object is complete and valid — `verdict` ∈ pass|fail, `documents` ∈
  one|several|none, `clarification` ∈ yes|no, nonblank `destination` and
  `reason`.
- Any failed attempt writes a `judge-error` verdict pointer with the reason
  and preserves the attempt directory: stdout, stderr, raw text, timings,
  exit/signal/error, input identities (answer, rubric and judge-prompt
  hashes), judge model and attempt number.
- Attempt directories (`judge/attempt-NNN/`) are never overwritten; the
  result-level `verdict.json` points at the latest judged attempt and
  becomes `judge-error` after a later failed attempt.

### Tested

- `node --test tests/harness.test.ts` (harness sight): valid pass, valid
  fail, nonzero exit after a valid-looking pass body, timeout kill, spawn
  failure, prose without JSON, truncated JSON, `{"verdict":"pass"}` alone,
  and bad enum values all behave as above; 7 pre-fix regressions fail
  against the pre-fix harness and pass after.

### Inferred

- A semantic judge that emits valid-looking JSON into a failing process must
  be treated like any other infrastructure failure; the pre-fix harness
  recorded a pass off exit-code 9 output exactly the way this gate now
  prevents.

### Open questions

- Unknown whether the free/flash workhorse ever emits enum-valued verdicts
  spontaneously (`documents: "many"`); a live sweep would tell.
