---
phase: quick-260724-mv1
plan: 01
subsystem: docker-deploy
tags: [docker, ci, whisper, volume, deployment]
status: blocked-on-checkpoint
dependency-graph:
  requires: []
  provides:
    - "ensure-model.sh: idempotent, sha256-verified whisper model provisioning into /models"
    - "Dockerfile: slimmed image (~350 MB target), VOLUME /models, WHISPER_MODEL_* defaults"
    - "CI: image-slimness gate + cold/warm/degraded container smokes"
  affects:
    - "next quick task: publish to GHCR + EasyPanel image-deploy switch (needs the slim image this task produces)"
tech-stack:
  added: []
  patterns:
    - "atomic mktemp+mv model install (D-06)"
    - "background-subshell provisioning so PID 1 exec is never blocked (D-04)"
    - "non-fatal degraded boot on provisioning failure (D-05)"
key-files:
  created:
    - ensure-model.sh
  modified:
    - start.sh
    - Dockerfile
    - .dockerignore
    - README.md
    - CLAUDE.md
    - AGENTS.md
    - .github/workflows/ci.yml
decisions:
  - "Warm/degraded CI containers pass all 8 -e overrides (5 dummy-credential + 3 tiny-model), not just 'the same five' literally read from the plan text — see Deviations."
metrics:
  duration: "~35 min (Tasks 1-3, local verification only; Task 4 is an unresolved human-verify checkpoint)"
  completed: null
---

# Quick Task 260724-mv1: Whisper model moved to a runtime volume Summary

**One-liner:** Removed the 466 MB `ggml-small.bin` from the Docker image, added `ensure-model.sh` for sha256-verified boot-time provisioning into a `/models` volume, and wired CI to prove cold-download, warm-cache and degraded-boot behavior with a 77 MB `ggml-tiny` model. **COMPLETE** — verified on run `30136186084` after one failed run and one fix (below).

## Status: BLOCKED ON CHECKPOINT

All four tasks are complete. Task 4 was resolved by the orchestrator: pushed to `master`, read the `docker-image` logs, fixed one real defect the run exposed, and re-verified.

### Run 1 (`30136048728`) — FAILED, and the failure was a design defect worth keeping

The size gate tripped: `Image is 709 MiB, at or above the 600 MiB ceiling`. Two things were wrong, and only one of them was the threshold.

The estimate was bad: "~350 MiB expected, ~840 MiB today" ignored the uncompressed Debian base (~250 MiB, confirmed against the Docker Hub registry API: 84 MiB compressed across the `oven/bun:1.3.11` amd64 layers) plus ffmpeg's dependency tree. 709 MiB with the model already gone is the real baseline.

The ordering was the actual defect: the **precise** check (`find ggml-*.bin`) ran *after* the **coarse** one (image size), so a threshold guess failed the job before the check that could actually answer "is the model still in the image?" ever reported. Fixed in `0536e72` — structural check first, size gate demoted to a coarse tripwire at 900 MiB (`ggml-small` is 466 MiB, so a re-entry lands near 1175 MiB and still trips). A gate that fails on ordinary base-image drift gets muted, which is worse than no gate.

Incidentally, the arithmetic already ruled out a regression before the fix ran: if the model were still baked in, everything else in the image would have to fit in 709 − 466 = 243 MiB, which is less than the base image alone.

### Run 2 (`30136186084`) — green, `verify` 12s, `docker-image` 76s

```
OK: image Bun 1.3.11 >= 1.1.39
OK: no ggml-*.bin anywhere in the image, find probe confirmed working
Image size: 743901451 bytes (~709 MiB)
OK: image size 709 MiB is below the 900 MiB ceiling
OK: /health == ok 0536e723c7c6898efaad588329c0d87898d81b87
Transcript excerpt:  Y soy el americano. No es algo que no es que tu es tu...
OK: cold boot proved the real download + install path
OK: warm boot hit the cache without downloading
OK: smoke-degraded /health == ok 0536e723...
OK: smoke-degraded logged the provisioning failure
OK: smoke-degraded is still running 10s after the provisioning failure
OK: smoke-degraded /ready reports ready==true, whisperAvailable==false -- degradation is observable, not silent
```

`docker-image` went 132s → 76s. The model download left the build, and the three container smokes are cheap.

### One behavioural finding, now documented in the workflow

The cold smoke's `/ready` reported `whisperAvailable: false` **while the transcription that ran six seconds later succeeded**. This is not a defect and not the explanation the original warning text guessed at. `/ready` is polled while the model is still downloading in `start.sh`'s background subshell, so whisper-server has not been launched yet. Run `30134777498` — back when the model was baked in and whisper-server started immediately — reported `whisperAvailable: true`, which rules out the competing theory that the pinned v1.7.6 build has no `GET /health`.

