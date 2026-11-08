---
Area: testing
Keywords: r01, access-experiment, code-mode-catalogue, native-docs-tool, harness-child, placement-trials, c20261108, stale-pwd, a01-diagnostic
Summary: R01 access controls plus the A01 tool-availability diagnostic (2 workhorses, 2026-11-08): the harness child ran with a stale PWD=/workspace, so OpenCode changed away from the invoked cwd and never loaded the fixture config; plugin registration was absent without delay, no docs surface was advertised, and no help or dispatch occurred. The earlier code-mode dispatch flip remains unexplained.
---

# The harness child's stale PWD skipped the fixture config; A01 separates registration from dispatch

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
- A01 diagnostic (2026-11-08, stamps a01-dv4f and a01-crut under
  ~/tmp/diag-a01-c20261108, serial, one fresh session per workhorse,
  plugin e776be6/fdb02e9, zero writes): both children ran with the harness
  invocation cwd at /results/<stamp>/A01/live/work, but the host log's
  `location services booted` directory was /workspace. The complete
  startup/shutdown trace carried no plugin-load record. The models' own
  inventories listed no documentation tool, no docs-family call was made,
  and both runs were reported as registration absent, advertisement
  unknown, dispatch not attempted, help unknown, observability no event.
- Direct probe with a correct PWD in the same host environment loaded the
  plugin (`msg="loading plugin"`); the same probe with PWD=/workspace
  failed with `Failed to change directory to /workspace`. The harness
  spawns with `cwd` but copies the parent `PWD` into the child env, and
  OpenCode changes to `PWD` rather than the spawn cwd.

## Inferred

- The c20261108-e9d3926 family campaign's zero successful required reads
  were substantially environmental, and the A01 evidence now names a
  concrete launch-path defect: stale PWD sent the child to /workspace, so
  the fixture opencode.json (and therefore the plugin) was never loaded.
  This is not delayed registration; no plugin-load record appeared at all.
- The access probe's native-docs-callable result is not contradicted:
  advertisement is a per-session property, and a launch context with a
  matching PWD can load the plugin; the probe's exact invocation context
  was not preserved with its artefacts.
- The earlier code-mode dispatch flip remains unexplained by this
  evidence. A launch defect explains uniform absence, not one successful
  nested dispatch under the same wrapper, so that observation stays open.

## Open questions

- Does setting the child env's PWD to the spawn cwd restore plugin
  registration and a native help inventory in A01? That is the smallest
  justified next experiment; re-run in new stamps and keep the old
  evidence untouched. **Answered 2026-11-08:** yes — see
  [a-matching-pwd-restores-docs-registration-and-native-help.md](a-matching-pwd-restores-docs-registration-and-native-help.md).
- What decides Code Mode dispatch success at per-session level (timing,
  prior tool use, catalogue assembly ordering), given reflection and
  dispatch disagreed within one session?
- Whether R01's natural condition can be measured before the child's
  launch path is fixed: the criterion is sound, but the route may not
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
- Treating the absence as delayed registration: the captured trace is a
  complete startup/shutdown sequence with no plugin-load record, and the
  host-location mismatch is visible before the first request.
