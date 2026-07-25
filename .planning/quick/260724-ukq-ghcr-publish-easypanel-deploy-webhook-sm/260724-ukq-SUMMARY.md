---
phase: quick-260724-ukq
plan: 01
subsystem: infra
tags: [github-actions, ci, docker, ghcr, easypanel, deploy, webhook]

requires:
  - phase: quick-260724-mv1
    provides: "/models runtime volume + ensure-model.sh provisioning, and the cold/warm/degraded boot smokes this plan's deploy-job convergence check reuses conceptually"
provides:
  - "Per-job GitHub Actions permissions (verify: contents:read only; docker-image: contents:read + packages:write)"
  - "GHCR publish of the exact smoked bun-ai-api:ci image object, tagged <sha> and :latest"
  - "In-image gate against shipping any .env* file outside .env.example / .env.test"
  - "deploy job: EasyPanel webhook trigger + bounded post-deploy /health SHA-convergence + /ready smoke"
  - "README operator runbook (7-step checklist) + rollback procedure"
affects: [deploy-pipeline, ci-workflow, easypanel-service-config]

tech-stack:
  added: []
  patterns:
    - "In-shell secret-presence gating in GitHub Actions (secrets context unavailable in if:, so job/step continues and self-skips with ::notice::)"
    - "Re-tag-and-push publish pattern: never a second docker/build-push-action step, publish the exact object every smoke ran against, re-asserted by image id before push"
    - "N-consecutive-match polling to defeat in-place-rollout false positives"

key-files:
  created: []
  modified:
    - .github/workflows/ci.yml
    - README.md

key-decisions:
  - "Publish by re-tagging bun-ai-api:ci and pushing after every smoke, not a second build-push-action step with push:true — preserves the chain of guarantee that GHCR only ever receives an image that was actually smoked"
  - "packages: write scoped to docker-image job only; verify (the required check under ruleset require-ci-on-master) keeps contents:read only"
  - "Missing EASYPANEL_DEPLOY_WEBHOOK / PUBLIC_BASE_URL secrets produce a clean skip (::notice:: + exit 0), never a red run — the two secrets are expected to land after the workflow does"
  - "Post-deploy /health poll requires 3 consecutive exact ok <sha> matches (not a single 200) to avoid a false pass against an old container mid in-place-rollout"
  - "whisperAvailable is warning-only in the post-deploy smoke; mode:degraded on /ready is a legitimate documented state and never fails the deploy"

requirements-completed: [QUICK-260724-ukq]

duration: ~35min (Tasks 1-3; Task 4 blocked on operator)
completed: 2026-07-24
---

# Quick Task 260724-ukq: GHCR Publish + EasyPanel Deploy Webhook Summary

**CI now publishes the exact smoked container image to GHCR (`<sha>` + `:latest`), triggers an EasyPanel deploy webhook, and polls production `/health`/`/ready` until it proves convergence to the pushed commit — closing the last gap in the deploy chain (production previously answered a hand-typed static `ok v1`).**

## Status: COMPLETE — with the deploy trigger deliberately descoped

All four tasks resolved. The image pipeline is live and end-to-end verified in production. The one piece deliberately **not** shipped is the automatic deploy trigger; see "Why the webhook was descoped" below. Deploys stay manual (one click in EasyPanel), which is what the operator was already doing.

### The closing evidence

`GET /health` on the production mini PC returns:

```
ok 0adb820481b45ca5a789d348c1608e57634a6a1d
```

That string is the whole point of this task. It is the exact `master` HEAD, baked at build time in CI via `CACHEBUST` → `ARG` → `ENV BUILD_VERSION` → `handleHealth`. Before today the same endpoint answered `ok v1` — a static value typed into EasyPanel that could not distinguish one build from another. Production build identity is now verifiable from outside.

### What the pipeline does now, per push to master

1. `verify` — install, typecheck, 119 tests, tracked-env guard + live-credential scan.
2. `docker-image` — builds once, then against that one image: Bun `>= 1.1.39` floor, deps audited against `bun.lock`, no `ggml-*.bin` baked in, no unexpected `.env*`, cold-boot smoke (real download + `/health` == SHA + real transcription), warm-boot smoke (cache hit, no download), degraded-boot smoke (provisioning fails, container stays up, `/ready` reports it).
3. Publishes **that same image object** to `ghcr.io/betancourtfit/ai-api`, tagged by SHA and `latest`.
4. `deploy` — skips cleanly with a `::notice::` while `EASYPANEL_DEPLOY_WEBHOOK` is unset.

Run `30138348904` published:

```
OK: publishing the exact image every smoke ran against (sha256:72626fec...)
0adb820481b45ca5a789d348c1608e57634a6a1d: digest: sha256:5d25f18a... size: 3447
latest: digest: sha256:5d25f18a... size: 3447
Rollback handle (repo digest): ghcr.io/betancourtfit/ai-api@sha256:5d25f18a...
```

