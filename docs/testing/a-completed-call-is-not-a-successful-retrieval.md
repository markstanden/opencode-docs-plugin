---
Area: testing
Keywords: docs-criterion, retrieval, telemetry, completed, success-evidence, result-envelope, wiki-read, typed-path, min-verified-calls
Summary: A docs gate needs one operation's own evidence of a successful retrieval — the plugin's result envelope or the complete pre-truncation output, not the completed status, and not a display-capped excerpt.
---

# A completed tool call is not a successful retrieval

### Facts

- The plugin serves refusals and lake not-founds as normal tool output
  without failing the tool call, so a `completed` CLI status proves only
  that the call ran. The gate's success rules come from the operation's
  own result evidence (`docsOpSuccessful`), per operation and
  deduplicated by call id.
- The plugin's result envelope is the authoritative read contract: a
  successful read returns `metadata.read` as the retrieved document's
  address (knowledge lakes add a content-hash `revision`; wiki lakes,
  read-only reference, deliberately carry none); `metadata.read: null`
  is a refusal or not-found. An envelope-shaped refusal stays a refusal
  even when the output merely quotes a revision-looking string.
- Where the CLI emitted no envelope (an older tool-part shape), the
  complete pre-truncation output facts stand in: a read proves itself by
  the plugin's trailing `docs: revision <sha256>` note, every other verb
  by its delivered nonblank content. The folded call keeps those facts
  because the display projection truncates outputs at 2,000 characters
  while a real accepted read's revision envelope sat beyond it (the
  captured response was ~4,400 characters) — a bug that rejected a
  genuine successful retrieval as "no retrieval evidence recorded".
  Incomplete capture (stream overflow) still stays invalid evidence:
  incomplete data is never graded as success.
- `telemetry.verifiedDocs` counts successful operations, not completions:
  a floor of N is not met by N completed refusals; one success plus one
  refusal cannot satisfy a floor of two, and latest-state folding of
  duplicate call events cannot inflate the count. Path and verb
  requirements attach to the same successful relevant operation — a
  `paths` fragment is the typed `read` field's target of the operation
  that successfully retrieved it, so an unrelated successful read plus a
  separate mention (search text, an add body) satisfies nothing.
- An unmet floor aggregates the per-path diagnostics alongside rather
  than swallowing them, so one successful path never conceals a missing
  or failed one in the refusal.
- Legacy `minDocsCalls` definitions keep their historical
  attempted-operations semantics; the verified/legacy distinction in the
  gate message stays visible, never silently reinterpreted.

### Tested

- `tests/harness.test.ts` C02 group on the real R01 corpus case: a
  completed not-found read, a completed refusal, a completed
  unverifiable-output read, an unrelated-successful-read-plus-mention,
  and a genuine successful retrieval. The first four fail against the
  pre-fix harness; the fifth passes before and after, pinning the
  success shape.
- Real plugin-core captures driven through the black-box harness: a
  4,400+ character successful knowledge read with the revision envelope
  beyond the display cap (with and without the result envelope), and a
  161-character wiki read (`wiki:onboarding.md`, metadata `read/lake/
path`, no revision) — both rejected by the pre-fix truncation-only
  rules, both graded as successful retrievals now.
- The count counterexample rows: a verbs-only gate satisfied by one
  successful read and refused by a failed one; a floor-only criterion
  counting successes, never completed failures; floor two with one
  success plus one failure refusing; duplicate folded events not
  inflating; path aggregation naming every unmet fragment; add-body
  mentions rejected.

### Open questions

- None currently.
