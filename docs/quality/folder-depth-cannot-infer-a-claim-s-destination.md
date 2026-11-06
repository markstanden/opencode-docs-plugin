---
Area: quality
Keywords: destination ambiguity, writable lake, nesting depth, physical ownership, containment refusal
Summary: An omitted write lake must refuse whenever more than one writable knowledge lake is configured: folder depth cannot infer a claim's semantic owner, only resolve a named target's physical owner.
---

# Folder depth cannot infer a claim's destination

### Facts

- The reviewed `writableLake()` gathered writable knowledge lakes and
  filtered to the maximum nesting depth before deciding ambiguity: a single
  deepest lake was selected even with unrelated writable alternatives, and
  the candidate list dropped shallower lakes. A create with `lake` omitted
  silently wrote into the nested repo lake while a writable personal lake
  existed.
- Now: exactly one configured writable knowledge lake may take an omitted
  `lake`; any larger number refuses with every writable candidate (name,
  class label, root, availability, description) — depth, class, config order
  and missing roots change nothing. Zero writable lakes keeps the explicit
  refusal; explicit selectors still never fall back.
- Ownership is deliberately two decisions: **nesting resolves the physical
  owner of an already named target** (`uniqueHolder` for reads; the
  publication `containmentRefusal` for writes), while **destination choice**
  for new content is the model's semantic decision. A write addressed through
  an outer route that physically resolves inside a nested lake's tree is
  refused, naming its physical owner — so a writable outer lake cannot make
  read-only nested content writable (L09).

### Tested

- D01–D04 in tests/destinations.test.ts (nested branches, unrelated personal
  lake, missing-root candidates), D05/D07/D08 ordering and explicit
  selection, D09 twin/native parity, plus the red-first regression in
  tests/publication.test.ts. Mutating the refusal back to a depth pick turns
  D01 red.
- Search/read/check in supported nested setups keep their previous behaviour
  (nested tests in tests/lakes.test.ts still pass).

### Failed approaches

- Keeping the maximum-depth filter with a tie check — it hides shallower
  candidates and invents a claim owner from a folder path.
- Banning nested lakes — supported configuration, not a substitute for the
  fix.

### Open questions

- Model placement accuracy needs a behavioural trial (the
  `tests/fixtures/placement-cases.json` harness); no Node fixture validates
  what a model chooses.
