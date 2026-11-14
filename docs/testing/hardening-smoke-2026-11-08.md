---
Area: testing
Keywords: hardening smoke, recording W01, retrieval R01, discovery D02, tool inventory, bounded smoke
Summary: A bounded 2026-11-08 hardening smoke: one recorded run per new behavioural family plus a tool-inventory probe, which established registration through the real CLI path and corrected two unsupported claims rather than producing a family verdict.
---

# Hardening smoke (bounded, 2026-11-08)

## Facts

One recorded run per new behavioural family on the free workhorse
(`opencode-go/deepseek-v4.1-flash`, real CLI inside the trial container,
plugin `hardening/pre-trial-fixes`), plus one tool-inventory probe:

- **Recording (W01)** — the trial used `shell` three times, claimed a doc
  write it never made (`writes.txt` stayed `none`), and the workhorse judge
  passed it on stated intent. The deterministic recording minimum now
  overrides that: the case records `invalid` with
  `recording case wrote 0 file(s), policy requires 1`, while the semantic
  pass stays preserved in `judge/attempt-001/` as honest history.
- **Retrieval (R01)** — the trial never consulted the docs tool; the docs
  criterion gate invalidated it (`0 docs call(s), required 1`) before any
  judge call.
- **Discovery (D02)** — a natural prompt of the pre-fix template: no
  destinations and no tool mention, but the template still appended a
  State block naming "the exact destination lake, or other documentation
  workflow" and a document count, so the recorded proposal was a valid
  PROMPTED response. The interpretation "unprompted trigger" attached to
  this run was unsupported; the natural template has since been corrected
  to carry no documentation framing at all (M06), and D02/D03 must be
  re-run under it before an unprompted trigger is claimed.
- **Host/transport (tool-inventory probe)** — asking a real container
  session to list its tools returned both registered surfaces (`docs`
  native and `docs_search` Code Mode twin) plus the built-ins, so plugin
  registration through the actual CLI path is verified, not inferred from
  plugin-core tests. A tool-inventory probe proves registration only —
  it is not a full live write/read round trip and no sweep-1 R03 trial
  evidence exists or is claimed.

What this smoke does NOT establish (and nothing else here claims to):

- No verdict on the three families' model behaviour beyond these single
  observations — workhorse sessions leaned on `shell` (as sweep-1's trails
  did; permission denials are defence in depth, and the container mount
  remains the enforced boundary).
- `config-home` surfaced no CLI-owned writes in these container runs.
