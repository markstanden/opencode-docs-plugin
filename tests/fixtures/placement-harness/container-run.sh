#!/usr/bin/env bash
# Run the placement harness inside its trial container (see Containerfile).
#
# The container is the controlled environment: a read-only root filesystem,
# the plugin mounted read-only, and only the current case's fixture, prompt
# and result directory visible. `run` starts one container per case, so a
# trial cannot read another case's rubric, answer or workspace.
# It shares the host network namespace, so the host's loopback provider proxy
# is reachable directly and the host's OPENCODE_CONFIG_CONTENT overlay passes
# through unchanged — no routes or credentials are baked into this repository.
#
# Usage:
#   ./container-run.sh all                 # full sweep: generate + per-case run + host judge
#   ./container-run.sh generate            # prompts, fixtures and rubrics
#   ./container-run.sh run E01             # one case, isolated container
#   ./container-run.sh judge               # host-side judging (provider keys)
#   ./container-run.sh summary             # host-side results table
#   ./container-run.sh export              # dossier from the selected stamp
#   ./container-run.sh describe --stamp X  # write the stamp's run.json host-side
# Extra flags pass through to harness.mts (--model, --judge-model, --stamp...).
# `--no-judge` runs `all` without the judge stage. `--discovery` runs the
# discovery variant: prompts carry no destinations, so the lakes are
# reachable only through `docs help` (measured per case).
# `--recording-closing original|direct` selects the recording prompt's closing
# block (default original); it refuses any non-recording selection.
#
# One source of truth for the case corpus: --fixture/PLACEMENT_CASES picks
# the corpus that generation, selection, the redacted run list, the frozen
# run description and reporting all use. Host-only commands (judge, summary,
# export, describe) need no podman and dispatch before the container toolbox
# is even checked.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PLACEMENT_IMAGE:-localhost/opencode-placement-trials}"
PROMPTS="${PLACEMENT_PROMPTS:-${HOME}/tmp/docs-placement/prompts}"
FIXTURES="${PLACEMENT_FIXTURES:-${HOME}/test-dir/docs-placement}"
RUBRICS="${PLACEMENT_RUBRICS:-${HOME}/tmp/docs-placement/rubrics}"
RESULTS="${PLACEMENT_RESULTS:-${HOME}/tmp/docs-placement/results}"
RUN_FIXTURES="${PLACEMENT_RUN_FIXTURES:-${HOME}/tmp/docs-placement/run-fixtures}"
CASES="${PLACEMENT_CASES:-$REPO/tests/fixtures/placement-cases.json}"

command -v node >/dev/null 2>&1 || {
    echo "node is required" >&2
    exit 1
}

# Same provider routes as the host session; the container shares the host
# network, so the loopback proxy overlay works as-is.
overlay="${OPENCODE_CONFIG_CONTENT:-}"

# ---------------------------------------------------------------- host-only
# Judging, reporting and run-description freezing need provider keys and the
# host's OpenCode binary, so they run on the host — no podman required. They
# dispatch BEFORE any container machinery so a podman-less machine can still
# score and export recorded evidence.
host_harness() {
    node "$HERE/harness.mts" "$@" \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --prompts "$PROMPTS" \
        --fixtures "$FIXTURES" \
        --rubrics "$RUBRICS"
}

require_podman() {
    command -v podman >/dev/null 2>&1 || {
        echo "podman is required (host-only commands judge/summary/export/describe need none)" >&2
        exit 1
    }
}

