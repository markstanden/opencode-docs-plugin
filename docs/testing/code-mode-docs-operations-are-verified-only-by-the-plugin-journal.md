---
Area: testing
Keywords: telemetry, code-mode, docs_search, execute, operation-journal, nested, attempted, dedup, attribution, signature, tamper, tool, trail
Summary: Docs telemetry separates native calls, the twin name and code-mode attempts; a nested operation counts only when a signed journal record is attributed to this run and to a host-recorded dispatch.
---

# Code Mode docs operations are verified only by the plugin journal

### Facts

- The plugin registers a native `docs` tool and a Code Mode twin
  `docs_search`; the twin's nested calls are NOT separate CLI events — they
  are outer `execute` tool calls whose `input.code` text mentions
  tools.docs.docs_search(…). Source-code regexes cannot prove nested
  execution: dead code mentioning the twin (`if (false) { … }`) proves
  nothing, and the outer wrapper's completion or printed output is not a
  docs operation.
- The CLI trail's execute result metadata does list the dispatched nested
  calls (`metadata.toolCalls`: tool, status, input). That is useful
  dispatch evidence but carries no per-call result, so it cannot prove a
  successful retrieval or write.
- `DOCS_OPERATION_JOURNAL` (path) plus `DOCS_OPERATION_JOURNAL_KEY` (per-run
  signing key) are opt-in plugin env vars. With both set, every served
  `docs`/`docs_search` invocation appends one JSON line: schema version,
  registered tool, registration surface (`native` or `codemode-twin`),
  status, the exact input, the served result envelope or error, the tool
  context's session, message and call ids, and an HMAC-SHA256 over the
  record. It is production plugin code, opt-in and silent when unset, and
  fail-quiet.
- Capture is tamper-evident. The plugin writes to a per-run path in the
  container temp filesystem; the harness copies it into
  `docs-operations.jsonl` and saves the key as `docs-operations.key` (mode 0600) only after the child exits, so a trial-time file write cannot
  pre-seed the evidence. A trial tool that writes a perfectly shaped journal
  file into the writable result directory is overwritten; one that appends a
  shaped line to the capture path cannot sign it with the run key.
- A record is credited only when it is signed and attributed: the HMAC must
  verify under the saved run key, its session and message ids must appear in
  the run's CLI events, its call id must name an execute call in this trail,
  and it must match one unmatched nested docs dispatch that the host recorded
  in that execute result's metadata. Shape, a filename, a signature alone, or
  a plausible result envelope is never enough.
- Residual limit: a model that can run shell commands could read the key
  from the process environment and sign a record, though it would still need
  this run's session/message ids and a matching host dispatch. The trial
  policy denies shell; the harness does not claim more than the recorded
  identity and dispatch prove.
- The harness folds attributed `codemode-twin` records into the trail as
  `nested` operations and runs the same success verifier as native calls:
  a read needs the plugin's nonempty `metadata.read`, other verbs delivered
  content, and refusals/not-founds/failed statuses never count.
  Deduplication is by tool and call id, never by arguments: two distinct
  reads with identical input stay two calls, so a later successful nested
  read survives beside an earlier observable refusal. Only a direct twin
  call already carried under the same call id is dropped. The execute
  wrapper stays attempted-only, and another case's journal is never read.
- Without a journal, a code-mode-only trial remains inconclusive, exactly
  as before: nested evidence is unknown, never success. Historical stamps
  therefore keep their wrapper-only classification and cannot be relabelled
  by this change.
- Retrieval gates can name the relevant document (`paths`): a completed
  read of some unrelated document does not satisfy a relevant-path
  criterion. Legacy saved definitions using `minDocsCalls` keep their
  historical attempted-operations semantics at judge time, with the label
  visible in the reason — never silently reinterpreted.
- Exposure classification labels each rule hit with the entry's completion;
  a failed read of a rubric path renders `<label> (attempt)`, and a missing
  trail renders "no trail" rather than a benign zero. Discovery reports
  verified help use (`help×N`) apart from attempts
  (`no help (N attempted)`).

### Tested

- `tests/operation-journal.test.ts`: unset writes nothing; a served twin
  records signed tool, input, session ids and result; a thrown call records
  an error and rethrows; the signature verifies under the run key.
- `tests/harness.test.ts` N01 group: a journaled nested read satisfies the
  same verb/path criterion as a native read; a nested error, refusal, wrong
  path, wrong verb, wrapper-only or forged printed success cannot; two
  nested calls count once each without the wrapper; identical arguments do
  not collapse a success beside a direct refusal; a direct twin plus its
  journal copy counts once by call id; another case's journal cannot
  satisfy the case; a forged journal file written by a trial tool is
  overwritten, and a shaped line appended to the capture path lacks a valid
  signature.
- `tests/harness.test.ts` A01 group: a journaled nested call is
  operation-level, and never establishes native advertisement or dispatch.
- The pre-journal F07/M04 groups still pin dedup, attempted-not-verified
  for unwitnessed code-mode, error labelling, unparsable lines and absent
  trails.

### Open questions

- Should the journal become a default harness capture? It is enabled per
  run now; older stamps remain unobservable.
