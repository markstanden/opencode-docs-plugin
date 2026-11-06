---
Area: quality
Keywords: lcov reporter, test coverage, silent exit 1, exactOptionalPropertyTypes, instrumentation scoping, opencode-docs-plugin
Summary: A test run whose only reporter is lcov writing to a file exits 1 with no console trace and no named failure — instrumenting the test files themselves flaked it, and the scoping flags are what keep it green.
---

# A coverage run can go red with no named failure: the lcov-only reporter hides everything

Recorded 2026-11-06 while settling the post-merge reds after the revision work (PRs #17–#19).

## Facts

- With `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=<file>`, all runner output goes to the destination file. The console is empty by design, so an exit 1 carries no failing-test name and no stderr — the Sonar workflow's log ends after the bare `npm run test:coverage` line.
- The package's `test:coverage` npm script instrumented the test files too (no `--test-coverage-exclude`). Unscoped, it exited 1 in roughly one run in ten on this machine, and in CI on main after the #17 merge (run 42241212201).
- The defined gate's own coverage command in `.defined.json` has always carried `--test-coverage-include='src/**/*.ts' --test-coverage-exclude='**/*.test.ts'`. Its runs were clean throughout (10/10 locally when the unscoped script was not). The npm script now matches it (merged as #18).

## Inferred

- Instrumenting the test files themselves is what destabilised the run; the child-process tests (revisions.test.ts spawns `node -e` racers and `sha256sum`) likely aggravate it. This is a Node test-runner behaviour, not a fault in any of the 428 tests.

## Tested

- 20-run A/B on this machine: unscoped 9/10 clean with one silent red; scoped (gate command) 10/10 clean.
- After the script fix, the CI red persisted once more (run 42242794555, also silent) — that one was a genuinely narrow race assertion, see the busy-lock-loser doc; the taskset soak then went 5/5 clean and main's post-merge went green again (run after 17cbeae).

## Open questions

- Whether the silent-red behaviour deserves an upstream Node report; the repro needs the lcov-only file reporter plus test-file instrumentation.
