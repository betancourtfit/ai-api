# bun-ai-api

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.5. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Whisper model volume

The whisper model is no longer baked into the Docker image. The container provisions it
into `/models` on first boot (`ensure-model.sh`, run from `start.sh`) and verifies its
sha256 checksum before every use, including on subsequent boots against an already-cached
file.

### EasyPanel setup

In the service's **Mounts / Volumes** panel, add a **persistent volume mounted at
`/models`**. Leave the `WHISPER_MODEL_*` environment variables unset to get the
production `ggml-small` default. Without that mount, the model is re-downloaded into a
fresh anonymous volume on every container recreate — it still works, it is just slow and
wasteful (~466 MB every time).

### First-boot behaviour

Chat completions and `GET /health` are available immediately — the Bun proxy execs to
PID 1 without waiting on the model. `GET /ready` reports `whisperAvailable:false` and
`POST /v1/audio/transcriptions` returns `503` until the ~466 MB download and model load
finish. Watch for `whisper-model:` lines in the container logs to follow progress.

### Degraded mode

If the download fails or the checksum does not match, the container keeps serving chat
and logs `whisper-model: unavailable: <reason>`. It does not exit and does not
crash-loop — whisper transcription is a secondary feature; chat proxying is primary.

### Override variables

| Variable | Purpose |
|---|---|
| `WHISPER_MODEL_PATH` | Absolute path inside `/models` where the model file is provisioned and loaded from |
| `WHISPER_MODEL_URL` | HTTPS source the model is downloaded from when missing or corrupted |
| `WHISPER_MODEL_SHA256` | Expected sha256 checksum of the model file, verified before install and on every boot |

These three must be changed together. The URL must be `https://` — the entrypoint
refuses non-HTTPS sources — and a missing or blank checksum makes the entrypoint refuse
to download at all (it will still serve an already-present, unverified file if one is
manually mounted).

### `WHISPER_MODEL_PATH` vs `WHISPER_MODEL_ALIAS`

These are unrelated despite the similar name, and the collision is a live footgun:

- `WHISPER_MODEL_PATH` is the file on disk that `ensure-model.sh` provisions and
  `whisper-server` loads.
- `WHISPER_MODEL_ALIAS` is the client-facing `model` field value validated by
  `handleTranscriptions` in the multipart request — it has nothing to do with where the
  model file lives.
