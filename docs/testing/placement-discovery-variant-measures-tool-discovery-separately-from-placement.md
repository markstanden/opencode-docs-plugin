---
Area: Testing
Keywords: placement-trials, discovery-variant, docs-help, exposure, discovery-column, variant-comparability, harness.mjs, config-leak
Summary: The settled discovery variant: trial prompts carry no destinations and no tool mention; discovery (docs help use) is reported separately from the rubric-judged placement verdict. discovery-1 showed the workhorse never calls the tool — the fixture's own project config leaks the lakes instead.
---

# Discovery variant: placement trials separate tool discovery from placement judgement

## Facts

- Settled decision (2026-11-07, the Guv relaying the external review): in the
  discovery variant the prompt omits the destinations block entirely — no
  names, classes or descriptions — and does not mention the docs tool. The
  lakes are reachable only through the session's normal tool inventory: the
  plugin's own tool description points at `help`, and `docs help` lists each
  lake's name, class label, writability and configured description.
- Run it with `container-run.sh all E02 E06 E11 E16 E18 --stamp <name>
--discovery`; `--discovery` passes through `parse_run_args` to harness.mjs
  and is recorded in provenance args and the summary/dossier Variant line.
- Discovery is observed from the tool trail, not judged: the summary's
  `Discovery` column reads `help×N` (N docs-help calls), `no help (N)` (docs
  used without help), `none`, or `-` (not run); the per-case dossier line
  mirrors it. The placement verdict stays rubric-judged and unchanged, so
  "never found the tool" (`none`) reads apart from "found it, decided wrong"
  (`help×N` + fail).
- The exposure classifier labels a `glob` whose pattern names guidance
  (`guidance-discovery`) apart from guidance content reads (`guidance`);
  also `session config` (opencode.json reads), `harness surfaces`
  (manifest, /prompts) and `skill load`. Input-based rules under-count
  wildcard reads — E11's config read via `find … -exec sed` never names the
  file in an input.
- Prompt staleness is content-based (see the kept-check doc), so switching
  variant regenerates prompts automatically; each stamp snapshots its own
  `prompt.md`, keeping evidence immutable.
- Comparability rule: hold trial model and judge constant across compared
  stamps (discovery-1 vs fixture-check-1: workhorse trial + workhorse judge
  host-side). Writes stay disallowed in this variant.

## Tested — discovery-1 (2026-11-07)

- 5/5 placement passes, but `Discovered: 0/18`: zero docs calls in every
  trail. The workhorse never reached for `docs help`; it read its own
  project config (`work/opencode.json` — names, classes, descriptions),
  listed the `lakes/` directories for bare names, and prowled the manifest,
  id-only case list and its own prompt first. See
  `~/tmp/docs-placement/results/discovery-1/caveats.md`.
- Strict docs-help-only discovery is not isolable in this sandbox: the
  plugin's lake config is the project config and must stay readable, and
  lake directory names leak to any listing.
- E16 was the one clean case: no destinations found, correctly deferred.
- E06's fail→pass flip versus fixture-check-1 is channel-driven: here the
  model read the actual work-tree README rather than reasoning from a
  destination list in the prompt.
- Verdicts across variants are not comparable as guidance evidence.

## Failed approaches

- Mentioning the tool in the prompt ("The docs tool is available...") —
  rejected by the reviewer as a discovery nudge; the first implementation
  did exactly this and was amended before the sweep.
- Requiring a docs call in the prompt (the other candidate variant) — would
  test compliance with an instruction, not natural discovery.
- Existence-only prompt keeping across variant switches — silently reuses
  the previous variant's prompts under the new stamp (see the kept-check
  doc).
- Isolating the tool channel by prompt design alone — the environment leaks
  the same information through the session config; channel isolation would
  need lake config served via OPENCODE_CONFIG_CONTENT instead of the
  fixture tree.

## Open questions

- Construct decision pending: accept "discovery by any means" as the
  measured construct, redesign for channel isolation (config-content
  overlay), or keep discovery-1 as the realistic baseline and add an
  overlay variant alongside. Standing decision holds: no guidance prose
  changes from discovery evidence alone; execution trials still pending.
