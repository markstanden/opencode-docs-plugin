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

## Pinned OTC tooling

OTC is development tooling, never a runtime or ordinary-test dependency.

| Fact               | Value                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Package            | `@markstanden/opencode-test-container` 0.1.0                                                      |
| Source commit      | `5b0ee3d6c4f762cf254d1240edff58583b72943b` (based on `b474fc6`)                                   |
| Tarball            | `vendor/markstanden-opencode-test-container-0.1.0.tgz`                                            |
| Tarball SHA-256    | `75bd531056c397b14657d33ae70beeaaeed07cbe8a62a75025707e4ad49475c5`                                |
| Lockfile integrity | `sha512-YoZMd5N+apP4BzWXaq+OFDTl0aMKYPgZvI3oTihmCcZFMjVosCNOv6QW32Fd3/lZ5eUCemVyldL8VuK3OKGaqg==` |

Until the package is published, the file dependency is the immutable tarball;
after publication it is replaced with the registry version and the tarball is
deleted. The lockfile integrity is the pin.

**Build provenance (verified 2026-11-15).** `git archive 5b0ee3d` from a clean
OTC checkout, packed with `npm pack` (whose `prepack` runs the package build)
and extracted, is byte-identical to the vendored tarball — no dirty or moving
checkout was repacked. The installed CLI reports `otc version` `0.1.0`.

## Recipe (installed artifact, no model calls until `run`)

```sh
npm --prefix evaluations ci
cd evaluations
node_modules/.bin/otc validate --campaign docs-placement/campaign.json
node_modules/.bin/otc prepare  --campaign docs-placement/campaign.json --root /tmp/otc-docs
node_modules/.bin/otc freeze   --root /tmp/otc-docs
node_modules/.bin/otc run      --root /tmp/otc-docs --dry-run
node_modules/.bin/otc status   --root /tmp/otc-docs --json
```

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

`run` dispatches real OpenCode sessions and may make paid provider calls; it
needs explicit authorisation. The campaign declares a host-proxy route, so no
credential is committed here. `run --dry-run` is the offline dispatch proof.

**Offline proof, 2026-11-15** — from `/tmp/opencode`, against the installed
pinned artifact: `validate` valid (2 cases, 1 arm, 2 slots); `prepare` wrote
manifest
`56d4e2667840b81e1a4fefca6c3d68d40efd8839402ef433bdcf2d554607e680`;
`freeze` resolved `sha256:58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`
(OpenCode 2.2.6); `run --dry-run` planned both slots; `status --json` reported
`frozen` with zero spend. The image used for that resolution was the verified
OpenCode 2.2.6 trial image, tagged to the campaign's declared name locally;
the tag was removed after the check.

## Product checks (`npm --prefix evaluations test`)

- `tests/bundle.test.ts` proves every manifest asset resolves, the suite and
  campaign agree, and the installed `otc` validates the campaign from the
  evaluations directory.
- `tests/journal-contract.test.ts` packs the plugin, loads the **packed**
  shape outside the checkout, and hands the journal it emits to the installed
  OTC evaluator. It covers the two known lossy host shapes: a native `add`
  whose trail keeps the pre-decode JSON string, and the undeclared nested
  `add.lake` the runtime discards. Attribution is not weakened: a write
  corroborated only by a nested lake is refused credit.
- `npm run test:legacy` separately verifies the frozen legacy route.

## Bundle index

| Path                                               | Contents                                              |
| -------------------------------------------------- | ----------------------------------------------------- |
| `docs-placement/manifest.json`                     | corpus, seeds, truth, checks, measurement, provenance |
| `docs-placement/suite.json`                        | OTC docs-recording cases: prompts, seeds, outcomes    |
| `docs-placement/campaign.json`                     | product plugin arm and explicit schedule              |
| `docs-placement/fixtures/`                         | per-case seed lake roots                              |
| `tests/fixtures/placement-cases.json`              | authoritative placement corpus                        |
| `tests/fixtures/trial-cases.json`                  | authoritative trial families                          |
| `tests/fixtures/held-out-{cases,truth}.json`       | hidden truth                                          |
| `tests/fixtures/placement-harness/primary-checks/` | trusted primary checkers (product-owned)              |
| `tests/fixtures/placement-harness/prod014/`        | frozen historical campaign and measurement            |
| `legacy-inventory.md`                              | every retained legacy file and its class              |

## Outstanding OTC dependency

OTC's docs campaign support (`src/evaluators/docs/harness/run.ts`, `gate`)
still invokes this repository's `tests/fixtures/placement-harness/harness.mts`
by literal path. That is the one compatibility bridge retained here; this
repository does not grow a replacement. The OTC owner has the gap recorded in
the handback.
