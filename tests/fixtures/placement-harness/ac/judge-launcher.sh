#!/usr/bin/env bash
# Isolated launcher for one structured documentation judgement.
#
# The packet is self-contained and arrives as the final argument, so the judge
# needs no filesystem at all. Only an empty per-call working directory and an
# isolated config home are mounted: the repository, the arm worktrees, every
# recorded run and the private mapping are unreachable from the session.
#
# Environment:
#   AC_RUN_DIR  required; per-call HOST directory holding work/ and config-home/
#   AC_MODEL    required; the judge model route
#   AC_CONTAINER_RUN_DIR  optional; neutral container destination for AC_RUN_DIR
#               (default /judge). Work and config paths derive from it, so the
#               host evidence path is never a child-visible value.
#   AC_CONTAINER_HOME / AC_CONTAINER_DATA_HOME / AC_CONTAINER_CACHE_HOME
#               optional; neutral agent home values the child receives.
#   PLACEMENT_IMAGE  optional; the trial container image
#
# The host directory is mounted at AC_CONTAINER_RUN_DIR. The child's working
# directory, PWD and config home are container paths, never the host path: an
# operator campaign root under /home is not judge-visible.
set -euo pipefail
prompt="${!#}"
run_dir="${AC_RUN_DIR:?missing AC_RUN_DIR}"
container_run_dir="${AC_CONTAINER_RUN_DIR:-/judge}"
container_work_dir="$container_run_dir/work"
container_config_home="$container_run_dir/config-home"
agent_home="${AC_CONTAINER_HOME:-/tmp/agent-home}"
agent_data_home="${AC_CONTAINER_DATA_HOME:-$agent_home/.local/share}"
agent_cache_home="${AC_CONTAINER_CACHE_HOME:-$agent_home/.cache}"
image="${PLACEMENT_IMAGE:-localhost/opencode-placement-trials}"
for value in "$container_run_dir" "$container_work_dir" \
    "$container_config_home" "$agent_home" "$agent_data_home" \
    "$agent_cache_home"; do
    case "$value" in
    /*) ;;
    *)
        echo "judge context is not an absolute container path: $value" >&2
        exit 2
        ;;
    esac
    case "$value" in
    *:* | *$'\n'*)
        echo "judge context is not a safe container path: $value" >&2
        exit 2
        ;;
    esac
done
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
# A provider that needs a local key receives it by name only, so the value is
# never an argument or a log line. Pass-through needs the caller's export.
key_env=()
if [ -n "${ZAI_API_KEY:-}" ]; then
    key_env=(-e ZAI_API_KEY)
fi
# The cleaned overlay travels by name for the same reason; export it so the
# value the container receives is still the cleaned one.
export OPENCODE_CONFIG_CONTENT="$clean"
exec podman run --rm --network host --userns=keep-id --read-only \
    --tmpfs /tmp:rw,nosuid,size=256m \
    -v "$run_dir:$container_run_dir:rw" \
    -w "$container_work_dir" \
    -e PWD="$container_work_dir" \
    -e XDG_CONFIG_HOME="$container_config_home" \
    -e XDG_DATA_HOME="$agent_data_home" \
    -e XDG_CACHE_HOME="$agent_cache_home" \
    -e HOME="$agent_home" \
    -e OPENCODE_CONFIG_CONTENT \
    "${key_env[@]}" \
    "$image" opencode "$@"