**Production will show this same window on the first boot after the volume is empty:** `/health` returns `ok <sha>`, `/ready` returns `ready:true` with `whisperAvailable:false`, and transcriptions 503 until the 466 MB download completes. Chat proxying works throughout. The misleading warning text was corrected so a future reader is not sent chasing a whisper-server endpoint that does exist.

### Not verified

`mode` stays `"ok"` in `/ready` even when whisper is unavailable — only `whisperAvailable` reflects it. Whether that field *should* read `"degraded"` is an app-behaviour question outside this task's scope; the readiness contract in `CLAUDE.md` §20 defines `mode` in terms of provider availability, not whisper.

## What Was Done

### Task 1 — `ensure-model.sh` + `start.sh` rewiring (commit `26c15e6`)

Created `ensure-model.sh` at the repo root: a standalone, portable (`bash 3.2`,
`sha256sum`/`shasum -a 256` shim) provisioning script. Contract: exit 0 means the file at
`$WHISPER_MODEL_PATH` exists and (when a checksum was supplied) matches it; exit 1 means
nothing partial was left behind. Control flow implements every step from the plan in order:
path/checksum validation, cache-hit check with checksum self-heal, https-only + checksum-required
guards before any download, a stale-`.model.*`-temp sweep, `mktemp` + atomic `mv` install, and the
exact ASCII log markers the CI contract depends on (`whisper-model: cache hit at ...`,
`whisper-model: downloading from ...`, `whisper-model: install ok at ...`,
`whisper-model: checksum mismatch on cached file, discarding`, `whisper-model: unavailable: ...`).

Rewrote `start.sh`: `set -e` → `set -eu`; the three `WHISPER_MODEL_*` variables are now exported
with `:-` fallbacks byte-identical to the Task 2 Dockerfile `ENV` defaults; provisioning runs in a
background subshell using `ensure-model.sh`'s exit code as an `if` condition (D-04/D-05) so
`exec bun index.ts` still reaches PID 1 immediately regardless of provisioning outcome; on success
the subshell `exec`s `whisper-server`, on failure it logs `whisper-model: sidecar not started` and
the container stays up.

All five provisioning paths were exercised for real on the dev machine against the live 77 MB
`ggml-tiny` model: cold download (installs exactly 77691713 bytes, no temp residue), warm cache hit
(no re-download), corrupted-cache self-heal (discarded and re-fetched), wrong-checksum rejection
(exit 1, nothing installed), and the https/checksum/URL config guards (three separate rejections,
each verified with the real curl 404 against a stale HF URL).

### Task 2 — Dockerfile slim-down + docs (commit `a2d4301`)

Builder stage: deleted the `curl ... | sha256sum -c -` model-fetch `RUN` (was producing the 426 MB
layer); left the builder's `apt-get install` line with `curl` untouched (editing it would
invalidate the cached whisper.cpp compile layer for a 3 MB saving in a stage that never ships) and
added an explanatory comment instead.

Final stage: added `curl` + `ca-certificates` to the runtime `apt-get install` line (D-10); deleted
the `COPY --from=builder /models/ggml-small.bin ...` line (the 426 MB blob); extended
`RUN chmod +x` to cover both `start.sh` and `ensure-model.sh`; added the three `WHISPER_MODEL_*`
`ENV` defaults matching `start.sh`'s `:-` fallbacks byte for byte; added `RUN mkdir -p /models` +
`VOLUME /models`.

`.dockerignore`: added `whisper-models/*.bin` (models now live in the runtime volume) while keeping
`whisper-models/` itself un-excluded so the tracked `sample.wav` stays in the build context.

`README.md`: new "Whisper model volume" section — EasyPanel mount instructions, first-boot
behaviour, degraded mode, the three override variables in a table, and an explicit
`WHISPER_MODEL_PATH` vs `WHISPER_MODEL_ALIAS` disambiguation.

`CLAUDE.md` / `AGENTS.md`: surgical addition of the three `WHISPER_MODEL_*` variables under a new
`# Whisper model provisioning (runtime volume)` heading inside the existing `## 7. Environment
variables` code block — no restructuring of either file.

`bun test` 119/119 and `bunx tsc --noEmit` clean (this task touches no TypeScript).

### Task 3 — CI image-slimness gate + cold/warm/degraded smokes (commit `541ea94`)

All edits confined to the `docker-image` job. Verified by `diff` that the `verify` job (name and
every step) is byte-identical to `HEAD` before this task started.

- New step `Verify the image ships no whisper model`: reads `docker image inspect ... --format
  '{{.Size}}'` (no leading `$` — Go template syntax, not a GitHub expression), asserts an
  anti-vacuous 100 MiB floor and a 600 MiB ceiling, then a structural `find /app /models -name
  "ggml-*.bin"` gate with its own anti-vacuous `package.json`-count companion probe.
- Cold smoke (`Smoke - run the real container`) now runs with `-v smoke-models:/models` and the
  three tiny-model overrides (D-02), and after the existing real-transcription assertion, checks
  `docker logs smoke` for both `whisper-model: downloading from` and `whisper-model: install ok at`
  — proof the real download path ran, not a pre-seeded volume (D-09).
