---
Area: testing
Keywords: r01, access-experiment, code-mode-catalogue, native-docs-tool, harness-child, placement-trials, c20261108
Summary: R01 diagnostic controls (13 harness-child sessions, 2 models across native/Code-Mode/natural conditions plus a sharpened A2 pair) on frozen e9d3926 semantics: the harness child never advertises the native docs tool; Code Mode docs dispatch flipped between success and the campaign's Unknown-tool error; every R01 criterion was deterministic-invalid and the semantic judge never ran.
---

# The harness child advertises no native docs tool; Code Mode docs dispatch is session-dependent

## Facts

- Experiment: 13 isolated R01 sessions through the real harness child path
  (container-run.sh, image 58505eac2fe9, OpenCode v2.2.6, plugin commit
  42fbe27; trial models opencode-go/deepseek-v4.1-flash and
  opencode-go/crouton-alpha-free; stamps r01{a,a2,b,c}-* under
  ~/tmp/r01-access-c20261108; two-repetition matrix plus one sharpened A2
  pair, serial --jobs 1, all exit 0, zero writes).
- Conditions: A = explicit native docs read instruction; A2 = same, plus a
  direct-tool-call-only sharpened repeat (its OWN versioned corpus with an
  exact-suffix delta); B = explicit Code Mode read instruction; C =
  unchanged authored R01 prompt. Diagnostic corpora are separate versioned
  copies; the ONLY delta is an exact suffix append to R01's claim
  (~/tmp/r01-access-c20261108 results deltas.md records every suffix
  verbatim). The natural corpus is the repo trial-cases.json unchanged.
- Native advertisement absent in the child: both A2 sessions enumerated the
  inventory on request — direct tools are edit,
  experimental_image_generate, glob, grep, question, read, shell, skill,
  subagent, webfetch, websearch, write, execute; no `docs`. Across all 13
  sessions no child ever issued a native `docs` call; crouton's A2 session
  concurred without any tool call.
- Code Mode dispatch flips by session: r01a-r1-dv4f called
  tools.docs.docs_search({read: "kb/test-commands.md"}) directly and it
  SUCCEEDED with operation-level output — docs:kb/test-commands.md —
  Running the suite carrying the seeded summary and Facts. r01b-r2-dv4f
  called the same method shape and received exactly the campaign error
  Unknown tool docs.docs_search . Did you mean
  tools.opencode.list_mcp_resources? , while typeof tools.docs?.docs_search
  in the same call reported function and Object.keys(tools.docs) threw
  Unknown tool namespace 'docs'. Catalogue reflection, typeof and dispatch
  disagree within one session.
- Every session's deterministic R01 criterion (a verified read of
  kb/test-commands.md) refused: 0 successful docs ops everywhere; the two
  code-mode attempts are unobservable nested operations by design, so the
  criterion cannot credit them. The semantic judge was never invoked in
  any of the 13 sessions (no judge attempt dirs; no judge spend).
- Natural (C) sessions: no docs use across both models and both
  repetitions — now attributable to the unadvertised surface rather than
  additional avoidance evidence. Direct file tools WERE advertised and used
  throughout (consistent with W01's file-tool write route).

## Inferred

- The c20261108-e9d3926 family campaign's zero successful required reads
  were substantially environmental: the native docs surface is not
  advertised to harness children, so discovery-based satisfaction of R01
  was impossible without an explicit instruction, and even then only the
  Code Mode route existed, and that route itself flipped between success
  and Unknown-tool across sessions.
- The access probe's native-docs-callable result is not contradicted:
  advertisement is a per-session property, not an environment property;
  the probe's exact invocation context was not preserved with its
  artefacts.

## Open questions

- Root cause of the advertisement gap: plugin registration vs tool
  enumeration vs the child config path (candidate smallest experiment:
  compare `opencode run --print-logs` tool-registration events between a
  host session and a harness child).
- What decides Code Mode dispatch success at per-session level (timing,
  prior tool use, catalogue assembly ordering), given reflection and
  dispatch disagreed within one session.
- Whether R01's natural condition can be measured before the child's
  advertisement is fixed: the criterion is sound, but the route may not
  exist for the model to find.

## Failed approaches

- Asking the model to check the Code Mode catalogue (B condition): models
  honestly report the docs method absent and do not invent namespace or
  argument shapes — but the observed absence is real at reflection level
  even when dispatch succeeds elsewhere, so catalogue reports alone
  under-measure callability.
- Inferring the native surface from one model's inventory report: only the
  sharpened A2 pair together yields a cross-model consistent enumeration;
  a single concurring session would have been weaker evidence.