prepare_image() {
    require_podman
    if [ -n "${PLACEMENT_TRIAL_IMAGE_ID:-}" ]; then
        # Dispatch the frozen image by immutable id, never by a mutable tag.
        podman image exists "$PLACEMENT_TRIAL_IMAGE_ID" >/dev/null 2>&1 || {
            echo "frozen image $PLACEMENT_TRIAL_IMAGE_ID is not available" >&2
            exit 1
        }
        IMAGE_ID="$PLACEMENT_TRIAL_IMAGE_ID"
    else
        podman build -q \
            --build-arg "HOST_UID=$(id -u)" \
            --build-arg "HOST_GID=$(id -g)" \
            --network host \
            -t "$IMAGE" \
            "$HERE" >&2
        IMAGE_ID="$(podman image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
    fi
    mkdir -p "$PROMPTS" "$FIXTURES" "$RUBRICS" "$RESULTS" "$RUN_FIXTURES"

    TIMEOUT_ENV=()
    if [ -n "${TRIAL_TIMEOUT_MS:-}" ]; then
        TIMEOUT_ENV=(-e "TRIAL_TIMEOUT_MS=$TRIAL_TIMEOUT_MS")
    fi
    FIXTURE_HASH=""
    if [ -f "$CASES" ]; then
        FIXTURE_HASH="$(sha256sum "$CASES" | awk '{print $1}')"
    fi

    # The overlay travels by name: its value must not be a container argument
    # (or a shim log line).
    export OPENCODE_CONFIG_CONTENT="$overlay"
    CONTAINER_ENV=(
        --rm
        --network host
        --userns=keep-id
        --read-only
        --tmpfs "/tmp:rw,nosuid,size=768m"
        -e OPENCODE_CONFIG_CONTENT
        -e "PLACEMENT_IMAGE=$IMAGE"
        -e "PLACEMENT_IMAGE_ID=$IMAGE_ID"
        -e "PLACEMENT_FIXTURE_HASH=$FIXTURE_HASH"
        "${TIMEOUT_ENV[@]}"
        -e "XDG_CONFIG_HOME=/tmp/agent-home/.config"
        -e "XDG_DATA_HOME=/tmp/agent-home/.local/share"
        -e "XDG_CACHE_HOME=/tmp/agent-home/.cache"
    )
}

# The full repo is only mounted while generating: it writes prompts, sandbox
# fixtures and rubrics to the host mounts. The selected corpus is mounted at
# one stable in-container path (F12): generation must hash the same corpus
# the run list, judging and reporting use.
run_generate() {
    prepare_image
    podman run "${CONTAINER_ENV[@]}" \
        -v "$REPO:/repo:ro" \
        -v "$CASES:/cases/cases.json:ro" \
        -v "$PROMPTS:/prompts" \
        -v "$FIXTURES:/fixtures" \
        -v "$RUBRICS:/rubrics" \
        -v "$RESULTS:/results" \
        "$IMAGE_ID" \
        node /repo/tests/fixtures/placement-harness/harness.mts \
        generate \
        --plugin /repo \
        --fixture /cases/cases.json \
        --prompts /prompts \
        --fixtures /fixtures \
        --rubrics /rubrics \
        --results /results \
        "$@"
}

# The run fixture is the work/lakes/config-home sandbox plus the case's
# generation fingerprint. Rubrics and cases never enter it, even when an
# older generation left them behind. Staging is per stamp+case, so parallel
# sweeps cannot stage over each other.
prepare_case_fixture() {
    local id="$1"
    local stamp="$2"
    local source="$FIXTURES/$id"
    local target="$RUN_FIXTURES/$stamp/$id"
    [ -d "$source" ] || {
        echo "missing fixture $source; run generate first" >&2
        return 1
    }
    rm -rf "$target"
    mkdir -p "$target"
    local part
    for part in work lakes config-home generation.json; do
        [ -e "$source/$part" ] && cp -a "$source/$part" "$target/$part"
    done
    # Nonsecret per-case freeze receipt (M07): proves the stamp's run
    # description was actually frozen host-side — the container cannot read
    # that description (rubric-bearing definitions stay out) and a
    # permission error is never evidence a freeze exists. Ids, image and the
    # run.json digest only: no claims, no expected answers, no other cases.
    local run_digest
    run_digest="$(sha256sum "$RESULTS/$STAMP/run.json" | awk '{print $1}')"
    printf '%s\n' "{
  \"kind\": \"placement-freeze-receipt\",
  \"schemaVersion\": 1,
  \"stamp\": \"slot\",
  \"caseId\": \"$id\",
  \"runJsonSha256\": \"$run_digest\",
  \"image\": \"$IMAGE\",
  \"imageId\": \"$IMAGE_ID\"
}" >"$target/frozen.json"
}

