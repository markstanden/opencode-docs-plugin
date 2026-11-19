---
Area: release
Keywords: npm publish, trusted publishing, OIDC, provenance, attestation, tag, workflow, npm-publish
Summary: Releasing is a v<version> tag on a merged main commit; the workflow publishes over npm trusted publishing with automatic provenance, so no NPM_TOKEN exists and every tarball is attested.
---

# Releasing: a tag publishes over OIDC, not a laptop

Recorded 2026-11-15, mirroring the `opencode-test-container` setup after that
package's first attested release (`0.1.1`, sigstore logIndex 3904196001).

## Facts

- Publication runs from `.github/workflows/npm--publish.yml` on a `v*` tag
  push, or `workflow_dispatch` with a tag chosen in the ref selector. There is
  no local `npm publish` step and no `NPM_TOKEN`.
- The package ships `src` as written (`exports` is `./src/index.ts`, no build
  step), so the tagged tree is the artifact. `npm publish` runs from it
  unchanged.
- Guards, in order: the ref must be a `v*` tag; the tag must equal
  `v<package.json version>`; the tagged commit must be an ancestor of `main`;
  and the tree must pass `defined verify` in the pinned gate image.
- `comply` is deliberately not run in the workflow. It repairs files, and the
  tarball must be the tagged source.
- npm generates the provenance attestation automatically under OIDC for a
  public package in a public repository. `--provenance` states the intent
  explicitly; it needs no token.
- The job runs in the `npm-publish` environment, which is where required
  reviewers belong.
- Release tags are immutable: a repository ruleset on `refs/tags/v*` blocks
  deletion and force-pushes with no bypass actors. Creating and updating tags
  is deliberately unrestricted, so `git push origin v<version>` still works.

## One-time npm setup

Configure the package's trusted publisher on npmjs.com (package Settings →
Trusted Publisher → GitHub Actions). The provider and required fields cannot
be edited later; a mistake means deleting the connection and creating another.

| Field             | Value                  |
| ----------------- | ---------------------- |
| Organization/user | `markstanden`          |
| Repository        | `opencode-docs-plugin` |
| Workflow filename | `npm--publish.yml`     |
| Environment name  | `npm-publish`          |

- **Allowed actions must include `npm publish`.** The form offers `npm
publish`, `npm stage publish` and `npm dist-tag`, requiring at least one.
  The workflow runs plain `npm publish`; dist-tag is not needed.
- **`package.json` `repository.url` must match the GitHub repository**, or npm
  refuses the OIDC publish.
- The connection expires unvalidated: complete the first publish within two
  days of creating it.
- Package Settings → Publishing access → _Require two-factor authentication and
  disallow bypass 2FA tokens_ once a release has published over OIDC. Trusted
  publishers keep working; token-based publishing stops.

## Release steps

1. Set `version` in `package.json` and in `package-lock.json` (top-level and
   `packages[""]`), merge to `main`, and let the Defined Gate go green.
2. Tag the merge commit — not whatever the branch head happens to be:

    ```sh
    git tag -a v<version> -m "<version>" <merge-commit>
    git push origin v<version>   # this is the publish
    ```

3. Approve the `npm-publish` deployment if the environment has reviewers.
4. Verify (below).

## Tested

- `npm audit signatures` against the published `opencode-test-container`
  `0.1.1` reported a verified registry signature and a verified attestation,
  with `dist.attestations.provenance.predicateType`
  `https://slsa.dev/provenance/v1` and `gitHead` equal to the merge commit.
- The tag/version and off-`main` guards were exercised against a real checkout:
  a matching tag on `main` passed, a mismatched version failed, and a tag on a
  commit outside `main` failed.

## Verifying a release

```sh
npm audit signatures
npm view @markstanden/opencode-docs-plugin@<version> dist.attestations
npm view @markstanden/opencode-docs-plugin@<version> gitHead
```

The attestation ties the tarball to this repository, workflow, tag and commit.
Releases up to and including `0.14.0` carry registry signatures only; `0.14.1`
is the first attested version.

## Open questions

- Nothing is enforced about the tag existing on the remote before publishing; a
  tag is the only switch. Tag protection rules on `v*` would close that gap if
  the remote allows them.
