---
Area: Testing
Keywords: prod014, campaign, status, operator, defined, verify, comply, checkpoint, spend, read-only
Summary: A read-only status command beside the prod014 campaign tooling gives one typed observation — identity, readiness, preparation, ledger position and spend, checkpoint freshness, and one next action — with four operator-guidance invariants pinned by regressions.
---

# prod014 campaign status: one read-only operator observation

`tests/fixtures/placement-harness/prod014/campaign/status.mts` answers, in one call, what a fresh operator is looking at, what has actually been verified, what has been spent, and what to do next. It is operator-side: run from the operator checkout, never materialised into a campaign root, and outside every freeze inventory (those cover a root's `prepare/` and `runner/` only).

## Facts

- **Interface.** `--base <rev>` observes a checkout before any root exists; `--root <path>` observes one campaign; `--report-root <dir>` is explicit and never scanned for. `--json` projects the same typed result machine-readably (errors under `{"status":"error","errors":[{code,message}]}`), `--detail` expands evidence. Exit codes: 0 observation made (stopped, closed and blocked campaigns included), 1 broken invocation, 2 unreadable evidence (root missing/not a directory, or schedule/manifest/FROZEN present but unparseable).
- **Authority order** mirrors `run.mts`: credential mode first, then interrupted close, closed ledger, unresolved reservation, malformed ledger, unreadable spend, frozen premise, non-executable shim, missing prerequisites, then progression. A recorded stop — a mid-flight slot, `judge-refused`, `failed-unusable` — outranks generic checkpoint or resume advice.
- **Ceilings** come only from `FROZEN.json` → `freeze.ceilings`; a missing or legacy record reads as zero and blocks every claim. Spend counts claim files from creation; a reservation does not establish a live process.
- **Freeze integrity** uses the existing `verifyFreeze` over local inputs (files, inventories, image id, source revision via `CAMPAIGN_SOURCE_REPO`). `run.mts --dry-run` writes no durable record, so dry-run success is permanently `unverifiable` and the report says so with the exact command.
- **Four review-pinned invariants** (regressions in `tests/campaign-status.test.ts`):
    1. Never pass a variable you intend to expand through `shellQuote` — the checkout setup command emits `"$CAMPAIGN_ROOT"` in double quotes; a copy-and-run test executes it verbatim in a disposable checkout and asserts the allocated absolute root exists and no literal `$CAMPAIGN_ROOT` directory appears.
    2. A first-block resume is bounded by `--pair-to 4`: no suggested range crosses the mandatory P04 checkpoint. `completedPairs === 0` is not proof of "never dispatched" — a stopped first pair is detected from claims, launch events and slot state.
    3. A claim read that fails is **unknown spend** (`used`/`remaining` null, phase `blocked-unreadable-spend`, no paid suggestion); only an absent claims directory is known zero. Empty claim lists must never display the full allowance as available.
    4. Report freshness needs a matching manifest hash **and** a receipt render time **and** a ledger comparison. The manifest spans P04 and P05, so a hash match alone is `indeterminate`, never `current`.
- **Gate formatting trap (confirmed again).** `defined comply` repairs formatting in the tree it runs in. A "compliant" comply inside a mirror, clone or operator checkout leaves the _committed_ bytes unformatted, and CI's read-only `defined verify` then fails prettier. Copy the repaired files back and commit before pushing; see `doclake:opencode/gating-a-git-worktree-needs-a-clone-mirror.md`.
- **Root cause of the silent coverage failure (2026-11-13).** The chain is:
    1. CI runs read-only `defined verify`; the gate copies the tracked git scope (`git ls-files`) to a `/tmp` scratch and runs the coverage command there. The scratch has no `.git`.
    2. This suite derived `BASE` at import with `git -C <checkout> rev-parse HEAD` and used it both as every synthetic `FROZEN.json` `sourceRevision` and as `CAMPAIGN_SOURCE_REPO`. In the scratch that command throws `fatal: not a git repository`, so **module evaluation failed before a single case ran** (the runner then reports the whole file as one failed test).
    3. The configured command's only reporter is `--test-reporter=lcov` writing to `coverage/lcov.info`, which replaces the default spec reporter. An import-time exception is therefore not printed anywhere the gate can see; the process exits 1 with empty stdout and stderr.
    4. The gate reports exactly what it observed: `node-coverage: coverage command failed: exit 1: no output`. Coverage itself was never the problem — the suite never generated any.
    5. Locally the checkout has `.git`, and a writable-mount run uses the repo itself, so both masked it. The fix builds a fixture source repo under `/tmp` (the pattern `campaign-materialised-freeze.test.ts` already used) and points `CAMPAIGN_SOURCE_REPO` and every frozen `sourceRevision` at its HEAD; a regression pins `BASE` to that fixture repo rather than the checkout.
- **Not a gate defect, but a gate blind spot.** `defined` cannot know a consumer's reporter swallowed its output. The maintainable fix is consumer-side hermeticity (above); the upstream improvement would be for the gate to warn when a coverage command exits non-zero with no captured output that the reporter may have hidden the diagnostics.

## Tested

- 53 focused cases drive the real CLI over synthetic roots; the full suite is 1215 tests. Coverage includes checkout modes, the preparation walk, changed frozen inputs, declared/delivered mismatch, credential-mode categories with canary redaction in success and error paths, the full ledger lifecycle, ceiling exhaustion, closed campaigns with reconciliation, stale/indeterminate/wrong-campaign reports, malformed and mid-read ledgers, byte-for-byte idempotence, a podman trap asserting zero dispatch, and agreement with the real `analyse.mts` over the mini corpus.
- Handback fixtures verified: a clean checkout emits the runnable materialise command; a clean pause after P01 suggests `--pair-from 2 --pair-to 4`; a P05 B `judge-refused` after a usable trial (released claim) yields `stopped-slot` inspection, not a range.
- Local gate on the exact merge content in a normal checkout: compliant, every check passing, including `node` (prettier) and `node-coverage`.
- Read-only `defined verify` in the pinned image reproduces CI exactly, and after the fixture-repo fix reports `node-coverage` passing with the status suite running to completion in the `.git`-less scratch.

## Failed approaches

- `shellQuote("$CAMPAIGN_ROOT")` for the setup command: single quotes suppress expansion, so `mkdir` and the materialiser targeted a literal `$CAMPAIGN_ROOT` directory.
- Fixed `--pair-to 8` on every resume: crosses the P04 checkpoint; combined with treating zero completed pairs as zero dispatched, it offered a dry run over a stopped first pair.
- Swallowing claim-read failures to `0` used or an empty claim list: displays the full allowance when the evidence to establish spend is unreadable.
- Labelling a report `current` on a matching manifest hash alone.
- Reading the checkout's own `HEAD` at import for `CAMPAIGN_SOURCE_REPO`: passes locally, but the read-only gate copies the tracked git scope without `.git`, so the whole status file died before any case ran and the lcov-only reporter surfaced it as `coverage command failed: exit 1: no output`. The suite now builds a fixture source repo of its own, as the materialised-freeze suite already did.

## Open questions

- Whether `defined` should warn when a coverage command exits non-zero with no captured output: a file-level import failure hidden by an lcov-only reporter is indistinguishable from a silent tool crash, and the current notice names neither.
