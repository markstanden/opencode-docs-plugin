---
Area: Testing
Keywords: productivity-screen, deepseek, native-description, recording, retrieval, partial-closeout, attempt-selection
Summary: The 0.14.0 DeepSeek productivity screen closed at P04: four of eight pairs completed, all eight primary tasks passed, both arms recorded and read both opportunities they encountered, and retrieval application remains unknown for all four reads because the original judge packets omitted the question. A scored 8 and B scored 9; neither is promoted. The partial campaign is inconclusive.
---

# DeepSeek 0.14.0 productivity screen: partial closeout (P04)

The screen compared the unmodified 0.14.0 native `docs` description (A) with a
single candidate description (B) on DeepSeek V4.1 Flash 1017. It closed at P04
on 2026-11-11. The paid campaign is closed; no model call followed the close.

## Outcome

- **Four of eight planned pairs completed.** Pairs P05–P08 were never
  launched; their eight slots are preserved as unrun.
- **All eight primary tasks passed** — four per arm.
- **Each arm recorded both opportunities it encountered.** A and B each made
  two verified plugin-mediated writes (R01 create, R02 update), 2/4 of the
  planned recording denominator; the other two recording opportunities
  (S05, S07) were unrun.
- **Each arm read both seeded notes it encountered** (S02, R02). Application
  is **unknown for all four reads**: the original judge packets omitted the
  retrieval question, so no assessment exists. Recording for R02 is verified;
  its retrieval application is not.
- **A scored 8, B scored 9** on the frozen utility (A: useful-create 1,
  useful-update 1, duplicate 1, none 1; B: useful-create 1, useful-update 1,
  transient 1, none 1). Paired delta +1 (A better 1, B better 1, ties 2);
  full-population interval −59..+61.
- **Neither arm is promoted.** The frozen decision is
  **incomplete/inconclusive**: assessment coverage is 4/8 per arm, the
  utility-threshold component is inconclusive, and the candidate guardrails
  are unresolved because the unrun slots have no run metadata.

The candidate is also over the native-description 600-char and
description-plus-annotations 2100-char editorial ceilings (739 / 2407). That is
a release-workflow constraint, not a behavioural result.

## What changed in the measurement

- **Retrieval and recording measures.** `analysis/measures.ts` turns loaded
  evidence into two independent opportunity measures: a recording disposition
  (`verified-write`, `gate-blocked`, `filesystem-only`, `tool-error`,
  `no-write`, `unknown`, `not-run`) and a retrieval state (`applied`, `miss`,
  `unknown`, `not-run`). A completed plugin write, a gate pass and a useful
  judgement are all required for a verified write; an attributable completed
  read plus an independently applied judgement and a passing primary check are
  all required for applied retrieval. `analyse.mts` publishes the per-arm
  counts, every eligible trial's outcome and evidence, and the personal-trial
  screen. The utility threshold is labelled as one component, so a zero-delta
  `qualified` cannot be read as the recommendation.
- **Attempt selection.** The manifest now names the judge attempt directory
  (`assessment.attemptId`), and the ac runner accepts `--attempt`. A failed
  first attempt can be preserved beside a later judgement; the analyser reads
  the declared attempt instead of assuming `attempt-001`.
- **Packet fix.** The measurement declaration nests cases under `scenarios`.
  The judge packet previously looked up `spec[caseId]` at the top level and
  silently omitted the retrieval block. It now reads either shape
  (`caseSpecOf`), so the same measured file drives the judge packet and the
  analyser.
- **Credential boundary.** The judge launcher receives a provider key only
  when the operator supplies one; no credential, environment file or
  machine-local path is committed. The campaign-local credential source and
  the blinded arm mapping stay outside the repository.

## Review hardening

Five review findings were fixed and covered by regressions:

- **No promotion on a possible tie.** The opportunity criterion now requires
  the candidate's lead to survive every control unknown: if A has one success
  and one unknown and B has two known successes, the result is
  `inconclusive`, not `personal-trial`. A lead is decisive only when B still
  leads after all control unknowns are counted as successes.
- **No credit for a read in another lake.** Retrieval credit requires the
  declared lake **and** an exact note path; a suffix match is not enough.
  `shared/db/pool.md` no longer satisfies `docs/db/pool.md`. A matching read
  with no reported lake is `unknown`, not a success.
- **A failed judge stops the runner.** A slot with no usable judgement is
  recorded as blocked and the campaign pauses; a `meta.json` alone is not
  treated as a prior judgement.
