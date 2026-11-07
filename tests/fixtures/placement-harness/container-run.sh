#!/usr/bin/env bash
# Run the placement harness inside its trial container (see Containerfile).
#
# The container is the controlled environment: a read-only root filesystem,
# the repo mounted read-only, and only prompts/fixtures/results writable.
# It shares the host network namespace, so the host's loopback provider proxy
# is reachable directly and the host's OPENCODE_CONFIG_CONTENT overlay passes
# through unchanged — no routes or credentials are baked into this repository.
#
# Usage:
#   ./container-run.sh all                 # full sweep: run + judge + summary
#   ./container-run.sh run E01             # one case
#   ./container-run.sh export              # dossier from the latest stamp
# Extra flags pass through to harness.mjs (--model, --judge-model, --stamp...).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${PLACEMENT_IMAGE:-localhost/opencode-placement-trials}"
PROMPTS="${PLACEMENT_PROMPTS:-${HOME}/tmp/docs-placement/prompts}"
FIXTURES="${PLACEMENT_FIXTURES:-${HOME}/test-dir/docs-placement}"
RESULTS="${PLACEMENT_RESULTS:-${HOME}/tmp/docs-placement/results}"

command -v podman >/dev/null 2>&1 || {
    echo "podman is required" >&2
    exit 1
}

# Same provider routes as the host session; the container shares the host
# network, so the loopback proxy overlay works as-is.
overlay="${OPENCODE_CONFIG_CONTENT:-}"

podman build -q \
    --build-arg "HOST_UID=$(id -u)" \
    --build-arg "HOST_GID=$(id -g)" \
    --network host \
    -t "$IMAGE" \
    "$HERE" >&2

mkdir -p "$PROMPTS" "$FIXTURES" "$RESULTS"

SUBCOMMAND="${1:-}"
shift || true
case "$SUBCOMMAND" in
generate | run | judge | summary | export | all) ;;
*)
    echo "first argument must be a harness subcommand: generate|run|judge|summary|export|all" >&2
    exit 2
    ;;
esac

exec podman run \
    --rm \
    --network host \
    --userns=keep-id \
    --read-only \
    --tmpfs /tmp:rw,nosuid,size=768m \
    -e "OPENCODE_CONFIG_CONTENT=$overlay" \
    -e "XDG_CONFIG_HOME=/tmp/agent-home/.config" \
    -e "XDG_DATA_HOME=/tmp/agent-home/.local/share" \
    -e "XDG_CACHE_HOME=/tmp/agent-home/.cache" \
    -v "${HERE}/../../..:/repo:ro" \
    -v "$PROMPTS:/prompts" \
    -v "$FIXTURES:/fixtures" \
    -v "$RESULTS:/results" \
    "$IMAGE" \
    node /repo/tests/fixtures/placement-harness/harness.mjs \
    "$SUBCOMMAND" \
    --plugin /repo \
    --fixture /repo/tests/fixtures/placement-cases.json \
    --prompts /prompts \
    --fixtures /fixtures \
    --results /results \
    "$@"
