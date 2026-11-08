---
Area: testing
Keywords: trial-cases, D01, docsCriterion, schema-gate, family-corpus, blocked-generation
Summary: trial-cases.json D01 (`docsCriterion.verbs:["help"]`) is rejected by the #38-tightened docs-criterion schema, and corpus-wide validation blocks generation of every family case; age and generator never meet (no test loads the family corpus).
---

# D01 blocks generation of the whole family corpus: the #38 schema gate and trial-cases.json never met

## Facts

- PR #38 (1f07894, merged 2026-11-08) tightened `docsCriterion` validation in
  `tests/fixtures/placement-harness/harness.mts`: verbs must be undefined or
  exactly `["read"]` ("paths gate read targets; verbs must be undefined or
  [\"read\"]"), `paths` required for read targets.
- `tests/fixtures/trial-cases.json` was last touched in #36 (30be2f9), before
  the .mts conversion (#37) and the #38 gate. D01 carries
  `docsCriterion: { minVerifiedCalls: 1, verbs: ["help"] }` — now malformed.
- Validation is corpus-wide (`loadCases` validates every entry), so even
  selecting a single valid case refuses:
  `node tests/fixtures/placement-harness/harness.mts generate R01 …
--fixture tests/fixtures/trial-cases.json` →
  `corpus …: case "D01" is malformed: paths gate read targets…`.
- Nothing under `tests/` loads `trial-cases.json`, so the 634-test suite
  never sees the fixture harness collision — both stayed green while the
  family corpus became ungenerable.

## Tested

- Campaign c20261108-bf71e06 generated a staged corpus byte-identical to
  `trial-cases.json` minus D01 (sha256 73a869372d38556a9608…) and ran the
  other nine family cases (stamps -famA/-famC). The check reproduces
  deterministically on `bf71e06`'s checkout.

## Resolved (branch fix/d01-help-criterion, abd9d99 on bf71e06)

- Intended semantics settled from the fixture and the verifier: D01 asserts
  a help-discovery floor (one successful native `help` call — no seeded
  doc, no writable surface, so a read criterion would be fabricated), and
  the judge-time verifier already proves such calls. Only the misplaced
  #38 shape rule rejected it; the read-restriction applies to `paths`.
- The gate now reads "paths ⇒ verbs undefined or exactly read"; a
  paths-free verb list may name any docs verb. The refusal message is
  unchanged, so existing #38-era regressions keep matching.
- New D01 regression group loads the complete checked-in family corpus and
  generates it whole (the exact previously blocked check), passes a
  successful native help call through a help gate, refuses a completed
  blank one, and keeps the paths/read refusal. Suite 638/638, typecheck
  clean, `defined comply` compliant.

## Open questions

- None for this collision; the worktree-checkout `defined` mapping gap
  (git ls-files resolving the main .git directory) stays a tooling-side
  report.