# An id-only case list gives the run harness the selection without exposing
# claims, evidence, rubric text or the expected answers. The case's mutation
# policy and docs criterion are instrumentation, not rubric content, so they
# survive redaction: the run container must enforce the same policy as the
# host. The frozen generation's inputs hash rides along, so a staged
# generation record can be tied to the frozen experiment (M02) even though
# the full corpus cannot cross the container boundary.
#
# The cache is keyed by the REDACTION IDENTITY, not the corpus alone: the
# corpus bytes, every case's generation inputs hash (model, plugin, case
# definition, variant and sandbox permissions) and the redaction schema
# version. Regenerating for a different model therefore names a different
# file instead of reusing the previous generation's metadata.
prepare_cases_run() {
    local identity
    identity="$(node -e '
        const crypto = require("node:crypto");
        const fs = require("node:fs");
        const [corpusPath, fixturesRoot] = process.argv.slice(1);
        const bytes = fs.readFileSync(corpusPath);
        const cases = JSON.parse(bytes.toString("utf8"));
        const inputs = cases.map((doc) => {
            let inputsHash = null;
            try {
                inputsHash =
                    JSON.parse(
                        fs.readFileSync(
                            fixturesRoot + "/" + doc.id + "/generation.json",
                            "utf8",
                        ),
                    ).inputsHash ?? null;
            } catch {
                /* the run validation reports the missing/stale generation */
            }
            return { id: doc.id, inputsHash };
        });
        const identity = {
            redactionVersion: 1,
            corpusHash: crypto
                .createHash("sha256")
                .update(bytes)
                .digest("hex"),
            generation: inputs,
        };
        process.stdout.write(
            crypto
                .createHash("sha256")
                .update(JSON.stringify(identity))
                .digest("hex")
                .slice(0, 16),
        );
    ' "$CASES" "$FIXTURES")"
    CASES_RUN="$RUN_FIXTURES/cases-$identity.json"
    [ -f "$CASES_RUN" ] && return 0
    local staging="$CASES_RUN.tmp-$$"
    node -e '
        const fs = require("node:fs");
        const [corpusPath, fixturesRoot, outPath] = process.argv.slice(1);
        const cases = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
        const redacted = cases.map((doc) => {
            let generationInputsHash = null;
            try {
                const generation = JSON.parse(
                    fs.readFileSync(
                        fixturesRoot + "/" + doc.id + "/generation.json",
                        "utf8",
                    ),
                );
                generationInputsHash = generation.inputsHash ?? null;
            } catch {
                /* surfaced by the run validation, not here */
            }
            return {
                id: doc.id,
                ...(typeof doc.promptKind === "string"
                    ? { promptKind: doc.promptKind }
                    : {}),
                ...(doc.permissionProfile === "task"
                    ? { permissionProfile: "task" }
                    : {}),
                ...(doc.primaryCheck
                    ? { primaryCheck: doc.primaryCheck }
                    : {}),
                mutationPolicy: doc.mutationPolicy ?? null,
                docsCriterion: doc.docsCriterion ?? null,
                generationInputsHash,
            };
        });
        fs.writeFileSync(outPath, JSON.stringify(redacted, null, 2) + "\n");
    ' "$CASES" "$FIXTURES" "$staging"
    mv "$staging" "$CASES_RUN"
}