Both tags resolve to one digest, and that digest is the object every smoke ran against — not a rebuild. Verified anonymously against the GHCR registry API after the package was made public: 3 tags, 15 layers, **276 MiB compressed**.

The EasyPanel pull:

```
### Pulling image ghcr.io/betancourtfit/ai-api:latest   01:38:53 GMT
### Success                                             01:39:10 GMT
```

**17 seconds**, against a previous deploy that compiled whisper.cpp on the mini PC. That was the original goal of the whole CI/CD effort.

### Why the webhook was descoped

The plan assumed CI could POST EasyPanel's deploy webhook. Three findings killed it, in order of severity:

1. **The webhook URL is not reachable from the internet.** EasyPanel serves it at `http://<public-ip>:3000/api/deploy/<token>`. Probed from outside: `http=000`, timeout. GitHub's runners cannot reach it, so no amount of workflow code would have worked.
2. **It is plain HTTP.** The deploy token would travel unencrypted on every CI run.
3. **The token was exposed** in a screenshot during setup and was rotated.

Reaching it would mean exposing EasyPanel's API port to the internet — a security downgrade to save one click on a personal project. Declined. The correct path, if ever wanted, is to serve the panel API over HTTPS behind the existing reverse proxy and confirm `/api/deploy/<token>` returns 2xx; the workflow already supports it and needs only the secret, no code change.

### One defect found and fixed during Stage A

The first run failed with `EasyPanel deploy webhook returned HTTP 000000`. Two bugs in one line: `curl -w '%{http_code}'` printed `000` for a connection that never completed, and the `|| echo 000` fallback concatenated a second `000`; meanwhile curl's own exit code — the only datum distinguishing DNS from refused from timeout from TLS — was discarded. Fixed in `0adb820`: exit code captured and reported with a legend, plus the URL is trimmed of CR/LF and shape-checked against `^https://` before a request is spent. The improved message immediately identified the real problem — `length after trimming: 3`, a placeholder value — where the old one said nothing useful.

### Not verified

- `/ready` was not re-checked after switching the image source from build-from-git to deploy-image. The volume survived a container recreate earlier (quick task 260724-mv1), but a source change is a different code path and `whisperAvailable` was not re-read afterwards.
- The webhook's success path has never executed, for the reasons above.
- The post-deploy convergence smoke has never run. Its code is in the workflow and structurally checked, but no real execution has exercised the 3-consecutive-reads poll, the timeout branch, or its diagnostics.

## Performance

- **Tasks completed:** 3 of 4 (Task 4 is the blocking checkpoint)
- **Files modified:** `.github/workflows/ci.yml`, `README.md`
- **Tests:** `bun test` 119/119 pass (unchanged — no TypeScript touched)
- **Typecheck:** `bunx tsc --noEmit` exit 0

## Task Commits

1. **Task 1: Per-job permissions, pre-publish leak gate, and GHCR publish of the exact smoked image** — `6bb3827` (feat)
2. **Task 2: deploy job — EasyPanel webhook trigger + bounded post-deploy convergence smoke** — `696e60a` (feat)
3. **Task 3: README operator runbook and rollback procedure** — `b34168f` (docs)

Per the execution constraints for this run, this executor does not commit SUMMARY.md/STATE.md/ROADMAP.md/PLAN.md — the orchestrator handles that final docs commit. All three plan tasks above are code/doc task commits made directly by this executor.

## Files Created/Modified

- `.github/workflows/ci.yml` — moved `permissions` from workflow-level to per-job (`verify`: `contents: read`; `docker-image`: `contents: read` + `packages: write`); added `Record the smoked image id`, `Verify the image ships no unexpected env file`, `Log in to GHCR`, `Publish image to GHCR` steps inside `docker-image`; added new `deploy` job (needs `docker-image`, `if: github.event_name == 'push'`, `contents: read` only) with `Trigger EasyPanel deploy` (webhook POST, clean skip on missing secret) and `Smoke - post-deploy` (bounded 3-consecutive-match `/health` SHA poll, `/ready` assertion, warning-only whisper wait) steps.
- `README.md` — new `## Deploy pipeline (GHCR → EasyPanel)` section (placed before `## Whisper model volume`): what CI does on every push, a 7-step numbered operator setup checklist, "checking which build is live", rollback procedure with both caveats, and a one-line manual-publish escape hatch.

## Decisions Made

See `key-decisions` in frontmatter. All decisions were pre-specified by the plan (LOCKED FACTS); no architectural deviations were made.

## Deviations from Plan

None — plan executed exactly as written. All four automated verification blocks (Task 1, Task 2, Task 3, and the plan-level post-Task-3 verification) passed on first attempt with no fix-up iterations.

## Issues Encountered

None during Tasks 1-3. Every `bash -n` parse, YAML structural assertion, `verify`-job-untouched diff check, and README content check passed cleanly.

## Verification Performed (Tasks 1-3, pre-checkpoint)

