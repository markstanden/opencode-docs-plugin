# Productivity-screen campaign runner

Two source modes:

- **fresh (default)**: checked sources under `active/`, verified against
  `active/snapshot.json`. This is the only mode a new campaign may use.
- **historical replay**: `--historical` reads the frozen `scripts.json`
  snapshot for the 2026-11-11 campaign (normal selection `attempt-002`). It is
  read-only evidence and never a template for a new run.

`materialise.mts` writes the chosen set into a campaign root outside the
repository. It refuses a changed active source, an existing `prepare/` or
`runner/` directory, or a frozen campaign, and publishes only a fully staged
tree. `--snapshot` regenerates `active/snapshot.json` and the pinned module
hashes in `runner.json` from the checked sources.

## Run card

This is the one executable recipe. It is offline through arm/measurement
preparation and the delivery probes (a loopback fake provider — no model
spend); paid calls happen only at P04 dispatch, the P05–P08 continuation,
and any separately authorised rejudge.

```sh
# Before setup, during a block, or after an interruption, observe one campaign
# (read-only; also supports --base <rev> for checkout mode and --json):
node tests/fixtures/placement-harness/prod014/campaign/status.mts \
  --root "$CAMPAIGN_ROOT" --report-root "$REPORT_ROOT"
```

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
node tests/fixtures/placement-harness/prod014/campaign/materialise.mts "$CAMPAIGN_ROOT"
# The fresh manifest selects attempt-001; recovery writes attempt-002.

# 1. Campaign-local credential, created with owner-only permissions and never
#    committed. The runner refuses a file readable beyond its owner.
(umask 077; printf 'ZAI_API_KEY=%s\n' "$(cat ~/.config/secrets/<your-key>)" \
  > "$CAMPAIGN_ROOT/.env")
chmod 600 "$CAMPAIGN_ROOT/.env"

# 2. Arms and measurement — three worktrees at the pinned base. For THIS
#    campaign the intervention is the native-description candidate: B is
#    base + the candidate asset applied by replication/patch.mjs. A different
#    intervention replaces the patch step; this block is not a general
#    recipe. Arms must be committed and clean at freeze; each needs its own
#    node_modules (surfaces.mts resolves the arm's own deps); per-arm
#    package.json and package-lock.json are frozen inputs — install with
#    npm ci and never edit them.
git worktree add "$CAMPAIGN_ROOT/arms/a" "$REV"
git worktree add "$CAMPAIGN_ROOT/arms/b" "$REV"
git worktree add "$CAMPAIGN_ROOT/measurement" "$REV"
node tests/fixtures/placement-harness/replication/patch.mjs \
  "$CAMPAIGN_ROOT/arms/b/src/index.ts" \
  tests/fixtures/placement-harness/prod014/assets/b-prod014.txt "b"
git -C "$CAMPAIGN_ROOT/arms/b" add src/index.ts
git -C "$CAMPAIGN_ROOT/arms/b" -c user.email=campaign@local \
  -c user.name=campaign -c commit.gpgsign=false \
  commit -qm "apply the candidate B description"
export CAMPAIGN_SOURCE_REPO="$CAMPAIGN_ROOT/measurement"
for d in "$CAMPAIGN_ROOT/arms/a" "$CAMPAIGN_ROOT/arms/b" \
  "$CAMPAIGN_SOURCE_REPO"; do (cd "$d" && npm ci); done
# A NEW candidate wording means a new asset + updated active/manifest.json
# labels: regenerate and commit the snapshot (materialise.mts --snapshot)
# and start a fresh root. Arm setup alone never touches the snapshot.

# 3. Generate both arms and freeze the experiment. schedule.mts names the
#    campaign from CAMPAIGN_ID; no historical stamp is reused.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_ID="$CAMPAIGN_ID" \
  node "$CAMPAIGN_ROOT/prepare/schedule.mts"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" bash "$CAMPAIGN_ROOT/prepare/generate.sh"
node "$CAMPAIGN_ROOT/prepare/surfaces.mts" "$CAMPAIGN_ROOT/arms/a" \
  "$CAMPAIGN_ROOT/evidence/surfaces-a.json"
node "$CAMPAIGN_ROOT/prepare/surfaces.mts" "$CAMPAIGN_ROOT/arms/b" \
  "$CAMPAIGN_ROOT/evidence/surfaces-b.json"
# Delivery probes save the raw provider request beside the capture.
# The probe's mount path must be absolute; $CAMPAIGN_ROOT already is.
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mts" \
  "$CAMPAIGN_ROOT/evidence/delivery-a/capture.json" "$CAMPAIGN_ROOT/arms/a" \
  opencode-go/deepseek-v4.1-flash "Hello." 8801
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mts" \
  "$CAMPAIGN_ROOT/evidence/delivery-b/capture.json" "$CAMPAIGN_ROOT/arms/b" \
  opencode-go/deepseek-v4.1-flash "Hello." 8802
cp "$CAMPAIGN_ROOT/arms/a/tests/fixtures/placement-harness/prod014/measurement.json" \
  "$CAMPAIGN_ROOT/evidence/measurement-spec.json"
# freeze.mts builds/resolves the image first and records its immutable id.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/freeze.mts"

# 4. P04 checkpoint: four pairs, then report before continuing. The analyser
#    refuses an output directory inside the evidence root.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/run.mts" --pair-from 1 --pair-to 4
node "$CAMPAIGN_SOURCE_REPO/tests/fixtures/placement-harness/analysis/analyse.mts" \
  --campaign "$CAMPAIGN_ROOT/prepare/manifest.json" \
  --evidence-root "$CAMPAIGN_ROOT" \
  --out "$REPORT_ROOT/p04"
# Continue only if P04 has no blocker, no unusable judge and no premise change;
# otherwise stop, preserve the root and report.

# 5. P08 remainder, then closure, then the FINAL fresh report. A report
#    rendered before closure is permanently stale by design: closure appends
#    ledger events after its render time. An interim pre-close report is
#    optional and will read stale.
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/run.mts" --pair-from 5 --pair-to 8
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/close-campaign.mts"
node "$CAMPAIGN_SOURCE_REPO/tests/fixtures/placement-harness/analysis/analyse.mts" \
  --campaign "$CAMPAIGN_ROOT/prepare/manifest.json" \
  --evidence-root "$CAMPAIGN_ROOT" \
  --out "$REPORT_ROOT/final"
```

Recovery is a separately authorised, separately identified attempt. It writes
`attempt-002` and must be later than the manifest's normal selection; it never
reuses `attempt-001` and never rewrites the freeze.

```sh
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" CAMPAIGN_SOURCE_REPO="$CAMPAIGN_SOURCE_REPO" \
  node "$CAMPAIGN_ROOT/prepare/rejudge.mts" --attempt-id attempt-002
```

If a run is interrupted, preserve the root. An unresolved reservation blocks a
repeat and a later range until the evidence is inspected; the runner never
retries a spend whose outcome is unknown.

## Historical replay

```sh
node tests/fixtures/placement-harness/prod014/campaign/materialise.mts \
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
2026-11-11 frozen snapshot retained for replay. `surfaces.mts`,
`delivery-probe.mts`, `freeze.mts`, `run.mts`, `schedule.mts` and `shim/podman`
are adapted from the 2026-11-10 confirmation campaign's
`/home/mark/tmp/recording-confirm-20261110/prepare/` scripts; `env.mts`,
`rejudge.mts`, `dry-check.mjs` and `cli-measures.mjs` are new for this screen.
`dry-check.mjs` and `cli-measures.mjs` exist only in the historical snapshot and
are not part of a fresh run. No personal path or credential is in either set.