# The trial container gets only the runtime files the harness executes for its
# own case. The full harness directory also holds truth, the whole corpus,
# measurement assets, other cases' checks and campaign manifests, so it is
# never mounted.
prepare_harness_runtime() {
    local id="$1"
    local corpus="$RUN_FIXTURES/cases-selected-$id.json"
    local script
    script="$(
        node -e '
            const fs = require("node:fs");
            const [path] = process.argv.slice(1);
            const cases = JSON.parse(fs.readFileSync(path, "utf8"));
            process.stdout.write(cases[0]?.primaryCheck?.script ?? "");
        ' "$corpus"
    )"
    local sources=("harness.mts" "scenario-names.mts" "analysis/journal.ts")
    local checks=()
    if [ -n "$script" ] && [ -f "$HERE/primary-checks/$script" ]; then
        checks+=("primary-checks/$script")
        # Live corpus checks are .mts; historical replay checks stay .mjs with
        # their frozen bytes. Ship whichever shared helper each one imports.
        for shared in _replication-shared.mts _replication-shared.mjs; do
            [ -f "$HERE/primary-checks/$shared" ] &&
                checks+=("primary-checks/$shared")
        done
    fi
    local hash identity runtime staging file
    hash="$(
        cd "$HERE" &&
            sha256sum "${sources[@]}" ${checks[@]+"${checks[@]}"} |
            sha256sum | awk '{print $1}'
    )"
    identity="${hash:0:16}"
    runtime="$RUN_FIXTURES/harness-runtime-$identity-$id"
    [ -d "$runtime" ] && {
        HARNESS_RUNTIME="$runtime"
        return 0
    }
    staging="$runtime.tmp-$$"
    rm -rf "$staging"
    mkdir -p "$staging/analysis"
    for file in "${sources[@]}"; do
        cp -a "$HERE/$file" "$staging/$file"
    done
    for file in ${checks[@]+"${checks[@]}"}; do
        mkdir -p "$(dirname "$staging/$file")"
        cp -a "$HERE/$file" "$staging/$file"
    done
    mv "$staging" "$runtime"
    HARNESS_RUNTIME="$runtime"
}

# The run container sees only its own case: no other case's criteria, mutation
# policy or generation metadata is reachable.
case_corpus() {
    local id="$1"
    node -e '
        const fs = require("node:fs");
        const [corpusPath, caseId, outPath] = process.argv.slice(1);
        const cases = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
        const selected = cases.filter((doc) => doc.id === caseId);
        if (selected.length !== 1) {
            console.error("case " + caseId + " is not in the redacted corpus");
            process.exit(1);
        }
        fs.writeFileSync(outPath, JSON.stringify(selected, null, 2) + "\n");
    ' "$CASES_RUN" "$id" "$RUN_FIXTURES/cases-selected-$id.json"
}

parse_run_args() {
    STAMP=""
    IDS=()
    RUN_ARGS=()
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --stamp)
            STAMP="$2"
            shift 2
            ;;
        --stamp=*)
            STAMP="${1#*=}"
            shift
            ;;
        --model | --judge-model | --opencode | --condition | --recording-closing)
            RUN_ARGS+=("$1" "$2")
            shift 2
            ;;
        --jobs)
            # The wrapper loops synchronously — one container per case — so
            # --jobs past 1 would advertise container parallelism that does
            # not exist. Refuse rather than silently serialise (the host
            # harness pool, invoked directly, is where worker counts count).
            if ! [ "$2" -ge 1 ] 2>/dev/null || [ "$2" -gt 1 ]; then
                echo "run: --jobs >1 is not supported by the wrapper (containers start serially); run the harness directly for a worker pool" >&2
                return 2
            fi
            RUN_ARGS+=("$1" "$2")
            shift 2
            ;;
        --judge-jobs)
            RUN_ARGS+=("$1" "$2")
            shift 2
            ;;
        --allow-writes | --no-judge | --discovery | --print-logs)
            RUN_ARGS+=("$1")
            shift
            ;;
        [A-Za-z0-9]*)
            IDS+=("$1")
            shift
            ;;
        *)
            echo "run: unsupported argument $1" >&2
            return 2
            ;;
        esac
    done
    if [ "${#IDS[@]}" -eq 0 ]; then
        # Default selection comes from the corpus itself — any corpus works,
        # id namespaces are not restricted to E*.
        while IFS= read -r id; do
            [ -n "$id" ] && IDS+=("$id")
        done <<<"$(node -e '
                    const cases = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
                    for (const doc of cases) console.log(doc.id);
                ' "$CASES")"
    fi
    if [ "${#IDS[@]}" -eq 0 ]; then
        echo "run: no cases selected and the corpus is empty; run generate first" >&2
        return 2
    fi
    [ -n "$STAMP" ] || STAMP="$(date +%Y%m%d-%H%M%S)"
}

