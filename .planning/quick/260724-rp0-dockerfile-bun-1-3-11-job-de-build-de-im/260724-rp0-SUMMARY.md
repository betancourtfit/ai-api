---
phase: quick-260724-rp0
plan: 01
subsystem: infra
tags: [docker, bun, github-actions, ci, supply-chain, dependencies]

requires: [quick-260724-p04]
provides:
  - "Dockerfile builds both stages from oven/bun:1.3.11 — bun install --frozen-lockfile actually honors bun.lock"
  - "CI docker-image job: builds the production image on master and fails if its installed deps drift from bun.lock"

affects: [ci, deployment, dockerfile, dependencies]

tech-stack:
  added: []
  patterns:
    - "build-push-action with push:false + load:true so the built image reaches the runner's docker daemon and can be introspected"
    - "dependency audit compares `bun pm ls` from inside the image against verbatim name@version tokens in bun.lock — no versions hardcoded in the workflow"
    - "anti-vacuous guard on a CI assertion: fail if the parse yields too few tokens or the critical packages are absent"

key-files:
  created: []
  modified:
    - Dockerfile
    - CLAUDE.md
    - AGENTS.md
    - .github/workflows/ci.yml

key-decisions:
  - "Bump BOTH Dockerfile stages together — the builder stage exists on the same bun base so whisper-server links against the runtime's exact glibc/libstdc++; bumping one stage alone would break that invariant"
  - "docker-image runs only on push to master (not on PRs) and declares needs: verify, so a red test suite short-circuits the image build"
  - "docker-image is deliberately NOT a required status check — ruleset require-ci-on-master still requires only `verify`, which was left untouched"
  - "Verification happens on the amd64 GitHub runner, not locally: this dev machine is arm64 and the Dockerfile pins linux/amd64, so a local build would be QEMU-emulated for no added confidence"

requirements-completed: [QUICK-260724-rp0]

duration: ~20min
completed: 2026-07-24
---

# Quick Task 260724-rp0: Dockerfile Bun 1.3.11 + CI image build Summary

**STATUS: COMPLETE — all 3 tasks resolved, verified on a real amd64 CI run.**

**Killed a live supply-chain bug: the production image was installing dependency versions that no test ever validated, and `--frozen-lockfile` was exiting 0 while doing it. Both Dockerfile stages now build from `oven/bun:1.3.11`, and a new `docker-image` CI job builds the real image and fails if its installed versions drift from `bun.lock`.**

## The bug this fixed

The Dockerfile pinned `oven/bun:1.1.29` in both stages. This repo's `bun.lock` is the **text** format (`lockfileVersion: 1`, `configVersion: 1`), introduced in Bun v1.1.39 — so 1.1.29 predates it entirely.

Bun 1.1.29 does not fail on an unreadable lockfile. It **ignores it silently** and resolves from the `^` ranges in `package.json`, so `bun install --frozen-lockfile` exits 0 having installed a completely different dependency tree. Measured by running Bun 1.1.29 against this exact `package.json` + `bun.lock` in an isolated directory:

| Package | `bun.lock` pins | Bun 1.1.29 installed | Bun 1.3.11 installs |
|---|---|---|---|
| `@cerebras/cerebras_cloud_sdk` | 1.64.1 | **1.91.0** | 1.64.1 |
| `groq-sdk` | 1.2.1 | **1.4.0** | 1.2.1 |
| `@types/bun` | 1.3.5 | **1.3.14** | 1.3.5 |
| `typescript` | 5.9.3 | 5.9.3 | 5.9.3 |
| `zod` | 4.4.3 | 4.4.3 | 4.4.3 |

42 packages under 1.1.29 vs 44 under 1.3.11. `bun.lock` came out with an identical sha256 — 1.1.29 neither reads nor writes it.

Impact: the deployed image was running Cerebras SDK **1.91.0** against a test suite that validates 1.64.1, on the SDK that makes every upstream call. The CI gate added in `quick-260724-p04` did not cover this, because it tests a dependency tree the image never used.

## Accomplishments

- Both Dockerfile stages bumped to `oven/bun:1.3.11`, keeping the same-base invariant the file's own comments document (whisper-server must link against the runtime's glibc/libstdc++)
- New `docker-image` job builds the production image on the amd64 runner and audits it
- `CLAUDE.md` and `AGENTS.md` no longer assert the 1.1.29 pin — they load into every agent session, so stale lines there are what invite a future agent to revert the fix
- `bun test` still 119 pass / 0 fail; `bunx tsc --noEmit` still exit 0; the `verify` job is byte-for-byte unchanged in its steps

## Task Commits

