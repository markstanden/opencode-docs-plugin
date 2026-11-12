---
Area: Testing
Keywords: prod014, attribution, journal, nested-lake, add, evidence-boundary, replay, opencode-arguments
Summary: The P05 B refusal was a host-decoding mismatch, not a plugin failure: OpenCode discarded an undeclared lake inside add before execute, the signed journal omitted it, and exact host matching rejected the line. A narrow verifier exception now credits the call while refusing any write the signed result cannot tie to the effective top-level lake. Ten offline journals replay with exactly one change.
---

# Prod014 P05 B: nested `add` lake breaks journal attribution (2026-11-12)

Campaign `pd-fresh-20261112T203707Z-d982e28` at
`d982e28bc1cb624cb21d9b32536cab3d73e63f2c` stopped at P05 B. This note records
the read-only reproduction, the argument trace and the verifier repair.

## Facts

- The raw host call `call_1eb9e159e2f34fcc8071b35b` carried
  `input.add.lake = "shared"` and no top-level `lake`.
- The signed journal line for that call has no nested `lake`; its result is
  `written: false` with `Rejected: 2 writable knowledge lakes could take this
write; pass lake`.
- `DOCS_INPUT` declares `lake` only at the top level. Decoding the raw call
  through that schema drops the nested field; the same plugin input is what
  `execute(input)` journals. The runtime decodes before execute, so the plugin
  never saw the nested selector.
- The plugin's `writableLake()` therefore found two writable lakes and refused.
  The later successful call `call_92ca39ba6d734649943f12d0` carried a top-level
  `lake: "shared"` and wrote `lakes/shared/bruno/collection-layout.md`.
- The old verifier required exact deep equality between the host input and the
  signed input. The raw host input's nested field made that impossible, so the
  line rejected as `no-host-dispatch` and the judge wrapper refused before
  dispatch.
- The fix removes only the undelivered nested `add.lake`, never a general
  unknown field. A refused add (`written: false`) binds without a destination.
  A successful write binds only when the host's top-level selector is present
  and equals the lake named by the signed result. The nested value is never the
  destination, and a conflicting signed result refuses.
- Offline replay of all ten trial journals against the read-only evidence copy
  changes exactly one line:

| Journal                   | Old                                             | New                    |
| ------------------------- | ----------------------------------------------- | ---------------------- |
| P05 B (`pd-B-r0-S05/S05`) | 4 credited, index 3 rejected `no-host-dispatch` | 5 credited, 0 rejected |
| Other nine                | unchanged                                       | unchanged              |

- The real judge entry point on a scratch copy now prepares an 8,284-byte
  packet and reaches dispatch (offline launcher, no model call). The old entry
  point refused before dispatch. The original campaign remains without an
  assessment.
- The preserved-note gate still blocks with the identical reason:
  `preserved lakes/shared/bruno/collection-layout.md was modified by the run;
the expectation requires it untouched`.
- The analyser on a copy with the assessment still absent publishes the same
  report: `inconclusive`, coverage 5/8 vs 4/8, recording 2/4 each, retrieval
  2/5 each, utility 10/10. S05 B remains `miss (gate-blocked)`; attribution
  repair alone does not turn a gate-blocked write into a success.
- Spend: no model call in the reproduction, replay or entry-point proof. The
  offline judge launcher exits without inference.

## Inferred

- The nested field disappears in OpenCode's tool-argument decoding, between
  the raw host trail and `execute`. It is not a plugin input-coercion step: the
  plugin's schema never declares the nested field, and the signed journal is
  the decoded input.
- The effective destination is determined solely by the top-level `lake`
  (`lakeOf` → `writableLake`) or by the sole writable lake. A nested value is
  never consulted, so it must never be credited as the destination.
- A bare recovery judgement before the fix would refuse identically. After the
  fix the packet can be prepared, but recording a judgement would still be a
  new attempt and a separate decision; the original assessment stays absent.

## Tested

- `Schema.decodeUnknownSync(DOCS_INPUT)` on the raw add shape returns an `add`
  object with no `lake` key.
- New focused verifier cases: nested-only refusal; nested-only successful write
  refused; matching and conflicting top-level/nested lakes credited to the
  top-level lake; conflicting signed-result lake refused; string-form add with
  a nested lake credited; string-form nested-only successful write refused; an
  extra nested field still rejected; a signed record already carrying a nested
  lake is not normalised; a non-object host add or host input refuses; missing
  result, metadata, write fact and result lake all refuse; two records for one
  dispatch still credit one; Code Mode twin still refuses; the credited record
  remains byte-identical and MAC-valid.
- Test coverage for `journal.ts`: 96.94% line, 84.25% branch, 100% function;
  the new helper range has no untaken branches. `npm test`: 1,188 tests pass.
  `npm run typecheck`: pass.
- Replay script: old verifier vs new, ten journals, one changed line.
- Real `ac/run.mts judge` on a scratch copy: old refused, new prepared and
  dispatched to the offline launcher.
- `ac/run.mts gate` on the scratch copy: still blocked, same reason.
- Analyser diff against the stopped-state report: no output (identical).

## Failed approaches

- A general “drop unknown fields” comparator: rejected by the extra-nested-field
  case; it would admit shapes the runtime did not deliver.
- Using the nested lake as the destination: rejected by the conflicting and
  signed-result cases; it would credit a lake the plugin did not use.
- Crediting a successful nested-only write without a top-level selector:
  rejected; there is no delivered selector to corroborate the signed result.
- A bare recovery judgement without the repair: deterministic refusal.

## Open questions

- Whether to commission a fresh campaign after this repair, and whether the
  remaining 6 trial launches and 7 judge attempts apply to it.
- Whether S05's expected `create` versus B's attempted replace of the preserved
  note needs a separate scenario-design note.
