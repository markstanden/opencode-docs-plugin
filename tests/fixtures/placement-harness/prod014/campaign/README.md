# Productivity-screen campaign runner

Two source modes:

- **fresh (default)**: checked sources under `active/`, verified against
  `active/snapshot.json`. This is the only mode a new campaign may use.
- **historical replay**: `--historical` reads the frozen `scripts.json`
  snapshot for the 2026-11-11 campaign (normal selection `attempt-002`). It is
  read-only evidence and never a template for a new run.

`materialise.mjs` writes the chosen set into a campaign root outside the
repository. It refuses a changed active source, an existing `prepare/` or
`runner/` directory, or a frozen campaign, and publishes only a fully staged
tree. `--snapshot` regenerates `active/snapshot.json` and the pinned module
hashes in `runner.json` from the checked sources.

## Run card

This is the one executable recipe. It is offline through arm/measurement
preparation, then makes paid calls only at the delivery probe, P04 and the
continuation.

```sh
# 0. Pin the revision that will execute. Materialise from the checked-out
#    commit; freeze records it, and every dispatch rechecks it.
cd /path/to/opencode-docs-plugin
REV=$(git rev-parse HEAD)
export CAMPAIGN_ROOT=/home/mark/tmp/docs-prod014-$(date +%Y%m%dT%H%M%SZ)
export CAMPAIGN_ID="pd-fresh-$REV"
export CAMPAIGN_SOURCE_REPO=/path/to/measurement
export REPORT_ROOT=/home/mark/tmp/docs-prod014-reports-$(date +%Y%m%dT%H%M%SZ)
mkdir -p "$CAMPAIGN_ROOT/evidence" "$REPORT_ROOT"
node tests/fixtures/placement-harness/prod014/campaign/materialise.mjs "$CAMPAIGN_ROOT"
# The fresh manifest selects attempt-001; recovery writes attempt-002.

# 1. Campaign-local credential, created with owner-only permissions and never
#    committed. The runner refuses a file readable beyond its owner.
(umask 077; printf 'ZAI_API_KEY=%s\n' "$(cat ~/.config/secrets/<your-key>)" \
  > "$CAMPAIGN_ROOT/.env")
chmod 600 "$CAMPAIGN_ROOT/.env"

# 2. Arms: A is the campaign base commit (unmodified 0.14.0 description); B is
#    base + replication/patch.mjs with assets/b-prod014.txt; measurement is an
#    independent worktree at the same base (gate, judge, analyser). Install
#    node_modules in each.

# 3. Generate both arms and freeze the experiment. schedule.mjs names the
#    campaign from CAMPAIGN_ID; no historical stamp is reused.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_ID="$CAMPAIGN_ID" \
  node "$CAMPAIGN_ROOT/prepare/schedule.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" bash "$CAMPAIGN_ROOT/prepare/generate.sh"
node "$CAMPAIGN_ROOT/prepare/surfaces.mjs" "$CAMPAIGN_ROOT/arms/a" \
  "$CAMPAIGN_ROOT/evidence/surfaces-a.json"
node "$CAMPAIGN_ROOT/prepare/surfaces.mjs" "$CAMPAIGN_ROOT/arms/b" \
  "$CAMPAIGN_ROOT/evidence/surfaces-b.json"
# Delivery probes save the raw provider request beside the capture.
# The probe's mount path must be absolute; $CAMPAIGN_ROOT already is.
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mjs" \
  "$CAMPAIGN_ROOT/evidence/delivery-a/capture.json" "$CAMPAIGN_ROOT/arms/a" \
  opencode-go/deepseek-v4.1-flash "Hello." 8801
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mjs" \
  "$CAMPAIGN_ROOT/evidence/delivery-b/capture.json" "$CAMPAIGN_ROOT/arms/b" \
  opencode-go/deepseek-v4.1-flash "Hello." 8802
cp "$CAMPAIGN_ROOT/arms/a/tests/fixtures/placement-harness/prod014/measurement.json" \
  "$CAMPAIGN_ROOT/evidence/measurement-spec.json"
# freeze.mjs builds/resolves the image first and records its immutable id.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/freeze.mjs"

# 4. P04 checkpoint: four pairs, then report before continuing. The analyser
#    refuses an output directory inside the evidence root.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/run.mjs" --pair-from 1 --pair-to 4
node "$CAMPAIGN_SOURCE_REPO/tests/fixtures/placement-harness/analysis/analyse.mts" \
  --campaign "$CAMPAIGN_ROOT/prepare/manifest.json" \
  --evidence-root "$CAMPAIGN_ROOT" \
  --out "$REPORT_ROOT/p04"
# Continue only if P04 has no blocker, no unusable judge and no premise change;
# otherwise stop, preserve the root and report.

# 5. P08 remainder, then the final analysis and closure.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/run.mjs" --pair-from 5 --pair-to 8
node "$CAMPAIGN_SOURCE_REPO/tests/fixtures/placement-harness/analysis/analyse.mts" \
  --campaign "$CAMPAIGN_ROOT/prepare/manifest.json" \
  --evidence-root "$CAMPAIGN_ROOT" \
  --out "$REPORT_ROOT/p08"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/close-campaign.mjs"
```

Recovery is a separately authorised, separately identified attempt. It writes
`attempt-002` and must be later than the manifest's normal selection; it never
reuses `attempt-001` and never rewrites the freeze.

```sh
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/rejudge.mjs" --attempt-id attempt-002
```

If a run is interrupted, preserve the root. An unresolved reservation blocks a
repeat and a later range until the evidence is inspected; the runner never
retries a spend whose outcome is unknown.

## Historical replay

```sh
node tests/fixtures/placement-harness/prod014/campaign/materialise.mjs \
  "$OLD_ROOT" --historical
```

Historical roots keep `attempt-002` and their frozen stamps. Replaying analysis
over legacy evidence without an answer hash needs the explicit read-only flag:

```sh
node .../analysis/analyse.mts --campaign <manifest> --evidence-root <root> \
  --out <fresh-dir> --allow-legacy-unbound
```

The analyser manifest is `prepare/manifest.json`. Run the analyser from the
measurement worktree into a fresh output directory outside the campaign root;
it refuses to overwrite an existing analysis. The manifest's
`assessment.attemptId` is the single selector: pass `--attempt-id` only when it
agrees, or the runner refuses before any spend.

Changed wording requires a fresh root, fresh materialisation and fresh stamps;
never reuse a stamp, overwrite a recorded attempt or edit a frozen input.

## Provenance

`active/` is the source of truth for fresh runs; `scripts.json` is the
2026-11-11 frozen snapshot retained for replay. `surfaces.mjs`,
`delivery-probe.mjs`, `freeze.mjs`, `run.mjs`, `schedule.mjs` and `shim/podman`
are adapted from the 2026-11-10 confirmation campaign's
`/home/mark/tmp/recording-confirm-20261110/prepare/` scripts; `env.mjs`,
`rejudge.mjs`, `dry-check.mjs` and `cli-measures.mjs` are new for this screen.
`dry-check.mjs` and `cli-measures.mjs` exist only in the historical snapshot and
are not part of a fresh run. No personal path or credential is in either set.
