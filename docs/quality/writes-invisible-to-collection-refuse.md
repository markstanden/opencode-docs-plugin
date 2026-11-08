---
Area: quality
Keywords: write, invisible, collection, plans, hidden, node_modules, refuse, prepareAdd
Summary: An add whose target the lake would never collect refuses at the boundary; the same rule drives the collection walk.
---

# Writes invisible to collection refuse at the boundary

### Facts

- A successful `add` whose target file the lake's collection would never see
  (top-level scratch areas `plans`/`requirements`/`wiki` on knowledge lakes,
  dot-directories and `node_modules` at any depth) used to record itself as
  written while staying invisible to search, read and check; the write path
  and the collection walk now share one exclusion rule
  (`uncollectedSegment`), and `prepareAdd` refuses derived and explicit
  targets alike for both create and replace with an explanatory message.
- Wiki-profile lakes exclude only the dot/dependency path rules; their top
  level is not a scratch-area exclusion (the wiki class is read-only
  anyway).

### Tested

- `tests/visibility.test.ts` F09 block: derived scratch Area refusal,
  hidden/dependency path refusals, an accepted write then being genuinely
  findable and readable through search and read, a replace targeting an
  invisible on-disk doc refusing, and walk/predicate agreement over a real
  tree.

### Open questions

- Nothing settles whether other profiles will want scratch areas; if one
  does, the shared rule grows a profile knob rather than a second rules
  list.
