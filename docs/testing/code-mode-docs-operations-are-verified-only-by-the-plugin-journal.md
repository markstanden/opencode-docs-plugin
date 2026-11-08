---
Area: testing
Keywords: telemetry, code-mode, docs_search, execute, operation-journal, nested, attempted, dedup, tool, trail
Summary: Docs telemetry separates native calls, the twin name and code-mode attempts; a nested operation counts as verified only when the plugin's own operation journal recorded the call and its result.
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
- `DOCS_OPERATION_JOURNAL` is an opt-in plugin env var naming a JSONL file.
  With it set, every served `docs`/`docs_search` invocation appends one
  record: schema version, registered tool, registration surface (`native`
  or `codemode-twin`), status, the exact input, and the served result
  envelope or error. It is fail-quiet and silent when unset. The harness
  sets it per case, beside that case's trail; the model cannot write it.
- The harness folds `codemode-twin` journal records into the trail as
  `nested` operations and runs the same success verifier as native calls:
  a read needs the plugin's nonempty `metadata.read`, other verbs delivered
  content, and refusals/not-founds/failed statuses never count. A record
  already present as an observable direct twin call is deduplicated, so one
  call is never counted twice, and the execute wrapper stays
  attempted-only. Records keyed to another case's directory are never read.
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
  records tool, input, session ids and result; a thrown call records an
  error and rethrows.
- `tests/harness.test.ts` N01 group: a journaled nested read satisfies the
  same verb/path criterion as a native read; a nested error, refusal, wrong
  path, wrong verb, wrapper-only or forged printed success cannot; two
  nested calls count once each without the wrapper; a direct twin plus its
  journal copy counts once; another case's journal cannot satisfy the case.
- The pre-journal F07/M04 groups still pin dedup, attempted-not-verified
  for unwitnessed code-mode, error labelling, unparsable lines and absent
  trails.

### Open questions

- Should the journal become a default harness capture? It is enabled per
  run now; older stamps remain unobservable.
