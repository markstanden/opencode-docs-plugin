---
Area: Testing
Keywords: prod014, judge, blinding, campaign-root, home-path, judge-launcher, freeze, evidence
Summary: The judge wrapper leaked the host campaign path into the judge container's working directory, PWD and config home, so a campaign rooted under /home refused every judgement. The launch now mounts the host attempt directory at a neutral container destination, validates the child-visible context before dispatch and still refuses genuine packet leaks. The existing frozen protocol pins the judge apparatus, so the stopped A trial cannot be carried across this repair.
---

# Judge path exposure repair (2026-11-12)

Follow-up to the 0.14.0 productivity-screen run
`pd-fresh-20261112T171654Z-ae7bf1c`, which stopped at slot 1 because every
judge dispatch was refused. Base revision
`ae7bf1c385954d13f2814aa20ac2c9d4b01f229a`.

## Facts

- `ac/run.mjs` passed `<campaign-root>/evidence/ac-runs/<digest>` to
  `ac/judge-launcher.sh`, and the launcher used that host path as the
  container's mount destination, `-w`, `PWD` and `XDG_CONFIG_HOME`. The label
  guard scanned the same host path, whose `/home/<operator>` prefix matches
  `/\/home\/[^/\s]+/`, so a campaign rooted under `/home` refused before
  dispatch. The packet itself was clean.
- The launcher now mounts the per-attempt host directory at `/judge` (the one
  child-visible destination) and derives `/judge/work` and
  `/judge/config-home` from it. `ac/run.mjs` owns the child context
  (`/judge`, `HOME`, XDG data/cache), passes it by name, and scans the packet,
  the model and exactly those values before dispatch. Host paths are no longer
  scanned because they are mount sources, not judge-visible content.
- Answer-hash binding and journal attribution still run host-side before the
  packet is assembled. A genuine packet leak still refuses with exit 3 before
  any claim, dispatch record or provider request.
- The frozen record's inventories include
  `measurement/tests/fixtures/placement-harness/ac`, so the judge wrapper and
  launcher are frozen inputs. The stopped campaign's frozen hashes
  (`run.mjs` `71ced81c…`, `judge-launcher.sh` `fad23572…`) differ from this
  repair's (`88d33057…`, `78f2644b…`), and `verifyFreeze` refuses a changed
  inventory at trial, judge and recovery dispatch.
- The stopped root was read only. Its trial claim is closed, the judge claim
  directory is empty, no `ac/attempt-001` directory was created, and the
  ledger holds one `judge-refused` event.

## Inferred

- The completed A trial is intact evidence of A's behaviour, but the frozen
  protocol does not support adding a judgement to it under this repair: the
  judge apparatus is part of the frozen premise. Carrying it forward would
  need an explicit protocol change that re-baselines the measurement while
  retaining the trial, not a recovery attempt.

## Tested

- `node --test tests/campaign-judge-path.test.ts` — three regressions through
  the real launcher: clean packet under an operator-named `/home` root reaches
  an offline judge with neutral child paths, a canary in the packet refuses
  before spawn, and the materialised `prepare/run.mjs` run-card layout
  completes two judged slots without exposing the host path.
- `npm test` 1155 pass, 0 fail; `npm run typecheck` clean. The materialised
  suites need `GIT_CONFIG_GLOBAL=/dev/null` on a host whose global git config
  signs commits, because their fixture commits do not disable signing.
