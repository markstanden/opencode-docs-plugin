---
Area: release
Keywords: release record, 0.14.1, provenance, SLSA attestation, trusted publishing, tarball identity, gitHead
Summary: 0.14.1 is the first release published by CI over npm trusted publishing with a SLSA v1 attestation; a local `npm pack` of the merge commit reproduces the registry tarball byte for byte.
---

# Release 0.14.1: the first attested release

Recorded 2026-11-15. First release published from CI over npm trusted
publishing (GitHub OIDC) instead of a local `npm publish`.

## Facts

| Fact                  | Value                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Pull request          | [#68](https://github.com/markstanden/opencode-docs-plugin/pull/68)                                |
| Merged head           | `e7a23cf99f7cca2ec4af5a10fb2ae48144257cc3`                                                        |
| Merge commit          | `c34658b019ce9c7fe8b27a4821d6a99d37aac060`                                                        |
| Registry `gitHead`    | `c34658b019ce9c7fe8b27a4821d6a99d37aac060`                                                        |
| Merge method          | squash                                                                                            |
| Publish workflow      | `.github/workflows/npm--publish.yml`, run 43727647730                                             |
| Trigger               | annotated tag `v0.14.1` on the merge commit                                                       |
| Merge gate            | Defined Gate green (twice) and SonarQube green, on #68 and on `main` after merge                  |
| Pre-publish verify    | `defined verify` in the pinned gate image, inside the publish job                                 |
| Tarball               | `markstanden-opencode-docs-plugin-0.14.1.tgz`                                                     |
| Local tarball SHA-256 | `560608797d9800273e975d40befe83dbc8423429a47ddece83b18157f4b38bd6`                                |
| Registry shasum       | `df129704e4445ab6383d46d1104eb6cf004f3e60`                                                        |
| Registry integrity    | `sha512-NXJRYoif9bsFEPUot66u9cirX07C1jtAIliN5GZuG2BBtFixqEToRDO5xth/T00Dy3O81O2IYnGCHxMkI1ZbCw==` |
| Files / unpacked size | 12 / 239,240 bytes                                                                                |
| Published             | `2026-11-15T15:05:18.723Z`                                                                        |
| Attestation           | <https://registry.npmjs.org/-/npm/v1/attestations/@markstanden%2fopencode-docs-plugin@0.14.1>     |
| Predicate type        | `https://slsa.dev/provenance/v1`                                                                  |
| Transparency log      | <https://search.sigstore.dev/?logIndex=3904424448>                                                |

- `src/` moved a long way since `v0.14.0`: ten merged PRs (#55–#67), including
  the internals split and the OTC-owned evaluation bundle. The release is a
  substantive one, not a packaging-only bump.
- `npm pack` at the merge commit reproduces the published tarball exactly —
  same sha256, shasum (`df129704…`) and integrity — so the registry artefact is
  a build of `c34658b` by any measure, not merely by `gitHead`.
- The package ships `src` as written; there is no build step, so the tag is the
  artefact and the reproducibility check is a repack, not a rebuild.

## Tested

- `npm audit signatures` in a clean consumer install of 0.14.1 reported
  **0 invalid, 0 missing** across the 102 packages carrying attestations, this
  one included.
- The publish job's own steps all passed: tag guard, version match, on-`main`
  ancestry, `npm ci`, `defined verify`, `npm publish`.
- Registry propagation lagged the run: the version returned 404 for about a
  minute after the workflow reported success, then resolved. A successful
  publish run is evidence; an immediate registry read is not disproof.

## Open questions

- Tag protection on `v*` is unset, so nothing but the environment stops a
  mistaken tag from publishing. See [releasing.md](releasing.md).
- `npm-publish` carried no required reviewer for this first publish, so it did
  not pause for approval.