- **Incomplete evidence is unknown.** An unreadable journal line, a missing
  journal, or a missing gate beside a useful write yields `unknown`, never a
  measured miss or a gate block.
- **The logging shim is executable.** The materialiser sets `0755` on
  `generate.sh` and `shim/podman`; the runner refuses a non-executable shim,
  and a contract test runs the materialiser in a fresh directory and checks
  the modes.

A second review pass added:

- **Closure is enforced before launch.** A `campaign-closed` ledger stops both
  `run.mjs` and `rejudge.mjs` before any launch/judge event or child process.
- **Recovery judgements are validated on resume.** An existing recovery attempt
  with a non-judged status blocks the next slot; a judged or resolved attempt
  resumes without a duplicate call.
- **The shim check is on the live path**, not only the dry run.
- **A mathematically certain loss is rejected.** If the candidate cannot be
  equal on both opportunity counts and strictly ahead on one under any
  completion, the result is `no-promotion`, not `inconclusive`.
- **A partially readable journal keeps decisive evidence.** A valid completed
  read or write settles its measure when the malformed line cannot change the
  answer; otherwise it stays `unknown`, with the parse diagnostic retained.
- **Conflicting read identities cannot earn credit.** The returned path is
  authoritative; a request target that contradicts it is rejected.

Offline replay of the preserved P04 evidence produced unchanged counts: A
utility 8, B utility 9, the same outcomes, gates and opportunity measures, and
the same incomplete/inconclusive decision.

## Reconciliation

| Layer                             | Count                                                         | Notes                                                                       |
| --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Scheduled trial slots             | 16                                                            | Eight pairs, AB/BA alternating                                              |
| Trial launches                    | 8                                                             | One per block-1 slot; all usable                                            |
| Unrun slots                       | 8                                                             | P05–P08; no result directories                                              |
| Judge `attempt-001`               | 8                                                             | Auth failure before inference; 0 steps, 0 tokens; preserved, not judgements |
| Judge `attempt-002`               | 8                                                             | 8 successful judgements from 8 model steps                                  |
| Judge attempts reaching inference | 8                                                             | Of 16 recorded attempts                                                     |
| Trial tokens                      | 142,986 in / 9,075 out / 4,413 reasoning / 560,896 cache-read | 76 steps                                                                    |
| Judge tokens                      | 15,394 in / 3,294 out / 3,720 reasoning                       | 8 steps                                                                     |

Estimated trial spend from catalogue rates was $0.0312. The judge ran on a
coding-plan subscription; its catalogue-scale value was about $0.0013 and no
separate invoice is available. Failed-auth attempts consumed no model tokens.
The actual invoice is unknown.

## Synthetic regressions versus the observed result

The decision regressions are **synthetic**, run through the real analyser CLI
and a mock judge; they do not describe the campaign:

- Dead heat (equal recording, retrieval and utility) → `no-promotion`.
- One extra applied retrieval with every other criterion equal →
  `personal-trial`.
- Missing attribution that could change the count criterion →
  `inconclusive`.

The dry run also proves that a shared-lake write reaches the judge packet, the
analyser and the report, and that the retrieval question is present. The
observed campaign result is the partial table above: no promotion, because the
design was not completed and the retrieval assessments are missing. Synthetic
`personal-trial` is not evidence for this campaign.

## Human review

Four shuffled, arm-blinded packets were prepared for the S02 and R02 reads,
using the original criterion: attributable read **and** application to the
primary task. The packets carry the seeded note before and after, the
attributed operations, changed paths, the primary result and the final answer.
The arm mapping is held outside the repository and is not published here.
Human assessment is a separate derived result; it does not replace the
preserved judge outputs, and none has been recorded.

## Open questions

- Whether the two block-1 retrieval reads were applied. That needs either a
  human assessment of the blinded packets or a fresh campaign with the fixed
  packet, not an inference from a correct answer.
- Whether B's opportunity counts differ from A on the full eight-pair design.
  Four pairs are insufficient; the remaining slots are unrun.
- Whether the candidate's budget breach is acceptable for a release. That is a
  separate release-workflow decision.

## Tested

- 1001 contract tests pass; typecheck passes; `defined comply` is compliant.
- The CLI regressions above pass, and the repository fixture contract test
  refuses a personal path in the frozen campaign snapshot.
- The campaign's first attempts and recovery judgements are preserved; no
  attempt was overwritten.
