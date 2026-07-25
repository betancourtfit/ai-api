#!/usr/bin/env bash
set -eu

# Whisper model provisioning (D-01). These defaults are byte-identical to the
# Dockerfile ENV defaults (Task 2) — intentional duplication: the Dockerfile
# ENV is what an operator sees in `docker inspect`, this :- fallback is what
# keeps a bare `./start.sh` working outside Docker.
export WHISPER_MODEL_PATH="${WHISPER_MODEL_PATH:-/models/ggml-small.bin}"
export WHISPER_MODEL_URL="${WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin}"
export WHISPER_MODEL_SHA256="${WHISPER_MODEL_SHA256:-1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b}"

# D-04: provisioning runs in a background subshell so the Bun proxy still
# reaches PID 1 immediately below — a synchronous 466 MB download in front
# of it would let an EasyPanel healthcheck kill the container mid-download
# and crash-loop it forever, and would violate the standing rule that the
# Bun boot path never blocks on sidecar health.
(
    # D-05: provisioning failure is non-fatal. Using ensure-model.sh's exit
    # code as an `if` condition (rather than a bare invocation) is what
    # keeps `set -e` from killing this subshell — and therefore the
    # container — when HuggingFace is unreachable or the checksum does not
    # match. Chat proxying is the primary function; whisper is secondary.
    # D-06's atomic mktemp+mv inside ensure-model.sh is what makes it safe
    # for two containers to race this same script on a shared volume.
    #
    # Bind from WHISPER_HOST/WHISPER_PORT so the sidecar and the Bun proxy
    # (which reads the same vars via config.ts) stay in sync if an operator
    # overrides them. --convert shells out to ffmpeg for non-WAV inputs
    # (m4a/mp4/webm/aac). `exec` here keeps the process tree flat — the
    # subshell becomes whisper-server rather than spawning a child of it.
    if "$(dirname "$0")/ensure-model.sh"; then
        exec whisper-server --model "$WHISPER_MODEL_PATH" \
            --host "${WHISPER_HOST:-127.0.0.1}" --port "${WHISPER_PORT:-8080}" --convert
    else
        echo "whisper-model: sidecar not started" >&2
    fi
) &

# Exec the Bun proxy as the foreground process (PID 1) so it receives
# container signals immediately (D-04) — it must not wait on the background
# subshell above, whose model provisioning may still be running.
exec bun index.ts
