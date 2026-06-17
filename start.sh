#!/usr/bin/env bash
set -e

# Launch whisper-server sidecar in the background.
# Binds to 127.0.0.1:8080 — matches WHISPER_HOST/WHISPER_PORT config defaults.
whisper-server --model whisper-models/ggml-tiny.bin --host 127.0.0.1 --port 8080 &

# Exec the Bun proxy as the foreground process (PID 1) so it receives container signals.
exec bun index.ts