- `bun -e 'Bun.YAML.parse(...)'` → YAML OK
- `grep -nE '\$\{\{[[:space:]]*\}\}' .github/workflows/ci.yml` → no match (no empty-expression trap)
- `verify` job steps confirmed byte-identical to pre-plan HEAD (`6bb3827~1`) — ruleset `require-ci-on-master` safe
- Exactly one `docker/build-push-action` step in the workflow (chain of guarantee preserved)
- All 4 new `docker-image` steps + 2 new `deploy` steps: no `${{` inside any `run:` body, every body opens with `set -euo pipefail`, every body parses under `bash -n`, no `curl -sS` (host-leak guard)
- `bun test` → 119 pass / 0 fail
- `bunx tsc --noEmit` → exit 0
- README: 7-step ordered checklist present, rollback section present, `## Deploy pipeline` precedes `## Whisper model volume`, no credential-looking token prefixes (`gsk_`, `csk-`, `AKIA`)

**No local docker was run at any point** — the docker daemon is off on this host and it is arm64 vs. the linux/amd64-pinned Dockerfile, per execution constraints. Every docker-level and network-level claim in Task 4 can only be verified by reading a real Actions run.

## User Setup Required — MANUAL OPERATOR STEPS (in order)

**These must happen in this order.** Steps 1-2 come from the plan's `user_setup` block; steps are cross-referenced against README.md `## Deploy pipeline` §"One-time operator setup".

1. **Push `master`** with this workflow in place (first push creates the GHCR package). The two deploy secrets (`EASYPANEL_DEPLOY_WEBHOOK`, `PUBLIC_BASE_URL`) are expected to be **absent** at this point — `verify` and `docker-image` must go green, and `deploy` must be **green, not skipped-red**, printing a `::notice::` naming `EASYPANEL_DEPLOY_WEBHOOK` as missing.
2. **Make the GHCR package public** — `github.com/betancourtfit?tab=packages` → `ai-api` → *Package settings* → *Danger Zone* → *Change visibility* → **Public**. **Do this before switching EasyPanel to deploy-image** — otherwise EasyPanel's first anonymous pull 401s.
3. **EasyPanel → the service → Source**: switch from **build from git** to **Docker image**, set `ghcr.io/betancourtfit/ai-api:latest`, leave registry credentials empty.
4. **DELETE the `BUILD_VERSION` environment variable in EasyPanel** (currently `v1`). This is the single most important and easiest-to-miss step: a runtime env var *overrides* the image's baked `ENV BUILD_VERSION`, so leaving it set means `/health` keeps answering `ok v1` forever and the post-deploy SHA-convergence smoke **can never converge**, no matter how correct everything else is.
5. Keep the persistent volume mounted at `/models` (unchanged from quick task 260724-mv1) and leave `WHISPER_MODEL_*` unset.
6. **EasyPanel → the service → deployment webhook**: copy the URL. GitHub → repo *Settings* → *Secrets and variables* → *Actions* → *New repository secret* → `EASYPANEL_DEPLOY_WEBHOOK`.
7. **Add secret `PUBLIC_BASE_URL`** — the public origin of the API, no trailing slash.
8. **Push again to `master`** with both secrets set. Watch the `deploy` job: `Trigger EasyPanel deploy` should print `Deploy webhook accepted (HTTP 2xx)`; `Smoke - post-deploy` should reach `match 3/3` and print `/ready` with `"ready":true`. Independently confirm with `curl -s https://<your-host>/health` returning `ok <the-sha-you-just-pushed>`.

Full detail, including exact log lines to paste back and failure-mode diagnosis, is in the plan's Task 4 `<how-to-verify>` (Stages A/B/C) — see `.planning/quick/260724-ukq-ghcr-publish-easypanel-deploy-webhook-sm/260724-ukq-PLAN.md`.

## Next Phase Readiness

Not ready to close — Task 4 (checkpoint:human-verify, gate="blocking") is outstanding. The orchestrator/user owns:
- Pushing `master` (Stage A) and pasting back the requested log lines
- Completing the 8-step manual setup above (Stage B)
- Pushing again and confirming production converges to the new SHA (Stage C)

Once Task 4's resume-signal ("approved" with pasted log lines, or a failure report) is received, this plan can be closed out and STATE.md/ROADMAP.md updated.

---
*Quick task: 260724-ukq*
*Tasks 1-3 completed: 2026-07-24*
*Task 4: blocked on operator action — not yet started*

## Self-Check: PASSED

- FOUND: `.github/workflows/ci.yml`
- FOUND: `README.md`
- FOUND: `.planning/quick/260724-ukq-ghcr-publish-easypanel-deploy-webhook-sm/260724-ukq-SUMMARY.md`
- FOUND commit `6bb3827` (Task 1)
- FOUND commit `696e60a` (Task 2)
- FOUND commit `b34168f` (Task 3)
- `bun test` → 119 pass / 0 fail (re-confirmed after Task 3 commit)
- `bunx tsc --noEmit` → exit 0 (re-confirmed after Task 3 commit)
