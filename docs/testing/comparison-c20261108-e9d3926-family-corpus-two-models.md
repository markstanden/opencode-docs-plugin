---
Area: testing
Keywords: family-corpus, comparison, c20261108, e9d3926, crouton-alpha-free, deepseek-v4.1-flash, glm-5.3-flash, help-criterion, first-verified-write, code-mode-twin-boundary
Summary: Family corpus ×2 models ×2 reps on frozen e9d3926: the control deepseek achieved the harness's first verified knowledge-doc write (W01) and one code-mode help attempt; crouton-alpha-free wrote nothing; zero native docs use in 76 trials; the Code Mode docs twin's advertised availability differs between sessions.
---

# Comparison c20261108-e9d3926: first model-written knowledge doc, a twin-availability boundary, and no natural docs use in 76 trials

## Facts

- 40/40 family trials (D01–D03, R01/R02/R04/R05/R06, W01/W02; 2 reps × 2
  models) plus optional 36 baseline trials (E01–E18, 1 rep × 2 models), all
  exit 0, serial `--jobs 1`, judged by opencode-go/glm-5.3-flash — a
  different free model from both trial models. Trial models:
  control opencode-go/deepseek-v4.1-flash; variant
  opencode-go/crouton-alpha-free ($0 list price, availability smoke-tested
  with one "Reply OK" probe before selection; both recorded before running).
- First verified write in the whole trial history: W01 rep1-dv4f recorded
  `lakes/docs/locking/publication-lock-placement.md` — structurally valid
  (front-matter, H1, Facts/Failed approaches), focused and discoverable;
  the second recorded write is the newly created ancestor directory,
  admitted by the C01 necessary-ancestor rule. crut wrote nothing anywhere;
  dv4f wrote nothing in rep2.
- Natural triggers (D02/D03 natural prompts): every judge call returned
  fail — except D02-rep2-crut's pass, flagged below as lenient.
- Retrieval read cases (R01/R06): zero successful reads by either model in
  either repetition. Recording cases (R02/R05/W01/W02): one verified write
  (above); the rest answer proposals plus clarification-asking despite
  named destinations and granted write authorisation.
- D01 (help-discovery gate): one code-mode help attempt in rep1-dv4f —
  inconclusive by construction, so the criterion stays unmet (correct);
  zero native help calls across all four reps.
- Judge provenance: deterministic invalids consumed no judge calls; judge
  attempts preserved per case (two judge-errors preserved as judge-error:
  D02-rep1-crut, E04-base-dv4f). The one decisive pass was audited against
  the filesystem, not the judge's word.
- Baseline placement: dv4f 16/18 (E06 fail, E04 judge-error), crut 16/18
  (E06 and E16 fail). E06 has now failed on every setup; E16 remains
  flippy between runs as recorded in the earlier sweep.
- Exposure (leakage) varies by model: base-dv4f 8/18, base-crut 0/18,
  rep1-dv4f 5/10 (multi-surface: guidance + case list + harness surfaces +
  session config), others 0–3/10. Both dv4f D01/W01 trails read
  /repo/src/index.ts and CONVENTION.md before attempting docs.

## Inferred

- Tool avoidance is behaviour, not capability: the native docs route was
  proven callable in an identical trial environment (access probe
  ~/tmp/toolprobe-c20261108, same image/CLI/plugin mounts, cwd=live/work),
  including a content-verified add — yet neither model used it in any
  successfully measured sense across 76 trials.
- The Code Mode docs twin's advertised availability is
  session-dependent: the probe session advertised `docs.docs_search`
  (callable, with the full verb surface folded into that one method), while
  trial sessions — including this campaign's D01 (both models) and E03 at
  bf71e06 — saw it absent ("Unknown tool 'docs.docs_search'"). D01's trails
  show both models source-reading the plugin and trying five argument
  shapes before giving up; they never try the native `docs` tool itself.
- D02-rep2-crut's semantic pass is a leniency finding: the answer proposes
  recording the trace and SDK scope "in the change description" — code
  change framing, while the rubric accepts only a documentation
  destination or a deliberate decision to record knowledge. Both verdicts
  are kept; the disagreement is recorded, not silently overridden.

## Open questions

- Why trial sessions' Code Mode catalogue lacks the docs twin the probe
  session advertised from the same image, CLI and plugin (candidate
  reproducer: run the probe prompt against a staged trial fixture through
  the harness flow and compare the catalogue).
- Whether any model can satisfy R01 by reading the seeded doc (the whole
  retrieval construct), and whether any can keep the W02 preservation
  marker through a full in-place replace.
- The per-session catalogue flip's cause (session-tool enumeration timing
  or config-dependent twin registration) and its smallest delta between
  probe and trial environments.

