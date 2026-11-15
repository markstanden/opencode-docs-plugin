# Product evaluations

This directory is the product-side evaluation bundle: candidate wording, case
seeds, truth, measurement declarations and primary checkers. It is **not** part
of the shipped npm product and it is **not** run by `npm test`.

## Ownership

- The authoritative docs-placement corpus and fixtures remain under
  `tests/fixtures/` where the existing contract tests and the frozen prod014
  route consume them. `docs-placement/manifest.json` indexes that bundle.
- The reusable lifecycle, sandbox adapters, evidence boundary and evaluators
  belong to `@markstanden/opencode-test-container` (`otc`).
- The old prod014 driver in `tests/fixtures/placement-harness/` is a frozen,
  pinned compatibility route. It is not a second active engine: new campaigns
  use OTC only. Owner: this repository. Removal condition: after one OTC
  campaign reaches parity on the same frozen evidence, with its report and
  semantic comparison recorded. Until then, old roots are never resumed by
  OTC and historical bytes are never rewritten.

## Pinned OTC tooling

OTC is development tooling, never a runtime or ordinary-test dependency.
Until the package is published, `evaluations/package.json` pins the immutable
tarball in `evaluations/vendor/`; after publication, the file dependency is
replaced with the registry version and the tarball is deleted. The integrity in
`evaluations/package-lock.json` is the pin.

```sh
npm --prefix evaluations ci
npm --prefix evaluations run validate
```

The campaign is an executable recipe, but `run`/`freeze` dispatch real
OpenCode and may make paid provider calls. Ask before doing that; the offline
proof is the OTC rehearsal (`npm run rehearse:offline` in the OTC checkout),
which uses a scripted loopback provider and zero paid calls.

## Bundle index

| Path                                               | Contents                                          |
| -------------------------------------------------- | ------------------------------------------------- |
| `docs-placement/manifest.json`                     | corpus, truth, checkers, measurement declarations |
| `docs-placement/suite.json`                        | OTC docs-recording cases for the recording slice  |
| `docs-placement/campaign.json`                     | product plugin arm and explicit schedule          |
| `tests/fixtures/placement-cases.json`              | authoritative placement corpus                    |
| `tests/fixtures/trial-cases.json`                  | authoritative trial families                      |
| `tests/fixtures/placement-harness/primary-checks/` | trusted primary checkers                          |
| `tests/fixtures/placement-harness/prod014/`        | frozen historical campaign machinery              |
