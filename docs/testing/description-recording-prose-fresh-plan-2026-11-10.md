---
Area: Testing
Keywords: description-prose, native-description, automatic-notetaking, note-01, note-02, note-03, note-04, held-out, deepseek, glm, frozen-plan
Summary: Frozen two-stage comparison of six native `docs` description prose packages under one shared experimental budget, scored by a structured arm-blind documentation-outcome schema, with four sealed held-out scenarios for confirmation.
---

# Native-description prose comparison: frozen plan, 2026-11-10

Frozen before any scored session. Base is current `origin/main`
`5ea4a71e9174d638145e16c7f9508357c47542fc` (adds templates; the plugin bytes
are unchanged since PR #47's `5ecbef3`). This campaign is new and is not
pooled with the selective-append, memory-framing or blind-audit populations.

## Question

Which of six substantially different native tool-description prose packages
produces more useful, verified documentation at an acceptable cost — measured
as a weighted documentation outcome plus the independent primary-task result —
and does the best candidate survive fresh confirmation on sealed scenarios?

Directional expectations, recorded before results: the control (A) is
descriptive rather than instructional and historically missed NOTE-01 creates;
B is the previous memory-framing candidate, which showed a positive-recording
gain and a restraint cost; C–F progressively add authorisation, future-reader
purpose, an explicit decision procedure and worked examples. Length is not
assumed to help.

## Six exact descriptions

Only the native `docs` description differs between arms. The twin
description, `src/SKILL.md`, `CONVENTION.md`, `package.json` and
`package-lock.json` are byte-identical; each arm's diff against the
measurement commit touches `src/index.ts` only.

| Arm | Native chars | Description + annotations | Native SHA-256 |
| --- | --- | --- | --- |
| A | 415 | 2073 | `c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c` |
| B | 429 | 2087 | `09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e` |
| C | 595 | 2253 | `8238063d5918e55de9cb47b4b2d1e4590c1ad6ddccfaab6162a75cf2284391ff` |
| D | 889 | 2547 | `4eefa38d47d79b7bfbf6b251dabeda9f9ad015a68f6bd0971a6fc987425cbdef` |
| E | 1168 | 2826 | `f1f53d96f968ecd381417bd96e1203d57489517b728ad5893e4bb0d8b4dbe117` |
| F | 1343 | 3001 | `8223b356b5f3157568be7036030c87bbc3ef298c90ca9040f74a89729efbacc9` |

Annotation payload is 1658 characters on every arm. The frozen **shared
experimental budget** is 1400 native characters and 3100 description-plus-
annotations characters, sufficient for the longest arm (F, 1343/3001). The
production ceilings (600/2100) are unchanged on `main`; the measurement
commit widens the test-only budget so no arm is rejected for length before it
runs.

### A — current control (historical text, verified byte-exact)

Search the configured knowledge lakes and nested project `README.md` files before a broad grep for how-to knowledge. A blank search lists recent docs; `help` shows the lakes and ranking. `read` returns a lake doc verbatim plus its revision token; `instructions:` results open with the built-in read tool. `add` creates or replaces a knowledge doc (replace needs that revision); `check` audits convention compliance.

### B — previous memory framing

Search configured lakes and nested `README.md` files before a broad grep. When a durable decision or recurring trap emerges, record it with `add` (create/replace); never record transient state, and update rather than duplicate. `help` lists lakes/ranking; a blank search lists recent docs. `read` returns a doc and the revision `replace` needs; `check` audits convention; `instructions:` results open with the built-in read tool.

### C — direct instruction, compact

Search configured lakes and nested `README.md` files before broad how-to grep. When authorised, save verified project knowledge that will help a future task. Search for existing coverage: update stale or incomplete knowledge; create only when useful knowledge is missing. Skip session status and generic advice. `help` lists lakes and ranking; blank search lists recent docs. `read` returns a document and its revision token; `add` creates or replaces it, with the revision required for replacement. Open `instructions:` results with the built-in read tool. `check` audits convention compliance.

### D — purpose and future-reader value

Use this knowledge store to spare the next person or agent from repeating useful investigation. Search configured lakes and nested project `README.md` files before a broad grep for how-to knowledge. When authorised, preserve verified project decisions, constraints and recurring traps that would change how a future task is done. Correct existing knowledge when it is stale; add a new document when valuable knowledge is missing. A task can be complete without a note: temporary session state and generic advice rarely help the next reader. Record the finding and its evidence, not a diary of your work. `help` shows lakes and ranking; blank search lists recent docs. `read` returns a lake document and revision token. `add` creates or replaces a document; replacement requires that revision. Open `instructions:` results using the built-in read tool. `check` audits convention compliance.

### E — explicit decision procedure

Search configured knowledge lakes and nested project `README.md` files before broad how-to grep. When a task establishes a possible documentation finding, use this decision procedure:
1. Check permission to write and verify the finding against available evidence.
2. Ask whether it is project-specific knowledge likely to help a later task. Do not save temporary session state, unverified guesses or generic advice.
3. Search for existing coverage and read relevant documents. If the finding corrects or materially extends one, update it. If useful knowledge is missing, create a concise document. If coverage is already sufficient, leave it alone.
4. Preserve valid existing content and record only the supported claim, with relevant evidence and limits. Check that the write succeeded. Do not let optional documentation displace the requested task.
`help` shows the configured lakes and ranking; blank search lists recent documents. `read` returns a document verbatim and its revision token. `add` creates or replaces a document; replacement requires the revision token. Open `instructions:` results with the built-in read tool. `check` audits convention compliance.

### F — examples and counterexamples

Search configured knowledge lakes and nested project `README.md` files before broad how-to grep. When authorised, preserve verified knowledge that helps future work; prefer correcting existing coverage to creating a duplicate.
Examples: if you verify that a repository's documented build prerequisite is obsolete, update that document while preserving its other valid guidance. If investigation establishes an undocumented recurring integration constraint, save the constraint, evidence and practical consequence. If an existing document already explains the finding accurately, no write is needed.
Counterexamples: a temporary process identifier, this session's successful command, a one-off local workaround without evidence of recurrence, or general programming advice is usually not useful project knowledge. A transient symptom can still reveal a durable lesson: record the verified recurring cause or constraint, not the temporary symptom. Never invent a lesson just to leave a note. Complete the requested task and verify any documentation write.
`help` shows lakes and ranking; blank search lists recent docs. `read` returns a document verbatim and its revision token. `add` creates or replaces a document; replacement needs that revision. Open `instructions:` results with the built-in read tool. `check` audits convention compliance.

## Source and measurement identities

| Identity | Value |
| --- | --- |
| Repository / checkout | `markstanden/opencode-docs-plugin` at `/home/mark/repos/opencode-docs-plugin` |
| Base commit | `5ea4a71e9174d638145e16c7f9508357c47542fc` |
| Measurement commit (every arm's parent) | `902a6fe65ecff4cfea0358ae165e21e4f441f003` |
| Arm A execution commit / tree | `902a6fe65ecff4cfea0358ae165e21e4f441f003` / `bf553bfce11410d33d68e8232949437952fdb055` |
| Arm B execution commit / tree | `454279001ac6c46394ff14fd34b35220f099d252` / `5c7dd5c9da705274ee859096fe0c095fffc1cba1` |
| Arm C execution commit / tree | `bbc75a2d01290aab4b10adad610a2b6e38602133` / `038c8ce266b52a6894dddf4775b3541baf9f30e1` |
| Arm D execution commit / tree | `49edaea0337c928c77bbee54e2b9ff398437e9a5` / `85ad24dbeae36dfc8d73c7355836d1842991f076` |
| Arm E execution commit / tree | `f12e917789eb483f1a4120592374adaf5d14482a` / `fd7f77ca39fdbf40a2fe2e42e458daf28f4a8a43` |
| Arm F execution commit / tree | `3a32fc303d2d1d614820f066509225aeada13594` / `931bda0e19ecf21127cc6e5f0b54b9fc5c377202` |
| Plugin content hashes A–F | `1b2b0319759cfe7a48373ab72b946d3ab416e91e1d0ec597349da82fd5d05df8`, `04535cf3b9efece2edb9cc72e1dbbe57fa36e269688623c9d6eac61ee30bbd88`, `743eda2167021feda0e62c3d71ed047e02d27ff186796df04b5c8fcd17800ed8`, `248509864ed34cea8fa6034d076cacb9bdc4a60bb7976bb1222ebf7ed42a03ce`, `104177e666f6fa36db5cd96d8b2df79d9f1b63b72e93cf769a5c42aefb740006`, `1033b34d770238d7546de75b5ebb32cdbda8b5a37dc51bfce8c03e482002afff` |
| Lockfile hash (all arms) | `d376fb423c07…` |
| Trial corpus | `f975698048c61af6a8a0d03008fdf175a75e15435eb6d356c40ef5ad11e00130` |
| Held-out corpus (sealed) | `2bc81b662a7e16caef49b5dbaf12b3f4744ac397b1fc3bcfaf9ee7eb59a3ce3c` |
| Scenario truth | `2244f97654a4dfe66c7eb95b4b3cb3577dabbe00af005d607e2b88992cd121b7` |
| Harness | `a4d48866559e1318a8267f38f27892ba352656a2c6a59b108aa27917774a0d6c` |
| AC scoring module | `1d5757d6306aff37d218ba9804132801c6c81425243b5c93dd9363e8121a6736` |
| AC judge launcher | `8cabddf4aec0f1bc1965816927393aa9b6a75f4a96ebe8d30a6706d71addd0ca` |
| Frozen schedule | `f96edba77252ae02fbad107793834e12075116723948ee4e3ec4007287fa87c8` |
| NOTE-01 / NOTE-02 / NOTE-03 / NOTE-04 primary checks | `9aade3113e7be05596882dab1b3cb0c6a55195ec373dabee561f62950117ab47`, `55d708a0defabc5c5487591c70f208135e40a133acb8e4997930f3499f276f7f`, `6a037bed1605a73a79ea0fa3321a03a104c7c1456593e1ceeb3b1c2fe8e7d715`, `6a093090abba25cd25f72eb69f56fd15edb683900c9b3520ac51f1473e3fa445` |
| H01 / H02 / H03 / H04 primary checks | `8d64ae9600d4d58f662cd38e125f787292c767ab10ed739b5cdd9bd4179e4c35`, `88556ded0e5abe5a68a044100acdf5e9517f132c7cff1e225f3df3bb92ed5d87`, `ba01c21d94650c5b394a54f38c407b6f109c600a66acf2e28ec7da2896fa0f90`, `9c5e00ceadbc61bbbbf7bc29e2a4c36a95216dcc19391f09ea24ac6dca797502` |
| Workhorse | `opencode-go/deepseek-v4.1-flash` (active) |
| Independent judge | `opencode-go/glm-5.3-flash` (active) |
| Runtime | OpenCode `v2.2.6`; Node `v26.13.0`; image `localhost/opencode-placement-trials`, id `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb` |
| Evidence root | `/home/mark/tmp/docs-desc-fresh-20261110/` (dev-box only) |

Fixed inputs are byte-identical across arms: prompt hashes NOTE-01
`c61b359a`, NOTE-02 `7503338a`, NOTE-03 `c19ab7e8`, NOTE-04 `7ce4aa79`
(unchanged from the previous campaign), the standing permission
`57d0a68a`, fixtures (apart from plugin identity), model, permissions and
scenario rubrics.

## The held-out scenarios (sealed)

Four scenarios were authored for this campaign, each with a pristine primary
check and a seeded deterministic self-test (seeded state fails, intended fix
passes, a plausible wrong fix fails):

| Case | Opportunity | Task shape |
| --- | --- | --- |
| H01 | useful create | server caps export pages at 500 rows, so a short page truncates a 2,500-row export |
| H02 | useful update | cache keys ignore the tenant; the seeded cache note's "globally unique" claim is false |
| H03 | transient only | half-written machine-local `.cache/fmt/manifest.json` after an interrupted build |
| H04 | already covered | `npm run lint` reports `NO_V1_IMPORT` for `legacy/` by design; the seeded note already says so |

Their facts and tasks differ from the NOTE cases and from the examples inside
any candidate text. Authoring limitation stated plainly: this agent authored
them and therefore knows their content; they are held out from
outcome-driven selection (never generated, run or inspected as behavioural
output before the finalist is frozen), not from authorship.

## Measurement

1. **Trial** — the harness runs the arm's plugin in the trial container with
   the shared task permissions. Path authority is the case's own mutation
   policy. The harness runs the pristine primary check after the session.
2. **Gate (deterministic, no model call)** — `judge --gate-only` records the
   harness's own gate verdict in `gate.json`. Blocked and passing gates are
   both outcomes; a gate record is never a semantic verdict.
3. **AC judgement (one model call per completed trial)** — an arm-blind,
   self-contained packet: task, standing permission, scenario truth, lake
   documents before and after, changed paths, primary-check result, verified
   docs operations and the final answer. The judge returns one JSON object:
   `documentationOutcome` (useful-create | useful-update | transient |
   duplicate | misleading | none), a reason and decisive evidence. A judgement
   that contradicts the recorded mutation facts is invalid, not corrected.

Weights (proposed defaults, frozen): useful create/update +5, unnecessary but
correct transient note −1, duplicate −2, misleading/unsupported −5, primary
failure −5, missed opportunity 0, correct restraint 0. Documentation
categories are mutually exclusive with precedence misleading > duplicate >
transient > useful > none. Policy violations and destruction of preserved
content are non-compensable guardrails, reported separately.

Sensitivity, reported not tuned: useful weight 3/5/8 × transient penalty
0.5/1/2, other penalties fixed.

## Frozen schedule

Seed `20261110`; mulberry32 PRNG; arm order shuffled within each
scenario/repetition block; scenario order rotated across repetitions.

### Stage 1 — screening (48 sessions, six arms × four NOTE scenarios × two repetitions)

| Slot | Rep | Scenario | Arm | Stamp |
| --- | --- | --- | --- | --- |
| 1 | 1 | NOTE-01 | B | `fr-B-s1-NOTE-01` |
| 2 | 1 | NOTE-01 | E | `fr-E-s1-NOTE-01` |
| 3 | 1 | NOTE-01 | A | `fr-A-s1-NOTE-01` |
| 4 | 1 | NOTE-01 | D | `fr-D-s1-NOTE-01` |
| 5 | 1 | NOTE-01 | F | `fr-F-s1-NOTE-01` |
| 6 | 1 | NOTE-01 | C | `fr-C-s1-NOTE-01` |
| 7 | 1 | NOTE-02 | B | `fr-B-s1-NOTE-02` |
| 8 | 1 | NOTE-02 | D | `fr-D-s1-NOTE-02` |
| 9 | 1 | NOTE-02 | C | `fr-C-s1-NOTE-02` |
| 10 | 1 | NOTE-02 | E | `fr-E-s1-NOTE-02` |
| 11 | 1 | NOTE-02 | F | `fr-F-s1-NOTE-02` |
| 12 | 1 | NOTE-02 | A | `fr-A-s1-NOTE-02` |
| 13 | 1 | NOTE-03 | F | `fr-F-s1-NOTE-03` |
| 14 | 1 | NOTE-03 | D | `fr-D-s1-NOTE-03` |
| 15 | 1 | NOTE-03 | E | `fr-E-s1-NOTE-03` |
| 16 | 1 | NOTE-03 | B | `fr-B-s1-NOTE-03` |
| 17 | 1 | NOTE-03 | C | `fr-C-s1-NOTE-03` |
| 18 | 1 | NOTE-03 | A | `fr-A-s1-NOTE-03` |
| 19 | 1 | NOTE-04 | D | `fr-D-s1-NOTE-04` |
| 20 | 1 | NOTE-04 | F | `fr-F-s1-NOTE-04` |
| 21 | 1 | NOTE-04 | E | `fr-E-s1-NOTE-04` |
| 22 | 1 | NOTE-04 | A | `fr-A-s1-NOTE-04` |
| 23 | 1 | NOTE-04 | B | `fr-B-s1-NOTE-04` |
| 24 | 1 | NOTE-04 | C | `fr-C-s1-NOTE-04` |
| 25 | 2 | NOTE-02 | D | `fr-D-s2-NOTE-02` |
| 26 | 2 | NOTE-02 | C | `fr-C-s2-NOTE-02` |
| 27 | 2 | NOTE-02 | F | `fr-F-s2-NOTE-02` |
| 28 | 2 | NOTE-02 | B | `fr-B-s2-NOTE-02` |
| 29 | 2 | NOTE-02 | A | `fr-A-s2-NOTE-02` |
| 30 | 2 | NOTE-02 | E | `fr-E-s2-NOTE-02` |
| 31 | 2 | NOTE-03 | E | `fr-E-s2-NOTE-03` |
| 32 | 2 | NOTE-03 | D | `fr-D-s2-NOTE-03` |
| 33 | 2 | NOTE-03 | F | `fr-F-s2-NOTE-03` |
| 34 | 2 | NOTE-03 | B | `fr-B-s2-NOTE-03` |
| 35 | 2 | NOTE-03 | C | `fr-C-s2-NOTE-03` |
| 36 | 2 | NOTE-03 | A | `fr-A-s2-NOTE-03` |
| 37 | 2 | NOTE-04 | A | `fr-A-s2-NOTE-04` |
| 38 | 2 | NOTE-04 | B | `fr-B-s2-NOTE-04` |
| 39 | 2 | NOTE-04 | F | `fr-F-s2-NOTE-04` |
| 40 | 2 | NOTE-04 | C | `fr-C-s2-NOTE-04` |
| 41 | 2 | NOTE-04 | E | `fr-E-s2-NOTE-04` |
| 42 | 2 | NOTE-04 | D | `fr-D-s2-NOTE-04` |
| 43 | 2 | NOTE-01 | E | `fr-E-s2-NOTE-01` |
| 44 | 2 | NOTE-01 | C | `fr-C-s2-NOTE-01` |
| 45 | 2 | NOTE-01 | F | `fr-F-s2-NOTE-01` |
| 46 | 2 | NOTE-01 | A | `fr-A-s2-NOTE-01` |
| 47 | 2 | NOTE-01 | B | `fr-B-s2-NOTE-01` |
| 48 | 2 | NOTE-01 | D | `fr-D-s2-NOTE-01` |

### Stage 2 — confirmation (40 sessions, finalist vs fresh control × four held-out scenarios × five repetitions)

Pair order alternates on (scenario index + repetition) mod 2; scenario order
rotates by repetition. Roles are resolved at selection and never re-drawn.

| Slot | Rep | Scenario | Role | Stamp |
| --- | --- | --- | --- | --- |
| 49 | 0 | H01 | finalist | `fc-F-r0-H01` |
| 50 | 0 | H01 | control | `fc-A-r0-H01` |
| 51 | 0 | H02 | control | `fc-A-r0-H02` |
| 52 | 0 | H02 | finalist | `fc-F-r0-H02` |
| 53 | 0 | H03 | finalist | `fc-F-r0-H03` |
| 54 | 0 | H03 | control | `fc-A-r0-H03` |
| 55 | 0 | H04 | control | `fc-A-r0-H04` |
| 56 | 0 | H04 | finalist | `fc-F-r0-H04` |
| 57 | 1 | H02 | finalist | `fc-F-r1-H02` |
| 58 | 1 | H02 | control | `fc-A-r1-H02` |
| 59 | 1 | H03 | control | `fc-A-r1-H03` |
| 60 | 1 | H03 | finalist | `fc-F-r1-H03` |
| 61 | 1 | H04 | finalist | `fc-F-r1-H04` |
| 62 | 1 | H04 | control | `fc-A-r1-H04` |
| 63 | 1 | H01 | control | `fc-A-r1-H01` |
| 64 | 1 | H01 | finalist | `fc-F-r1-H01` |
| 65 | 2 | H03 | finalist | `fc-F-r2-H03` |
| 66 | 2 | H03 | control | `fc-A-r2-H03` |
| 67 | 2 | H04 | control | `fc-A-r2-H04` |
| 68 | 2 | H04 | finalist | `fc-F-r2-H04` |
| 69 | 2 | H01 | finalist | `fc-F-r2-H01` |
| 70 | 2 | H01 | control | `fc-A-r2-H01` |
| 71 | 2 | H02 | control | `fc-A-r2-H02` |
| 72 | 2 | H02 | finalist | `fc-F-r2-H02` |
| 73 | 3 | H04 | finalist | `fc-F-r3-H04` |
| 74 | 3 | H04 | control | `fc-A-r3-H04` |
| 75 | 3 | H01 | control | `fc-A-r3-H01` |
| 76 | 3 | H01 | finalist | `fc-F-r3-H01` |
| 77 | 3 | H02 | finalist | `fc-F-r3-H02` |
| 78 | 3 | H02 | control | `fc-A-r3-H02` |
| 79 | 3 | H03 | control | `fc-A-r3-H03` |
| 80 | 3 | H03 | finalist | `fc-F-r3-H03` |
| 81 | 4 | H01 | finalist | `fc-F-r4-H01` |
| 82 | 4 | H01 | control | `fc-A-r4-H01` |
| 83 | 4 | H02 | control | `fc-A-r4-H02` |
| 84 | 4 | H02 | finalist | `fc-F-r4-H02` |
| 85 | 4 | H03 | finalist | `fc-F-r4-H03` |
| 86 | 4 | H03 | control | `fc-A-r4-H03` |
| 87 | 4 | H04 | control | `fc-A-r4-H04` |
| 88 | 4 | H04 | finalist | `fc-F-r4-H04` |

## Finalist rule (applied once, after screening)

A candidate is eligible only with complete AC coverage for itself and the
control, no guardrail breach, and a default-utility lead of at least 2 points
over the fresh control across the eight trials. Eligible candidates are ranked
by default total utility, then fewer primary-task failures, then fewer
misleading outcomes, then fewer native-description characters, then arm id.
Exactly one finalist is taken. A single ordinary primary-task failure is not
an automatic veto; it is reported prominently with its frozen penalty. If no
candidate qualifies, the campaign stops at screening.

Confirmation qualifies for a later production review only with complete
coverage, no finalist guardrail breach and a lead of at least 5 points across
20 trials per arm. That is a prioritisation threshold, not significance.

## Caps, stopping rules and failure handling

- Maximum 88 scored sessions and 88 AC judge calls. No retries, no expanded
  candidate search, no extra campaign.
- Readiness/control model sessions: cap eight. Used: six A01 registration
  controls (one per arm) and one successful delivery probe; one probe attempt
  failed before any model call (provider route) and is preserved.
- Preserve first attempts, unusable sessions and judge errors. Resume only
  genuinely unstarted slots. A nonzero gate never aborts the schedule.
- Stop only for a concrete isolation failure, broken fixture reset, wrong
  delivered candidate or measurement corruption.
- No push, PR, merge, release or external action.

## Readiness gate (all passed before scored sessions)

1. Main verified; control description byte-exact (SHA `c3903c7d…`, matching
   the historical frozen control) and identical plugin content hash to the
   previous campaign's arm A (`1b2b0319…`).
2. Six arms exist; each differs from the measurement commit in
   `src/index.ts` only; only native description bytes differ between arms.
3. Delivery verified at the provider boundary: a captured chat request for the
   longest arm (F) carries the native description byte-identically (1343
   characters, SHA `8223b356…`), so no truncation is applied.
4. Deterministic fixture self-tests: seeded state fails, intended fix passes,
   plausible wrong fix fails, for all four held-out cases; the NOTE cases are
   unchanged from the previous campaign.
5. `npm test` 738/738 and `tsc --noEmit` pass on the measurement commit,
   including the new `--gate-only` and AC scoring tests.
6. AC judge plumbing exercised once (readiness) on an existing recorded trial;
   valid schema, coherent "missed opportunity" classification.
7. Fixed inputs, models, runtime and image verified available; schedule
   frozen; no material unresolved measurement blocker.

## Deviations and corrections (recorded before any scored session)

- The prompt transport flattened Markdown code spans. A and B were recovered
  byte-exactly (their SHAs match the frozen historical values); C–F had code
  spans restored on the same convention with wording unchanged.
- Measured annotation payload is 1658 characters, not the 1668 reported in the
  earlier plan; the frozen budget uses the measured value.
- The previous campaign's "authorised writes" arm label is replaced here by
  the explicit arm letters A–F and by neutral packet IDs at judging time.

## What this does and does not establish

It compares six assigned prose packages under identical measurement, with a
structured and separately validated outcome assessment. It does not prove that
any wording causes a difference, does not establish delivery to non-calling
sessions beyond the captured request, and does not authorise production
adoption.
