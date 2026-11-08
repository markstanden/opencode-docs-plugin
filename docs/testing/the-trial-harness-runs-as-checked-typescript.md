---
Area: testing
Keywords: typescript, mts, type-stripping, harness, erasable-syntax-only, boundary-validation, discriminated-union
Summary: The trial harness ships as checked TypeScript (.mts) under Node's type-stripping: no build, no any; JSON shapes are validated at the IO boundaries, and the tool-part fold models the CLI's raw part/state shape.
---

# The trial harness runs as checked TypeScript

### Facts

- `tests/fixtures/placement-harness/harness.mts` replaces `harness.mjs`:
  strict types, `erasableSyntaxOnly` intact, so Node strips the types and
  runs the file directly — no build step, no bundler, no runtime change.
  The tsconfig include covers `tests/**/*.mts` (and `src/**/*.mts`), so the
  normal `npm run typecheck` checks the file the CLI actually runs; the
  file list can be proven with `tsc --noEmit --listFilesOnly`.
- Decoded JSON is treated as unknown and narrowed at the real IO
  boundaries by predicates (`isRecord`, `isFullCase`, validated corpus
  entry readers, typed record readers for `run.json`, per-case meta,
  verdict pointers, judge attempts and freeze receipts) — not by bare
  `as` casts. One field-narrowing-by-inspection cast inside
  `validatedCorpusEntry` goes through `unknown` first: the widening is
  only what the inspection above it proves.
- The CLI's raw tool part carries its payload inside `state`, not at the
  top level; `RawToolPart` models that shape and `mergedToolCall` folds
  repeated events for one call id latest-state-wins. Typing this fold
  explicitly caught two would-be regressions during the conversion (a
  `state.status === "string"` value-comparison bug and the part/state
  swap) — both demonstrated by the existing F07/M04 black-box
  counterexamples before the fix.
- Discriminated unions carry the genuinely enforced shapes: tree entry
  identities (`file`/`dir`/`symlink`/`other`/`dir-unreadable`), docs
  criteria (verified vs legacy semantics), flag value specs (string vs
  number), full vs instrumentation-only case definitions
  (`isFullCase`). Everything else stays typed interfaces with honest
  optional fields.

### Tested

- `tests/harness.test.ts` drives the actual `.mts` CLI black-box
  (575 suite-wide tests), `npm run typecheck` includes the file
  (proved via tsc's file list), and a real podman container smoke ran
  `node /harness/harness.mts` inside the trial image end to end (freeze,
  receipt, trial, judge) — the container's Node LTS strips the types the
  same way.

### Inferred (failed approaches)

- A self-vouching `readJson<T>` returning "any shape" typed at compile
  time would have lied at every boundary; the predicate readers cost a
  dozen small functions and keep the file honest.
- Comparing a value against a type name (`state.status === "string"`)
  compiles fine and silently records every status as "other" — the
  black-box counters caught it immediately; `typeof` is required.

### Open questions

- Whether `@opencode/plugin`'s own typing surface suits an `.mts` twin
  for the plugin entry is untested; `src/index.ts` stays as the host
  loads it (bun strips types there).
