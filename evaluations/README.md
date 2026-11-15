# Product evaluations

This directory is the product-side evaluation bundle: candidate plugin, case
seeds, hidden truth, measurement declarations, expected outcomes and primary
checkers. It is **not** part of the shipped npm product and **not** run by
`npm test`.

OTC executes the bundle; this repository does not implement scheduling,
budgets, judges, recovery or reporting. The product supplies the data and the
checkers.

## Ownership

- The authoritative docs-placement corpus and recorded evidence remain under
  `tests/fixtures/` where the product checks and the frozen prod014 route read
  them. `docs-placement/manifest.json` indexes the bundle.
- The reusable lifecycle, sandbox adapters, evidence boundary and evaluators
  belong to `@markstanden/opencode-test-container` (`otc`). New campaigns and
  recorded-evidence analysis use OTC (`otc replay`).
- `tests/fixtures/placement-harness/` and `tests/fixtures/analysis/` are the
  frozen legacy route, never the active path for a fresh campaign. Every
  retained file, its classification and its removal condition:
  [legacy-inventory.md](legacy-inventory.md). The engine tests live behind
  `npm run test:legacy`; `npm test` is product-only.

## Pinned OTC dependency

OTC is development tooling, never a runtime or ordinary-test dependency. The
dependency is the exact published version — no range:

