---
Area: testing
Keywords: pwd, harness-child, docs-registration, native-docs-tool, code-mode, access-control, a01, r01, placement-trials, c20261108
Summary: Setting the harness child's PWD to the spawn cwd restored plugin loading, native docs help and Code Mode docs help for both workhorses; explicit read controls passed 4/4, while the natural R01 read split 2/2 deepseek and 0/2 crouton with access demonstrated.
---

# A matching child PWD restores docs registration and native help

## Facts

- The pre-fix A01 evidence recorded invoked cwd
  `/results/<stamp>/A01/live/work`, host location `/workspace` and no
  plugin-load record. The harness copied the parent's `PWD` into the child
  environment while `spawn` used a different cwd, and OpenCode resolves its
  config path from `PWD`.
- The fix sets the child `PWD` to the exact absolute spawn cwd after the other
  environment overlays. Trial and judge sessions share the same launch
  helper. No startup sleep was added.
- Post-fix A01 on revision `1ea077e` (image
  `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`,
  OpenCode v2.2.6), one session per workhorse:
    - deepseek-v4.1-flash and crouton-alpha-free both reported cwd/PWD/host
      matches.
    - Both logs carried `msg="loading plugin" id=/repo`.
    - Both completed a native `docs` help call and a Code Mode
      `tools.docs.docs_search` help call, returning the configured repository
      lake inventory at the fixture's `live/lakes/docs` path.
    - Registration, advertisement, dispatch, help and observability were
      reported separately; the positive result came from an operation-level
      help response, not a model claim.
- The model's own inventory is supporting evidence only. No
  `tool-definitions.json` capture was available; native advertisement is
  evidenced by a completed native call, and Code Mode advertisement by a
  completed nested call.
- Explicit read control, two repetitions per workhorse: 4/4 verified native
  `docs` reads of the seeded `kb/test-commands.md`, all with the same exact
  content and revision token `1193e96a…`.
- Natural R01, two repetitions per workhorse, unchanged authored prompt in a
  fresh session: deepseek 2/2 verified reads of the seed; crouton 0/2. Both
  crouton sessions loaded the `docs` skill but made no docs-family call.
- Every official session exited 0, wrote nothing, and loaded the plugin.
  Reported model cost was 0 (free tier). No semantic judge ran.

## Inferred

- The launch defect, not delayed registration or an absent native surface,
  caused the earlier uniform absence: the same CLI and image now register the
  plugin and expose both docs routes as soon as `PWD` matches the spawn cwd.
- The earlier successful Code Mode dispatch (r01a-r1-dv4f) is no longer an
  unexplained anomaly in the same sense: its session had a working docs
  surface, while the other sessions did not load the plugin at all. Any
  remaining per-session Code Mode flip under the fixed launch should be
  re-measured, not assumed.
- Crouton's natural 0/2 is a criterion-unmet adoption result with access
  demonstrated, not environment unavailability and not automatically model
  avoidance. It read the guidance skill and chose the README workflow without
  consulting the seeded lake doc.

## Tested

- `PWD: the harness child's PWD is the cwd it was spawned in`
  (`tests/harness.test.ts`) exercises the real harness launch with an
  inherited `PWD` deliberately different from the fixture cwd; a Node fake
  child reports `process.cwd()` and `PWD`, and both match.
- A01 and the explicit read control were run through `container-run.sh`
  generate/run/summary/export with unique stamps and separate frozen roots.
- The seeded content assertions are deterministic and need no judge: the tool
  output contains both npm facts and the revision line returned by the plugin.

## Failed approaches

- Treating the historical zero-use counts as adoption evidence: those sessions
  had unproven or absent tool access, so they cannot establish model
  avoidance.
- Inferring advertisement from the model's inventory answer, or Code Mode use
  from a completed `execute` wrapper alone: neither is an operation-level docs
  result.
- Reusing one redacted case-list cache across model generations: it is now
  keyed by corpus bytes plus every generation inputs hash and the redaction
  version, so a changed model cannot inherit stale metadata.

## Open questions

- Does crouton's natural R01 0/2 persist across more repetitions now that
  access is proven, and is it a stable preference for the README workflow?
- Can any remaining Code Mode dispatch flip be reproduced under the fixed
  launch, or did it belong entirely to the pre-fix environment?
- No host tool-definitions capture is available; native advertisement remains
  evidenced by calls, not by a registry dump.
