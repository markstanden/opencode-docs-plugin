<!-- update: agent=opencode | date=2026-11-13 | scope=AGENTS.md -->

# AGENTS.md

Repo notes for agents. The gate's own guidance is spliced below between
<!-- defined:start -->

This project is gated by Mark's portable defined gate. Run `defined comply` —
bootstrap, repair and verify in one pass. (`defined verify` is the
pipeline-only read-only check.) A missing ecosystem skips; a missing tool
fails loudly.

**When to run it.** After a coherent set of edits, before committing or
handing work back. One run after a batch beats one per file.

**Reading the result.** Both verbs print one compact JSON line: `status` and
actionable `errors` — read the errors instead of re-running tools by hand;
`--full` adds the per-check `results` map on a first, contextual run.

**After a run.** `git diff`: repairs are real edits to your tree. Fix
findings, then rerun — do not repeat an unchanged failing command. If a check
could not run at all, report the failing step and its error rather than
retrying it as-is. Do not weaken or disable a check just to get green — fix
the finding or raise it upstream.

**What the gate owns.** Bootstrap seeds house defaults (`.editorconfig`,
`.gitattributes`, `Directory.Build.props`) that this project then owns, and
manages plumbing (the CI workflow and this block), realigned on each run.
Edit the seeded defaults here as you wish; raise changes to managed files and
house standards upstream — never fork them locally.

**Public APIs are documented.** Doc comments carry purpose, parameters,
returns, constraints — never name-restating filler; small, well-named private
helpers need no block. The gate proves the sections exist; reviewers prove
the words match (`defined explain jsdoc/require-jsdoc`).

**Knowledge is documented.** Sectioned docs under `docs/`:
`Area`/`Keywords`/`Summary` front-matter, `Date` derived from git, claims
grouped Facts / Inferred / Tested / Open questions. Convention and scrub
checklist: `standards/documentation.md`.

**Looking things up.** `defined explain <step-or-rule>` serves house guidance
from the pinned image — offline, no repo writes, matched to the revision that
gates you; prefer it over reading the upstream repository. House standards:
`standards/` (tests, naming, API documentation, shell, YAML) and
`practices/architecture.md`. Tighten the floor; don't fork it.
<!-- defined:end -->

## What this is

An OpenCode V2 plugin package: `src/index.ts` is the plugin (the `docs` tool,
the `/docs` command, and the `docs` skill), `tests/` is its Node test suite.
Everything below the default export is pure or dependency-injected and directly
testable.

## Test conventions

- Node's built-in runner, `node --test`; assertions from `node:assert/strict`.
- The plugin source runs under Node's type-stripping (`noEmit`,
  `erasableSyntaxOnly`), so the file OpenCode loads is the file under test.
- `tests/docs.test.ts` imports the plugin statically, so the tests are
  typechecked too — keep it that way; do not reintroduce a dynamic import of a
  computed path, which degrades every export to `any`.
- `tests/fixtures/docs-corpus.json` is a hand-authored synthetic corpus
  (invented paths, summaries, identifiers); edit it directly when the ranking
  harness needs a new shape — never snapshot a real tree into it.

## Test isolation

- Tests own their world: `mkdtempSync` directories, fixture git repos built
  inside them, test-owned ports and child processes closed by the test.
- No import-time read of the enclosing checkout's `.git` or `HEAD`: the gate
  copies tracked sources into a `.git`-less scratch, and an import-time git
  read dies there invisibly under the lcov-only reporter
  (docs/testing/prod014-campaign-status-2026-11-12.md).
- Fixture commits are hermetic: identity inline (`git -c user.email=t@t -c
user.name=t`), signing and ambient config walled off
  (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`); never touch the user's global git config.
- The ordinary suite needs no credentials and makes no provider calls;
  model-facing work has its own entry points (TESTING.md routes them).

## Routing

- Routine test operation, task selector, troubleshooting: TESTING.md.
- Registered prod014 campaigns: the campaign README under
  tests/fixtures/placement-harness/prod014/campaign/ and its read-only
  status.mts. `/placement` and the placement-trials skill are for
  unregistered sweeps only and never override a registered campaign's frozen
  models, ceilings or attempt selection.
- Handbacks and trial reports: templates/agent-handback.md and
  templates/trial-feedback-report.md — output contracts, not authority.

## Trial harness

- Decision-bearing campaign code is strict TypeScript under
  `tests/fixtures/placement-harness/analysis/`; `npm test` runs its contract
  and materialised-CLI regressions on CPU with no provider calls. Keep
  filesystem, process, clock and provider effects in thin adapters.
- `tests/fixtures/placement-harness/prod014/campaign/scripts.json` is frozen
  historical data for replay. `materialise.mts` verifies it and also copies
  the pinned runner modules listed in `runner.json`; regenerate the snapshot
  and pins (`materialise.mts --snapshot`) whenever a pinned module changes.
- Parse external evidence as `unknown` at the boundary and keep missing,
  malformed and unknown as distinct states. A journal line, ledger event or
  answer earns credit only through the checked evidence boundary.
- A heavier offline rehearsal (real container, fake provider, counting
  launchers) is a separate documented step; it is not part of `npm test`.

## Verifying

```bash
npm test          # node --test
npm run typecheck
defined comply    # the verdict — bootstrap, repair and verify
```

**PR verification.** Run final verification from a clean checkout of the
intended PR head. Record `git rev-parse HEAD` and check `git status
--porcelain` in that same checkout after `defined comply --full`. If the gate
repairs files, review and commit the repairs, then verify the resulting
commit. Report the tested SHA, post-gate tree state and CI verdict for the same
pushed head. The managed _After a run_ rule above governs the repair loop; this
adds the checkout identity and same-SHA confirmation the gate cannot make.
