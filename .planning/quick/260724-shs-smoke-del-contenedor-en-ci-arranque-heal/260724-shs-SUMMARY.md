---
phase: quick-260724-shs
plan: 01
subsystem: infra
tags: [github-actions, ci, docker, whisper, credential-scan, supply-chain]

requires:
  - phase: quick-260724-rp0
    provides: "docker-image CI job that builds the production image and audits its deps against bun.lock"
provides:
  - "docker-image job now boots the production image under its real start.sh entrypoint and asserts /health, /ready, and a real whisper transcription before the job can pass"
  - "docker-image job asserts the image's Bun version against a non-decaying >= 1.1.39 floor"
  - "docker-image dependency audit's anti-vacuous threshold is derived from package.json instead of a hardcoded 5"
  - "verify job's env-file guard now also scans allowlisted tracked .env files for live-credential prefixes (Groq/Cerebras/OpenAI/AWS), value-blind"

affects: [ci, deployment, docker-image, whisper]

tech-stack:
  added: []
  patterns:
    - "container smoke test: docker run -d under the real entrypoint, liveness-poll with a docker inspect guard before the port-poll, assert build stamp + readiness + a real functional call, dump logs on failure, remove always"
    - "anti-vacuous self-test pattern for a grep-based scanner: assert the scanner catches a synthetic positive before trusting a negative result on real files"
    - "derive a CI count-based guard from package.json instead of hardcoding a literal, so a legitimate change moves both sides of the comparison together"

key-files:
  created: []
  modified:
    - .github/workflows/ci.yml

key-decisions:
  - "Value-blind credential scan: grep -qE only, never cat/echo a match — the CI log is public and this repo is public"
  - "Dummy provider keys (CEREBRAS_API_KEY / GROQ_API_KEY) in the smoke — only presence is checked by getReadiness, never used for a real upstream call"
  - "WHISPER_TIMEOUT_MS raised to 180000ms for the smoke only — default 30000ms risked a false-negative 503 on the 2-vCPU runner's GGML_NATIVE=OFF build"
  - "Do NOT pass -e HOSTNAME=0.0.0.0 to the smoke container — Docker's container-ID HOSTNAME binding is exactly what production does; overriding it would mask a real production failure mode"
  - "Transcript content is asserted non-empty only, never matched against text — sample.wav is English, production default is WHISPER_LANGUAGE=es"

requirements-completed: [QUICK-260724-shs]

duration: ~15min (Tasks 1-2 autonomous execution); Task 3 blocked on human push + CI run
completed: null
---

# Quick Task 260724-shs: CI container smoke + guard hardening Summary

**STATUS: COMPLETE — all 3 tasks resolved. Verified on run `30134777498`, which is the first time this project's container has ever been started by anything.**

**`.github/workflows/ci.yml` now runs the production Docker image under its real `start.sh` entrypoint on every push to `master` and asserts `/health == ok <sha>`, `/ready == {ready:true,mode:"ok"}`, and a real transcription of `whisper-models/sample.wav` — closing the structural hole where nothing had ever actually started the container. Also hardened two decaying guards (Bun-version floor, dependency-audit anti-vacuous threshold) and added a value-blind live-credential scan over the allowlisted tracked `.env` files.**

## Performance

- **Tasks completed:** 2 of 3 (Task 3 is the blocking checkpoint)
- **Files modified:** 1 (`.github/workflows/ci.yml`)
- **`bun test`:** 119 pass / 0 fail (confirmed green before stopping)
- **`bunx tsc --noEmit`:** exit 0 (confirmed green before stopping)

## Accomplishments

- `verify` job's `Guard - no secret env files tracked` step now also scans every allowlisted tracked `.env` file (`.env.example`, `.env.test`) for four live-credential prefix patterns (Groq `gsk_`, Cerebras `csk-`, OpenAI `sk-`, AWS `AKIA`), self-testing itself against a synthetic token first so a regex/quoting regression can never silently turn it into a no-op. Ran the dry-run locally — clean, no hits, no file contents printed.
- `docker-image` job gained `Verify image Bun version`, asserting the built image's own `bun --version` against an absolute `>= 1.1.39` floor (the release that introduced the text lockfile format) — a floor that never decays, unlike the dependency-drift audit next to it.
- `docker-image`'s existing dependency-audit anti-vacuous threshold (previously a hardcoded `5`) is now derived live from `package.json`'s `dependencies + devDependencies + peerDependencies` count, so a legitimate dependency change moves both sides of the comparison instead of tripping a false "check is vacuous".
- `docker-image` gained three new steps — `Smoke - run the real container`, `Smoke - container logs on failure`, `Smoke - remove container` — that boot the image under its real entrypoint, wait for liveness with a `docker inspect` dead-container guard (not a fixed sleep), assert the `/health` build-stamp against `GITHUB_SHA`, assert `/ready` is `{ready:true,mode:"ok"}`, and drive a real transcription of the tracked `whisper-models/sample.wav` through `POST /v1/audio/transcriptions` with bounded retries — the only assertion in the whole pipeline that proves whisper-server survived `start.sh`'s background `&` launch.
- The `verify` job's step **name list is unchanged** (byte-identical to before), so repository ruleset `require-ci-on-master` continues to resolve against the `verify` check.
- `bun test` (119/119) and `bunx tsc --noEmit` (exit 0) both confirmed green after the edits.

## Task Commits

