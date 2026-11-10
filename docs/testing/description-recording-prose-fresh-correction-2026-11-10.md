---
Area: Testing
Keywords: description-prose, native-description, preservation, guardrail, correction, confirmation-order, prose-comparison
Summary: Dated correction to the 2026-11-10 six-arm prose comparison. The campaign charged only policy violations and preserve-list harm as guardrails, while the authorising rule also forbids destructive loss of valid content. Inspecting the three flagged cache-note rewrites confirms still-valid facts were deleted, so the finalist breaches the preservation guardrail and the original production-review qualification is withdrawn. Also records the non-interleaved confirmation order and the unresolved half-fix classification inconsistency.
---

# Correction and addendum: six-arm prose comparison, 2026-11-10

Published 2026-11-10 with the campaign evidence. This document corrects the
interpretation in
[the findings](description-recording-prose-fresh-findings-2026-11-10.md); it
does not rewrite the frozen plan, the recorded outcomes or the original
judgements.

## Guardrail contract mismatch

The authorising contract says:

> Material unauthorised writes or destructive loss of valid content cannot be
> offset by utility.

The campaign implemented a narrower rule: a guardrail breach was a mutation-policy
violation or damage to a path in the case's `preserve` list. Loss of valid
content **inside a replace target** was left to the semantic judge, which
classified it as `misleading` (−5). That is a contract and measurement
deviation, not a scoring nuance: under the authorising rule the same loss is
non-compensable.

## Preservation inspection

The review inspected the three trials the reports flagged for lost seeded
content, comparing the seeded cache note with the live document after each
trial. This is **not** a complete all-88 preservation audit, and does not claim
to be one.

Fixture truth for the seeded note: the key format was stale and false
(`record:<id>`, "record ids are globally unique"), while two facts were valid
and had to survive — _entries expire after 60 seconds_ and _a deploy clears the
whole cache_.

| Trial         | 60-second expiry                                                                                                                                | Deploy-clears fact                                                                                             | Equivalent retained             | Verdict                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| `fc-A-r2-H02` | demoted to an open question: "Any TTL (previously documented as 60 seconds) would have to be implemented elsewhere" — a denial, not a retention | absent; no `clear()` reference                                                                                 | none                            | destructive loss                    |
| `fc-A-r3-H02` | asserted "No expiry logic exists in `src/cache.ts`" — contradicts the valid fact                                                                | `clear()` mentioned ("an in-memory Map; `clear()` empties it") — mechanism retained, deploy trigger not stated | partial (deploy mechanism only) | destructive loss of the expiry fact |
| `fc-F-r2-H02` | absent                                                                                                                                          | absent                                                                                                         | none                            | destructive loss                    |

The finalist (`fc-F-r2-H02`) deleted both valid facts outright. Its
replacement is otherwise a correct, well-placed correction of the stale claim;
the loss is what makes it adverse. The control's two flagged trials did the
same, the second retaining only the `clear()` mechanism.

**Consequence.** B breaches the authorising preservation guardrail (destructive
loss of valid content). The original production-review qualification, which
applied the narrower rule, is **withdrawn**. Utility remains reported
separately and unchanged: screening B 15 vs A 9; confirmation B 12 vs A −11.

## Confirmation order deviation

The 20 finalist confirmation sessions ran **after** all 20 control sessions,
not interleaved. A runner path-case defect made the finalist slots fail before
any model call (exit 127, no session), and they were resumed after the control
slots. Evidence: the `executed_at` column in
[the trial table](assets/description-recording-prose-fresh-trials-2026-11-10.csv)
and `executionOrder.confirmation` in
[the provenance](assets/description-recording-prose-fresh-provenance-2026-11-10.json)
— control 08:55:58–09:08:01Z, finalist 09:09:02–09:21:01Z.

Consequences: the comparison is **exploratory** under that deviation; frozen
pair-order alternation was not achieved, so the results must not be described
as temporally paired by scenario/repetition. Drift between the two arms'
windows is uncontrolled.

## Half-fix classification inconsistency

Screening NOTE-02 produced four trials that documented a Node 22 floor after a
half-fix. The judge scored the control's one (`fr-A-s1-NOTE-02`, which stated
the engines field "accepts Node 22 or newer") as `useful-update`, and the
equivalents in D, E and F as `misleading`. That distinction is **unresolved**
pending a uniform assessment of the same document shape under one rubric.

The recorded alternative calculation treats all ten NOTE-02 in-place updates as
useful and leaves B first (15 vs 9); it is sensitivity to that inconsistency,
not evidence that the categories are sound.

## Confirmation gain, stated precisely

B − A = 23 points in confirmation, composed of: two additional useful creates
(+10), one additional useful update (+5), one fewer misleading outcome (+5),
one fewer primary failure (+5), offset by two additional transient notes (−2).
Screening's better restraint does **not** describe confirmation: in
confirmation B wrote more transient notes than the control, not fewer.

## Arithmetic corrections to the published handback

Against control A's 415 characters: B +14 (429), C +180 (595), D +474 (889),
E +753 (1168), F +928 (1343). The earlier handback's "D/E/F added 174–928
characters" was wrong. Additional length is described fairly: B is
near-identical in length; the larger packages did not win this small screening,
which is not evidence that longer prompts are inherently worse.

## Exact text

The rendered handback flattened Markdown code spans. The literal bytes of all
six descriptions, with character counts and SHA-256, are committed at
[the candidate asset](assets/native-description-candidates-2026-11-10.json).

## What remains unestablished

- No uniform preservation audit of all 88 trials; only the three flagged
  replace-target cases were inspected.
- Whether the cache-note losses reflect the scenario's strict retention
  requirement, the prose, or ordinary model editing behaviour. This is a
  plausible explanation, not a tested finding, and the scenario is not declared
  an artefact.
- Whether the half-fix classification inconsistency is stable.
- Delivery of a description to sessions that never call the tool.