| Fact                | Value                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Package / version   | `@markstanden/opencode-test-container` **0.1.0** (exact)                                              |
| Registry tarball    | `https://registry.npmjs.org/@markstanden/opencode-test-container/-/opencode-test-container-0.1.0.tgz` |
| Integrity           | `sha512-5dhOJwj4UgxLnOdLoW/gMeLnJ2lU0A8aDj2h5cIwo/iV5hULvrLogE6Ihjom07TzenE/ZOJZ6WPfzqx3iulXZg==`     |
| SHA-1 shasum        | `c336020f78aa49953964692020a9be2497c19885`                                                            |
| Registry SHA-256    | `a3731bb52bc154173bb6103a2e175b5a9fc19b3b8ca9bf90e2e07fb12495015b`                                    |
| Published           | 2026-11-15T14:13:49.115Z                                                                              |
| Publisher           | `markstanden` (npm), npm 12.2.2, Node 26.13.0                                                         |
| Published `gitHead` | `f56092f514c2f3c5055042582adf336090630757` (squash merge of OTC PR #1)                                |
| Reviewed source     | `287e30a236e34b0dda8a24d966d7c3d6140d0c1b` (tree `a759d269…`, identical to the published tree)        |

Publication provenance, verified 2026-11-15:

- `npm view` reports the integrity above, and `npm audit signatures` verifies
  the registry signature (one package, verified).
- The registry tarball is byte-identical (SHA-256 `a3731bb5…`) to the artifact
  built from `git archive 287e30a` and reviewed by this repository.
- The published `gitHead` is the squash merge `f56092f`; its tree equals the
  reviewed branch head's tree, so no content changed between review and
  publication.

The lockfile integrity is the pin. A bundle test asserts the exact spec, the
registry URL and this integrity, so a caret, a file dependency or a different
build cannot return unnoticed. At this version OTC removed its migrated docs
harness: no installed source reaches
`tests/fixtures/placement-harness/harness.mts`, and a consumer test asserts the
published package carries no such reference. The old harness is now legacy
machinery for the historical route only.

## Recipe (installed artifact, no model calls until `run`)

```sh
npm --prefix evaluations ci
cd evaluations
node_modules/.bin/otc validate --campaign docs-placement/campaign.json
node_modules/.bin/otc prepare  --campaign docs-placement/campaign.json --root /tmp/otc-docs
node_modules/.bin/otc freeze   --root /tmp/otc-docs
node_modules/.bin/otc delivery-check --root /tmp/otc-docs
node_modules/.bin/otc run      --root /tmp/otc-docs --dry-run
node_modules/.bin/otc status   --root /tmp/otc-docs --json
```

Each docs case declares product-owned hidden `truth` and a `primaryCheck`
(`{ id, directory, script }`). OTC stages the checker and runs it after the
trial in its own no-network container as
`node /checker/<script> /live /pristine`; the checker source is never mounted
into the trial. A judge is optional and is not declared here, so the offline
path makes no model call at all.

`freeze` resolves the sandbox image ID, so the image must exist first. Build it
from the installed package's shipped recipe with both inputs pinned:

```sh
podman build --network host \
  --build-arg NODE_BASE=docker.io/library/node:lts-slim \
  --build-arg OPENCODE_VERSION=2.2.6 \
  --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) \
  -t localhost/otc-sandbox:2.2.6 \
  node_modules/@markstanden/opencode-test-container/container
```

`run` dispatches real OpenCode sessions; `otc judge` adds a blind judge and may
make paid provider calls. Both need explicit authorisation. The campaign
declares a host-proxy route, so no credential is committed here.
`run --dry-run` is the offline dispatch proof.

**Offline proof, 2026-11-15** — from `/tmp/opencode`, against the installed
artifact at `287e30a`: `validate` valid (2 cases, 1 arm, 2 slots); `prepare`
wrote manifest
`9dc1eeb6338f787226daf05430312d46f95f44db1a13844e825b67c0c418b3ff`;
`freeze` resolved
`sha256:58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`
(OpenCode 2.2.6) and recorded tool artifact
`68f08d7caeda9b3ad9192cbdd944d387a65697174a0c4e062d5428d407131077`;
`delivery-check` intact; `run --dry-run` planned both slots; `status --json`
reported `frozen` with zero spend. The image used for that resolution was the
verified OpenCode 2.2.6 trial image, tagged to the campaign's declared name
locally; the tag was removed after the check.

## Product checks (`npm --prefix evaluations test`)

- `tests/bundle.test.ts` proves every manifest path resolves (by traversal,
  not a hand-kept key list), the suite and campaign agree, every docs case
  declares hidden truth and an existing checker, the campaign stages the
  shipped product, and the installed `otc` validates the campaign from the
  evaluations directory.
- `tests/checkers.test.ts` runs the product checkers exactly as OTC does
  (`node <script> <live> <pristine>`) against temp trees: the note must exist
  and retain the convention; the refused write must leave the lake
  byte-for-byte unchanged.
- `tests/journal-contract.test.ts` packs the plugin, loads the **packed**
  shape outside the checkout, and hands the journal it emits to the installed
  OTC evaluator. It covers the two known lossy host shapes: a native `add`
  whose trail keeps the pre-decode JSON string, and the undeclared nested
  `add.lake` the runtime discards. Attribution is not weakened: a write
  corroborated only by a nested lake is refused credit.
- `tests/otc-contract.test.ts` proves the suite declaration drives OTC's
  closed primary-check plan (fixed `node` interpreter, `/live` and `/pristine`
  read-only, `network: "none"`), that the installed artifact carries no
  docs-harness bridge, and that the committed mini corpus replays through
  `otc replay` offline.
- `npm run test:legacy` separately verifies the frozen legacy route.

## Bundle index

| Path                                               | Contents                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `docs-placement/manifest.json`                     | corpus, seeds, truth, checks, measurement, provenance       |
| `docs-placement/suite.json`                        | OTC docs cases: prompts, seeds, truth, outcomes, checkers   |
| `docs-placement/campaign.json`                     | product plugin arm and explicit schedule                    |
| `docs-placement/fixtures/`                         | per-case seed lake roots                                    |
| `docs-placement/checkers/`                         | product primary checkers, executed by OTC                   |
| `tests/fixtures/placement-cases.json`              | authoritative placement corpus                              |
| `tests/fixtures/trial-cases.json`                  | authoritative trial families                                |
| `tests/fixtures/held-out-{cases,truth}.json`       | hidden truth                                                |
| `tests/fixtures/placement-harness/primary-checks/` | legacy primary checkers, retained with the historical route |
| `tests/fixtures/placement-harness/prod014/`        | frozen historical campaign and measurement                  |
| `legacy-inventory.md`                              | every retained legacy file and its class                    |

## Sequencing

OTC PR #1 was squash-merged to `f56092f`, and `0.1.0` is published with the
integrity above. This repository is now on the exact registry pin and the
tarball is deleted. The remaining step in the agreed order is this PR's
exact-head final verification and merge; no further OTC dependency is
outstanding. A full dispatched docs campaign and live judging are still not
claimed — the offline proof stops at `run --dry-run`, the primary-check plan,
the product checkers and recorded replay.
