---
Area: testing
Keywords: docs-criterion, retrieval, telemetry, completed, success-evidence, revision-token, typed-path, min-verified-calls
Summary: A docs gate needs one operation's own evidence of a successful read — typed verb field, relevant path and the plugin's revision token — because a completed status alone proves execution, not retrieval.
---

# A completed tool call is not a successful retrieval

### Facts

- The plugin serves refusals and lake not-founds as normal tool output
  without failing the tool call, so a `completed` CLI status proves only
  that the call ran. The counterexample: a read of a missing document
  returns "No doc at <path>." with `status: completed`, counts as a
  verified completion, and used to satisfy R01's relevant-read gate
  before semantic judging.
- The gate therefore needs the operation's own result evidence
  (`docsOpSuccessful`): a read carries the plugin's revision token — the
  `docs: revision <sha256>` note attached to the retrieved bytes; every
  other verb establishes success from its own delivered output content.
  Refusals ("Rejected:"), not-founds ("No doc at "), error statuses and
  blank outputs oppose success; anything else is unverifiable and keeps
  the criterion inconclusive rather than satisfied.
- Verb, relevant path and success must refer to the same operation: a
  `paths` fragment must be the completed call's TYPED verb field target
  (`input.read` for reads), not a mention anywhere in the input, and the
  same entry must be the successful one. An unrelated successful read
  plus a separate search mentioning the target combines into nothing.
- Legacy `minDocsCalls` definitions keep their historical
  attempted-operations semantics; the verified/legacy distinction in the
  gate message stays visible, never silently reinterpreted.

### Tested

- `tests/harness.test.ts` C02 group on the real R01 corpus case: a
  completed not-found read, a completed refusal, a completed
  unverifiable-output read, an unrelated-successful-read-plus-mention,
  and a genuine successful retrieval. The first four fail against the
  pre-fix harness (completed counted as verified); the fifth passes
  before and after, pinning the success shape.
- The existing M04 counterexamples (denied read, unrelated read,
  code-mode-only inconclusive) keep their recorded rejection reasons.
