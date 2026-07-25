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

## Deploy pipeline (GHCR → EasyPanel)

### What CI does on every push to `master`

`verify` (install, typecheck, test, env guards) → `docker-image` (build the production image
with the commit SHA as `CACHEBUST`, audit it, boot it three ways and smoke it, then publish the
*same* image object to `ghcr.io/betancourtfit/ai-api:<sha>` and `:latest`) → `deploy` (call the
EasyPanel webhook, then poll production until `/health` reports the pushed SHA).

Only the image that passed every smoke is ever published — there is exactly one build step in
`docker-image` and the publish step re-checks the built image's id before pushing.

### One-time operator setup

Order matters — work through this in order:

1. Push to `master` once with this workflow in place. The `docker-image` job creates the package
   — **GitHub publishes a new package as private by default.**
2. Make the package public: `github.com/betancourtfit?tab=packages` → `ai-api` → *Package
   settings* → *Danger Zone* → *Change visibility* → **Public**. Also link it to this repository
   if GitHub has not already. Public visibility is what lets EasyPanel pull anonymously — there is
   deliberately no PAT and no registry credential anywhere in this setup.
3. EasyPanel → the service → *Source*: switch from **build from git** to **Docker image**, set
   `ghcr.io/betancourtfit/ai-api:latest`, leave registry credentials empty.
4. EasyPanel → the service → *Environment*: **delete the `BUILD_VERSION` variable** (it currently
   reads `v1`). This one is easy to miss — a runtime environment variable *overrides* the `ENV
   BUILD_VERSION` the image bakes from `CACHEBUST`, so leaving it set makes `/health` keep
   answering `ok v1` and the post-deploy smoke can never converge, no matter how correct the
   deploy is.
5. Keep the persistent volume mounted at `/models` (see [Whisper model volume](#whisper-model-volume)
   below) and leave `WHISPER_MODEL_*` unset.
6. EasyPanel → the service → deployment webhook: copy the URL. GitHub → repo *Settings* →
   *Secrets and variables* → *Actions* → *New repository secret* → `EASYPANEL_DEPLOY_WEBHOOK`.
   Note that anyone holding this URL can trigger a deploy; rotate it in EasyPanel if it is ever
   exposed.
7. Add a second secret `PUBLIC_BASE_URL` — the public origin of the API, **no trailing slash**.

Until steps 6 and 7 are done, the `deploy` job runs, prints a `::notice::` naming the missing
secret, and exits successfully. CI stays green throughout the manual setup; a red `deploy` job
means a real deploy problem, never an incomplete configuration.

### Checking which build is live

```bash
curl -s https://<your-host>/health
```

returns `ok <commit-sha>`. Compare it against the latest commit on `master`. This exists because
before the GHCR switch, EasyPanel built from git without passing `CACHEBUST`, so `/health`
returned a hand-typed static string that could not distinguish one build from another.

### Rolling back

Point the EasyPanel service image at `ghcr.io/betancourtfit/ai-api:<older-sha>` and redeploy;
every commit that ever reached `master` has an immutable tag. Two caveats:

- `:latest` still points at the newest build, so a rollback that pins a SHA must be un-pinned
  later.
- **Only the image is versioned — EasyPanel environment variables and service configuration are
  not in git** — so a rollback does not restore configuration changes made since that build.

### Manual publish

The SHA tag is the rollback handle, and the digest of every published image is printed by the
`Publish image to GHCR` step in the corresponding Actions run.

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