1. **Task 1: Harden the Bun-version, anti-vacuous, and env-credential guards** — `f47c83e` (feat)
2. **Task 2: Add the real-container smoke to the docker-image job** — `96bcd28` (feat)
3. **Task 3: Human verification — real push to master + read the CI run** — RESOLVED. Required one fix commit, `947a7fd`, before the workflow would run at all (see below).

### The first push failed before any job started

Run `30134707079` failed with *"This run likely failed because of a workflow file issue"*, no jobs, and the run titled `.github/workflows/ci.yml` instead of `CI` — the giveaway that GitHub never parsed the `name:` field.

Cause: a comment inside the smoke step's `run:` block contained a literal `${{ }}` while explaining that `GITHUB_SHA` is read as a plain runner variable and *not* as a GitHub expression. GitHub interpolates expressions anywhere inside a `run:` string, including on lines that are only shell comments, so the empty expression was a syntax error that rejected the entire file.

`Bun.YAML.parse` and `bash -n` both passed on it — the file was valid YAML and valid shell. This class of error is only visible to GitHub's own expression parser, which is why neither local check caught it. The follow-up check added when fixing it asserts no `${{ }}` expression is empty; a proper `actionlint` run in CI would be the general fix and is not yet wired.

## Files Created/Modified

- `.github/workflows/ci.yml` — extended `verify`'s credential guard step; added `Verify image Bun version`; replaced the hardcoded anti-vacuous `5` with a `package.json`-derived count; appended the three-step container smoke to `docker-image`

## Decisions Made

See `key-decisions` in frontmatter. Additionally: kept the existing `verify` job step names and bodies (`checkout`, `setup-bun`, `Install`, `Typecheck`, `Test`) completely untouched per the plan's hard constraint, only extending the guard step's body.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded a pre-existing comment that collided with Task 2's own verification regex**
- **Found during:** Task 2 automated verify
- **Issue:** The plan's Task 2 verification asserts the whole workflow file contains no `secrets.` substring (guarding against a stray `${{ secrets.* }}` reference in the smoke). A pre-existing comment on line 37, from before this quick task ("...no repo secrets. Its contents were human-verified..."), incidentally matched the same `/secrets\./` regex and made the check fail even though it has nothing to do with a GitHub Actions secrets-context reference.
- **Fix:** Reworded "no repo secrets." to "no repo secret values." — comment-only, zero behavior change.
- **Files modified:** `.github/workflows/ci.yml`
- **Verification:** Re-ran both Task 1's and Task 2's automated `bun -e` checks after the edit; both pass.
- **Committed in:** `96bcd28` (part of Task 2 commit, documented in the commit message)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Comment-only change, no functional or security impact. No scope creep.

## Issues Encountered

None beyond the deviation above.

## Task 3 resolution — run `30134777498`, both jobs green

`verify` 7s, `docker-image` **132s** (100s prior steady state + ~32s for the smoke, well under the 60-150s budgeted). Log lines read directly from the run, not inferred from the green tick:

```
Image Bun version: 1.3.11
OK: image Bun 1.3.11 >= 1.1.39
Parsed 5 dependency tokens from the image.
Success: all 5 image dependencies match bun.lock.
OK: /health == ok 947a7fd245fd85138644f5fa88c88981806399d8
{"ready":true,"mode":"ok","eligibleProviders":["cerebras","groq"],"unavailableProviders":[],"whisperAvailable":true}
Transcript excerpt:  Y así, amigos americanos, no preguntes lo que tu país puede hacer para ti.
 Puedes preguntar lo que puedes hacer para tu país.
```

and in `verify`:

```
OK: no tracked env files outside the allowlist (.env.example, .env.test)
OK: no live-credential prefixes in the allowlisted env files
```

### What each line actually proves

- **`/health == ok 947a7fd…`** matches the exact pushed SHA, closing the `build-args CACHEBUST` → `ARG CACHEBUST` → `ENV BUILD_VERSION` → `handleHealth` chain end to end. That chain had been fed by three builds with nothing ever confirming it reached runtime. It is now the mechanism a post-deploy smoke can trust to tell builds apart.
- **The transcript** is the real payoff. It is the only assertion that proves `whisper-server` survived the `&` in `start.sh` — the process is launched in the background while `exec bun index.ts` takes PID 1, `set -e` does not cover it, and there is no supervisor. Until this run, a container with a dead whisper would still have reported `ok <sha>` on `/health` and 503'd every transcription.
- **`whisperAvailable: true`** resolves an open question the plan had hedged on: `HttpWhisperService.health()` probes `GET /health` on whisper-server, and it was unknown whether the pinned v1.7.6 build exposes it. It does. The planned `::warning::` branch never fired.
- **`OK: no live-credential prefixes`** replaces a verbal "env.test OK" with a machine check that reruns on every push, without any step ever reading or printing a value.
- The transcript is Spanish because `WHISPER_LANGUAGE` defaults to `es` while `sample.wav` is whisper.cpp's English JFK clip. Only non-emptiness is asserted, deliberately.

## Next Phase Readiness

The structural hole is closed: CI now starts the real image and proves it serves. This was a prerequisite for automating deploys — a post-deploy smoke can now reuse an assertion set already known to discriminate, rather than polling a `/health` that returns `ok` regardless of whether transcription works.

---
*Phase: quick-260724-shs*
*Completed: pending Task 3*