# One container per case: only that case's sandbox, prompt and result dir are
# mounted, and the plugin is a curated package rather than the whole repo.
# Before the loop, the stamp's run description is frozen host-side (whole
# corpus, real model, real plugin identity), so the id-only container runs
# can never relabel the evidence.
run_cases() {
    prepare_image
    parse_run_args "$@"
    prepare_cases_run
    # The describe freeze runs host-side but must record the TRIAL boundary
    # (the per-case containers), not the host orchestrator — so the image
    # facts travel with it (M07).
    PLACEMENT_TRIAL_IMAGE="$IMAGE" \
        PLACEMENT_TRIAL_IMAGE_ID="$IMAGE_ID" \
        node "$HERE/harness.mts" \
        describe \
        --stamp "$STAMP" \
        --prompts "$PROMPTS" \
        --fixtures "$FIXTURES" \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --rubrics "$RUBRICS" \
        --plugin "$REPO" \
        ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} \
        ${IDS[@]+"${IDS[@]}"} >&2 || return $?
    local overall=0
    local id status result_case name
    for id in "${IDS[@]}"; do
        prepare_case_fixture "$id" "$STAMP" || {
            overall=1
            continue
        }
        case_corpus "$id"
        prepare_harness_runtime "$id"
        result_case="$RESULTS/$STAMP/$id"
        mkdir -p "$result_case"
        status=0
        podman run "${CONTAINER_ENV[@]}" \
            --tmpfs /fixtures \
            -v "$RUN_FIXTURES/$STAMP/$id:/fixtures/$id:ro" \
            -v "$RUN_FIXTURES/cases-selected-$id.json:/fixtures/cases.json:ro" \
            -v "$PROMPTS/$id.md:/prompts/$id.md:ro" \
            -v "$result_case:/results/slot/$id" \
            -v "$HARNESS_RUNTIME:/harness:ro" \
            -v "$REPO/package.json:/repo/package.json:ro" \
            -v "$REPO/src:/repo/src:ro" \
            -v "$REPO/node_modules:/repo/node_modules:ro" \
            -v "$REPO/CONVENTION.md:/repo/CONVENTION.md:ro" \
            "$IMAGE_ID" \
            node /harness/harness.mts \
            run "$id" \
            --plugin /repo \
            --fixture /fixtures/cases.json \
            --prompts /prompts \
            --fixtures /fixtures \
            --results /results \
            --stamp slot \
            "${RUN_ARGS[@]}" || status=$?
        # Copy rubric/case only after the container exits. The run container
        # never sees this directory.
        for name in rubric.md case.json; do
            if [ -f "$result_case/meta.json" ] &&
                [ ! -f "$result_case/$name" ] &&
                [ -f "$RUBRICS/$id/$name" ]; then
                cp "$RUBRICS/$id/$name" "$result_case/$name"
            fi
        done
        if [ "$status" -ne 0 ]; then
            overall="$status"
        fi
    done
    return "$overall"
}

# Does this invocation say to skip the judge stage?
wants_no_judge() {
    local arg
    for arg in "$@"; do
        [ "$arg" = "--no-judge" ] && return 0
    done
    return 1
}

# Judge args: everything except --no-judge (meaningless to the judge stage).
judge_args() {
    local arg
    for arg in "$@"; do
        if [ "$arg" != "--no-judge" ]; then
            printf '%s\n' "$arg"
        fi
    done
}

SUBCOMMAND="${1:-}"
shift || true
case "$SUBCOMMAND" in
judge)
    host_harness judge "$@"
    ;;
summary)
    host_harness summary "$@"
    ;;
export)
    host_harness export "$@"
    ;;
describe)
    host_harness describe "$@" --plugin "$REPO"
    ;;
generate)
    run_generate "$@"
    ;;
build-image)
    prepare_image
    printf '%s\n' "$IMAGE_ID"
    ;;
run)
    run_cases "$@"
    ;;
all)
    run_generate "$@"
    overall=0
    run_cases "$@" || overall=$?
    # STAMP is a global resolved by parse_run_args inside run_cases.
    if ! wants_no_judge "$@"; then
        mapfile -t JARGS < <(judge_args "$@")
        host_harness judge --stamp "$STAMP" "${JARGS[@]}" || overall=$?
    fi
    host_harness summary --stamp "$STAMP" "$@" || true
    host_harness export --stamp "$STAMP" "$@" || true
    exit "$overall"
    ;;
*)
    echo "first argument must be a harness subcommand: generate|run|judge|summary|export|describe|all" >&2
    exit 2
    ;;
esac
