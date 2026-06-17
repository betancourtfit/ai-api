#!/usr/bin/env bash
set -e

# Launch whisper-server sidecar in the background.
# Bind from WHISPER_HOST/WHISPER_PORT so the sidecar and the Bun proxy (which reads
# the same vars via config.ts) stay in sync if an operator overrides them.
# --convert shells out to ffmpeg for non-WAV inputs (m4a/mp4/webm/aac).
whisper-server --model whisper-models/ggml-small.bin \
  --host "${WHISPER_HOST:-127.0.0.1}" --port "${WHISPER_PORT:-8080}" --convert &

# Exec the Bun proxy as the foreground process (PID 1) so it receives container signals.
exec bun index.ts
