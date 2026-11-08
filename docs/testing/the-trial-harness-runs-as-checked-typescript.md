---
Area: testing
Keywords: typescript, mts, type-stripping, harness, erasable-syntax-only, boundary-validation, recordat, discriminated-union
Summary: The trial harness ships as checked TypeScript (.mts) under Node's type-stripping: no build, no any; recorded JSON schemas are proven by concrete validators at the IO boundary with absent and corrupt distinguishable, and the tool-part fold models the CLI's raw part/state shape.
---

# The trial harness runs as checked TypeScript

### Facts

- `tests/fixtures/placement-harness/harness.mts` replaces `harness.mjs`:
  strict types, `erasableSyntaxOnly` intact, so Node strips the types and
  runs the file directly — no build step, no bundler, no runtime change.
  The tsconfig include covers `tests/**/*.mts` (and `src/**/*.mts`), so the
  normal `npm run typecheck` checks the file the CLI actually runs; the
  file list can be proven with `tsc --noEmit --listFilesOnly`.
- Every recorded JSON record is read through `recordAt`/`jsonAt`, which
  keeps three outcomes the callers must not merge: `absent` (no file — a
  legacy record), `malformed` (exists but unparsable, or fails its
  per-schema validator's consumed-field proofs), and `value` (the
  validated record). The validators prove the fields each consumer
  touches — types, required presence, enum and numeric ranges, and the
  relevant nested structures (certification tree entries, the
  write-diff arrays and label map inside `writeKinds`, criteria,
  mutation policies, expected docs, destinations, seeds, and full
  frozen v2 case definitions through the same authoritative case
  validator as corpus input) — so the single `as T` at the validated
  boundary carries exactly that proof, never an inspection-by-inspection
  widening. Legacy v1 run records are validated for what is present — a
  consumed field that exists must be well-formed, but no v2-only field
  is demanded — and a v1 record alone never supplies a judgeable case.
- Absent and malformed must stay distinguishable: a corrupt frozen run
  description refuses judging and reporting instead of silently becoming
  a legacy stamp whose criteria come from the current corpus, and a run
  never rewrites a corrupt run.json over itself.
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
  (634 suite-wide tests), `npm run typecheck` includes the file
  (proved via tsc's file list), and a real podman container smoke ran
  `node /harness/harness.mts` inside the trial image end to end (freeze,
  receipt, trial, judge) — the container's Node LTS strips the types the
  same way.
- The C03 counterexamples (corrupt run.json refusing judge/summary/
  export, a corrupt run.json surviving a rewrite attempt, corrupt meta
  rows including a JSON array, a malformed generation record, malformed
  certification tree entries naming the offending path, malformed frozen
  case definitions, a damaged `writeKinds` beneath an earlier semantic
  pass, per-field corpus problems, and legacy v1 records validated only
  for what is present) all fail against the pre-fix harness: read, never
  guessed at.

### Inferred (failed approaches)

- A self-vouching `readJson<T>` asserting a schema after checking only
  `isRecord` lied at every boundary — a corrupt record became a legacy
  fallback instead of evidence. The per-schema validators cost a dozen
  small functions and keep the file honest.
- Comparing a value against a type name (`state.status === "string"`)
  compiles fine and silently records every status as "other" — the
  black-box counters caught it immediately; `typeof` is required.

### Open questions

- Whether `@opencode/plugin`'s own typing surface suits an `.mts` twin
  for the plugin entry is untested; `src/index.ts` stays as the host
  loads it (bun strips types there).