1. **Task 1: Bump both Dockerfile stages and correct the docs asserting the old pin** — `c56d8ef` (fix)
2. **Task 2: Add the docker-image job with the bun.lock dependency audit** — `2e937cb` (feat)
3. **Task 3: Human verification — real CI image build** — RESOLVED, see below

## Task 3 resolution (verified, not assumed)

Run **`30132968460`** on `master`, commit `2e937cb`, conclusion **success**:

| Job | Result | Duration |
|---|---|---|
| `verify` | success | 14s |
| `docker-image` | success | **239s (4 min)** |

The first image build came in at 4 minutes, well under the 10-15 min budgeted for compiling whisper.cpp and pulling the 466 MB model.

The `Verify image deps match bun.lock` step output, read from the run log:

```
---- raw bun pm ls output ----
/app node_modules (46)
Parsed 5 dependency tokens from the image.
OK   @cerebras/cerebras_cloud_sdk@1.64.1
OK   @types/bun@1.3.5
OK   groq-sdk@1.2.1
OK   typescript@5.9.3
OK   zod@4.4.3
Success: all 5 image dependencies match bun.lock.
```

`1.64.1` and `1.2.1` inside the real image — the pinned versions, not the drifted `1.91.0` / `1.4.0`. The bug is fixed and a check now keeps it fixed.

`verify` was still reported under exactly that name, so ruleset `require-ci-on-master` (id 19711116) continues to point at a check that exists.

## How the audit works, and why it is not vacuous

`push: false` alone leaves the image inside the buildx cache where `docker run` cannot reach it, so the job uses `load: true` to land it in the runner's docker daemon. It then reads the *actually installed* top-level versions with `docker run --rm --entrypoint bun bun-ai-api:ci pm ls` (overriding the entrypoint keeps `start.sh` and the whisper sidecar from launching) and looks up each `name@version` token verbatim in `bun.lock` with `grep -qF`. The lockfile stores exactly those quoted tokens, so no JSONC parsing is needed and **no version is hardcoded in the workflow** — the check stays correct across future dependency bumps.

The audit fails loudly if it parses fewer than 5 tokens, or if `@cerebras/cerebras_cloud_sdk@` / `groq-sdk@` are absent from the listing. Without that guard, a change in `bun pm ls` output format would silently turn the audit into a no-op — which is the exact failure mode this task exists to eliminate.

## Deviations from Plan

The executor stopped at the blocking checkpoint without writing this SUMMARY, so the orchestrator wrote it after verifying the CI run. No code deviations.

## Known gaps (deliberate)

- **The audit's failing path never ran on a real runner.** Its logic was dry-run locally against synthetic `bun pm ls` output for both the matching and drifted cases, and both behaved correctly. Proving the red path for real would mean pushing a deliberately drifted image to master.
- **The audit covers the 5 direct dependencies, not the full 46-package tree.** Transitive drift would not be caught. That is the trade-off for a check that runs in seconds; `bun.lock` still pins the full tree, and Bun 1.3.11 now honors it.
- **Only the built image was verified, never a running container.** The job proves the dependency tree is correct; it does not start the proxy or exercise whisper-server. Post-deploy smoke against `/health` is the next step's job.

## Required Follow-ups

1. **GHCR + EasyPanel deploy webhook — the next step.** The image now builds and is audited in CI, but it is thrown away (`push: false`). Publishing it to GHCR tagged by SHA, having EasyPanel pull the image instead of building from git, and adding a post-deploy smoke against `/health` (which already returns `ok <sha>` via `BUILD_VERSION`) is what actually gets the whisper.cpp compile off the mini PC and makes rollback a retag instead of a 15-minute rebuild.
2. **GHA cache effectiveness — MEASURED, it works.** Run `30133260678` (the docs commit, `63fba76`) finished `docker-image` in **100s** against the 239s cold baseline: a 2.4x speedup, with the whisper.cpp compile and the 466 MB model download both served from cache. It does not drop to near-zero because `CACHEBUST=${{ github.sha }}` deliberately invalidates every layer below it on each commit, and `load: true` plus the `docker run` audit cost real seconds regardless. 100s per push to master is the steady-state cost of this job.
3. **`.planning/**` still contains 1.1.29 references** (including `.planning/codebase/*.md`). Left untouched on purpose as a historical record of what was true when those documents were written.
4. **The whisper model is still baked into the image** (~466 MB). Moving it to a volume would cut the image to roughly its base size and make pulls on the mini PC far cheaper. Unstarted.

## Next Phase Readiness

The deploy path is now trustworthy enough to automate: the image builds reproducibly on CI and its dependency tree is asserted against the lockfile on every push to master. Follow-up #1 (GHCR + webhook + smoke) is the natural next task and was already scoped in the CI/CD proposal as "escalón 2".

---
*Phase: quick-260724-rp0*
*Completed: 2026-07-24*