- New step `Smoke - warm boot and degraded boot`: a `smoke-warm` container on the same volume polls
  for `whisper-model: cache hit at` and then asserts no `downloading from` marker exists in its
  logs; a `smoke-degraded` container with a broken model URL asserts `/health` still answers,
  `whisper-model: unavailable:` is logged, the container is still running 10s later, and `/ready`
  reports `ready==true` with `whisperAvailable==false` — the non-crash-loop proof for D-05.
- Cleanup steps updated to dump and remove all three containers, then the shared named volume
  (containers first, since `docker volume rm` refuses while one still references it).

No literal empty `${{ }}` expression, no `secrets.` reference, YAML parses via `Bun.YAML.parse`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Warm/degraded CI containers pass all 8 `-e` overrides, not literally "the same five"**
- **Found during:** Task 3, writing the `Smoke - warm boot and degraded boot` step
- **Issue:** The plan's prose says the warm container gets "the same five `-e` values as the cold
  container." Read literally, that would mean only the 5 pre-existing dummy-credential/alias/timeout
  variables — omitting the three `WHISPER_MODEL_PATH`/`URL`/`SHA256` tiny-model overrides that Task
  3's own cold-smoke edit adds to the cold container. Without those three, `smoke-warm` would default
  to the production `ggml-small` path/URL/checksum, which is not what's cached in `smoke-models` —
  the warm-cache-hit assertion would either fail outright or silently test the wrong file identity.
- **Fix:** `smoke-warm` and `smoke-degraded` (except for its intentionally-broken `PATH`/`URL`) both
  receive the full 8-variable set the cold container uses, so all three containers agree on which
  model file they're provisioning/checking in the shared volume.
- **Files modified:** `.github/workflows/ci.yml`
- **Commit:** `541ea94`

### Other Notes (not deviations)

- `ensure-model.sh`'s `checksum mismatch on cached file, discarding` marker was routed to stderr
  (grouped with the `unavailable:` failure markers) since the plan's stdout/stderr split names
  markers by category ("informational" vs "failure") without assigning this one explicitly. It
  signals a detected problem even though the script recovers by re-downloading, so it reads more
  naturally as a failure-adjacent marker. The CI/local verification greps redirect `2>&1` in every
  case, so this choice does not affect any test outcome.

## Known Stubs

None.

## Threat Flags

None — every new trust-boundary interaction (runtime model fetch, mounted volume, two new apt
packages) was already enumerated and dispositioned in the plan's own `<threat_model>` (T-mv1-01
through T-mv1-08, T-mv1-SC). No additional surface was introduced beyond what that register covers.

## EasyPanel Action Required (do this before the next production deploy)

**The service needs a persistent volume mounted at `/models`.** This is documented in
`README.md` under "Whisper model volume" → "EasyPanel setup", but it bears repeating here because
missing it silently degrades performance rather than failing loudly:

1. In the EasyPanel service's **Mounts / Volumes** panel, add a persistent volume mounted at
   `/models`.
2. Leave the `WHISPER_MODEL_*` environment variables **unset** in EasyPanel — the image's `ENV`
   defaults already point at the production `ggml-small` model.
3. **If this mount is skipped:** the container still boots and still works — but every container
   recreate (deploy, restart, EasyPanel maintenance) re-downloads the full ~466 MB model into a
   fresh anonymous volume instead of reusing a persisted one. It is not a crash risk, just wasted
   bandwidth and a slower first transcription after every recreate.

## Self-Check

```
FOUND: ensure-model.sh
FOUND: start.sh
FOUND: Dockerfile
FOUND: .dockerignore
FOUND: README.md
FOUND: CLAUDE.md
FOUND: AGENTS.md
FOUND: .github/workflows/ci.yml
FOUND commit: 26c15e6
FOUND commit: a2d4301
FOUND commit: 541ea94
```

## Self-Check: PASSED

## Next Steps (for the orchestrator / user)

1. Push `master` (the `docker-image` job is skipped on pull requests — it only runs on push).
2. Open the `docker-image` job run and read, per the Task 4 checkpoint instructions:
   - `Verify the image ships no whisper model` — record the printed image size (expect ~350 MiB).
   - `Smoke - run the real container` — confirm `whisper-model: downloading from` +
     `whisper-model: install ok at`, then `/health`, then a non-empty transcript.
   - `Smoke - warm boot and degraded boot` — confirm the cache-hit marker with no download marker
     for `smoke-warm`, and `whisper-model: unavailable:` + still-running + degraded `/ready` for
     `smoke-degraded`.
3. Confirm total job wall time is still reasonable (~132s baseline + 30-60s for the two extra
   containers) and that the whisper.cpp compile layer stayed a cache hit.
4. Complete the EasyPanel `/models` volume mount (see above) before the next production deploy.
5. Report back with "approved" + the printed image size, or paste the failing log lines, so this
   quick task can be marked complete.
