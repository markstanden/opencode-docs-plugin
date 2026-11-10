#!/usr/bin/env bash
# Isolated launcher for one structured documentation judgement.
#
# The packet is self-contained and arrives as the final argument, so the judge
# needs no filesystem at all. Only an empty per-call working directory and an
# isolated config home are mounted: the repository, the arm worktrees, every
# recorded run and the private mapping are unreachable from the session.
#
# Environment:
#   AC_RUN_DIR  required; per-call directory holding work/ and config-home/
#   AC_MODEL    required; the judge model route
#   PLACEMENT_IMAGE  optional; the trial container image
set -euo pipefail
prompt="${!#}"
run_dir="${AC_RUN_DIR:?missing AC_RUN_DIR}"
image="${PLACEMENT_IMAGE:-localhost/opencode-placement-trials}"
mkdir -p "$run_dir/work" "$run_dir/config-home/opencode"
printf '%s' "$prompt" >"$run_dir/prompt.md"
node - "$run_dir/config-home/opencode/opencode.json" "${AC_MODEL:?missing AC_MODEL}" <<'JS'
const fs = require("fs");
const [path, model] = process.argv.slice(2);
fs.writeFileSync(
    path,
    JSON.stringify(
        {
            $schema: "https://opencode.ai/config.json",
            model,
            // The judge answers from the prompt alone: no read, shell, edit,
            // web or task tool may be reachable.
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
        null,
        2,
    ) + "\n",
);
JS
# The caveman MCP is a host convenience the judge does not need.
clean=$(node -e 'const fs=require("fs");let d={};try{d=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||"{}")}catch{};delete d.mcp;process.stdout.write(JSON.stringify(d))')
exec podman run --rm --network host --userns=keep-id --read-only \
    --tmpfs /tmp:rw,nosuid,size=256m \
    -v "$run_dir:$run_dir:rw" \
    -w "$run_dir/work" \
    -e PWD="$run_dir/work" \
    -e XDG_CONFIG_HOME="$run_dir/config-home" \
    -e XDG_DATA_HOME=/tmp/agent-home/.local/share \
    -e XDG_CACHE_HOME=/tmp/agent-home/.cache \
    -e HOME=/tmp/agent-home \
    -e OPENCODE_CONFIG_CONTENT="$clean" \
    "$image" opencode "$@"
