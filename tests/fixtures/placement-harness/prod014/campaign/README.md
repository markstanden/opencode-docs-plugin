# Productivity-screen campaign runner

The frozen campaign scripts live in `scripts.json` with their SHA-256 hashes.
They are data: `materialise.mjs` writes them into a campaign root outside the
repository, refusing a hash mismatch.

## Rerun recipe (fresh root, fresh stamps)

```sh
export CAMPAIGN_ROOT=/home/mark/tmp/docs-prod014-<fresh-stamp>
export CAMPAIGN_SOURCE_REPO=/path/to/opencode-docs-plugin
mkdir -p "$CAMPAIGN_ROOT"
node tests/fixtures/placement-harness/prod014/campaign/materialise.mjs "$CAMPAIGN_ROOT"

# A campaign-local credential file, never committed. The generic judge launcher
# forwards ZAI_API_KEY only when the caller exported it.
printf 'ZAI_API_KEY=%s\n' "$(cat ~/.config/secrets/<your-key>)" > "$CAMPAIGN_ROOT/.env"
chmod 600 "$CAMPAIGN_ROOT/.env"

# Arms and the independent measurement worktree:
#   A      campaign base commit (unmodified 0.14.0 description)
#   B      base + replication/patch.mjs with assets/b-prod014.txt
#   measurement  base (gate/judge/analyser)
# Install node_modules in each worktree, then:
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/schedule.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" bash "$CAMPAIGN_ROOT/prepare/generate.sh"
node "$CAMPAIGN_ROOT/prepare/surfaces.mjs" "$CAMPAIGN_ROOT/arms/a" \
  "$CAMPAIGN_ROOT/evidence/surfaces-a.json"
node "$CAMPAIGN_ROOT/prepare/surfaces.mjs" "$CAMPAIGN_ROOT/arms/b" \
  "$CAMPAIGN_ROOT/evidence/surfaces-b.json"
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mjs" \
  "$CAMPAIGN_ROOT/evidence/delivery-a/capture.json" "$CAMPAIGN_ROOT/arms/a" \
  opencode-go/deepseek-v4.1-flash "Hello." 8801
node "$CAMPAIGN_ROOT/prepare/delivery-probe.mjs" \
  "$CAMPAIGN_ROOT/evidence/delivery-b/capture.json" "$CAMPAIGN_ROOT/arms/b" \
  opencode-go/deepseek-v4.1-flash "Hello." 8802
cp "$CAMPAIGN_ROOT/arms/a/tests/fixtures/placement-harness/prod014/measurement.json" \
  "$CAMPAIGN_ROOT/evidence/measurement-spec.json"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/freeze.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/dry-check.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/cli-measures.mjs"
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/run.mjs" \
  --pair-from 1 --pair-to 4
CAMPAIGN_ROOT="$CAMPAIGN_ROOT" node "$CAMPAIGN_ROOT/prepare/run.mjs" \
  --pair-from 5 --pair-to 8 --attempt-id attempt-002
```

Changed wording requires a fresh root and fresh stamps; never reuse a stamp or
overwrite a recorded attempt. The analyser manifest is
`prepare/manifest.json`; run the analyser from the measurement worktree with a
fresh output directory outside the campaign root.

## Provenance

`surfaces.mjs`, `delivery-probe.mjs`, `freeze.mjs`, `run.mjs`, `schedule.mjs`
and `shim/podman` are adapted from the 2026-11-10 confirmation campaign's
`/home/mark/tmp/recording-confirm-20261110/prepare/` scripts; `env.mjs`,
`rejudge.mjs`, `dry-check.mjs` and `cli-measures.mjs` are new for this screen.
The snapshot and hashes above are the frozen source; there is no personal path
or credential in it.
