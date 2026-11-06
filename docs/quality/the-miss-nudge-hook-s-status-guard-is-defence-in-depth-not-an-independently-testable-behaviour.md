---
Area: quality
Keywords: miss nudge, execute.after hook, status guard, untestable branch, coverage gap, opencode-docs-plugin
Summary: The docs plugin miss-nudge hook's status guard is defence-in-depth: a hook-level test for non-completed events cannot fail, because missNudgeFor already refuses errored calls at the pure layer.
---

# The miss-nudge hook's status guard is defence-in-depth, not an independently testable behaviour

Recorded 2026-11-05 during a full-project test review of opencode-docs-plugin at 3b293e7, while closing coverage gaps from the review.

## Facts

- The `execute.after` hook registered by the plugin's setup returns early when `event.status !== "completed"` (src/index.ts, the `if (nudge)` hook body).
- The same rule already lives in the pure layer: `missNudgeFor` returns `null` for a non-completed status, pinned by the `does not nudge an errored call` test in tests/docs.test.ts.
- Consequently the hook-level branch is unreachable-distinguishable: any hook-level test that feeds `status: "error"` and asserts the result content is untouched also passes if the guard is deleted, because `missNudgeFor` still returns null.

## Tested

- The reasoning against the failable-assertion rule during the review: a proposed hook-level test (planned as task 5 of the test-review follow-ups) was dropped before writing, because removing the guard could not turn it red.

## Open questions

- None. If `missNudgeFor` ever stops owning the status check, the hook guard becomes behaviour and earns a test at that moment.

## Failed approaches

- Writing the hook-level test anyway would have shipped an assertion that cannot fail — a tautology by the house standard, kept out of the suite.
