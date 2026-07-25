---
phase: quick-260724-ukq
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/ci.yml
  - README.md
autonomous: false
requirements: [QUICK-260724-ukq]
user_setup:
  - service: github-packages
    why: "The GHCR package is created private on first push; EasyPanel pulls it anonymously, so it must be flipped to public"
    dashboard_config:
      - task: "Change package visibility to Public"
        location: "github.com/betancourtfit?tab=packages -> ai-api -> Package settings -> Danger Zone -> Change visibility"
  - service: easypanel
    why: "Switch the service from build-from-git to deploy-image, and stop overriding the build stamp"
    dashboard_config:
      - task: "Change source to Docker image ghcr.io/betancourtfit/ai-api:latest (no registry credentials)"
        location: "EasyPanel -> service -> Source"
      - task: "DELETE the BUILD_VERSION environment variable (currently 'v1') — a runtime env var overrides the image's baked SHA and the post-deploy smoke can never converge"
        location: "EasyPanel -> service -> Environment"
      - task: "Copy the service Deploy webhook URL"
        location: "EasyPanel -> service -> Deployment / Webhooks"
  - service: github-actions-secrets
    why: "CI triggers the deploy and smokes production; both steps skip cleanly until these exist"
    env_vars:
      - name: EASYPANEL_DEPLOY_WEBHOOK
        source: "EasyPanel -> service -> Deployment webhook URL"
      - name: PUBLIC_BASE_URL
        source: "The public origin of the API, no trailing slash (e.g. https://api.example.com)"

must_haves:
  truths:
    - "A push to master publishes ghcr.io/betancourtfit/ai-api:<sha> and :latest, and the bits pushed are the exact image the container smokes ran against"
    - "Nothing reaches GHCR unless every existing smoke step passed first"
    - "The published image contains no env file outside .env.example / .env.test"
    - "The verify job no longer carries packages: write; only the publishing job does"
    - "With EASYPANEL_DEPLOY_WEBHOOK and/or PUBLIC_BASE_URL absent, the run stays green and prints an explicit skip notice naming the missing secret"
    - "With both secrets present, CI calls the EasyPanel webhook and then polls production until /health returns 'ok <github.sha>' on 3 consecutive reads inside a bounded budget, then asserts /ready is 200 with ready:true"
    - "A poll that never converges fails with a message naming the two likely causes (EasyPanel still building from git; a BUILD_VERSION env var overriding the baked value)"
    - "No secret value, webhook URL or production hostname is ever echoed into the public CI log"
    - "README carries an ordered operator runbook and the rollback procedure"
  artifacts:
    - path: ".github/workflows/ci.yml"
      provides: "per-job permissions, GHCR publish of the smoked image, deploy job with webhook trigger + post-deploy smoke"
      contains: "ghcr.io/betancourtfit/ai-api"
    - path: "README.md"
      provides: "Deploy pipeline operator runbook + rollback"
      contains: "ghcr.io/betancourtfit/ai-api:latest"
  key_links:
    - from: ".github/workflows/ci.yml step 'Build production image'"
      to: ".github/workflows/ci.yml step 'Publish image to GHCR'"
      via: "the single local tag bun-ai-api:ci — one build, no rebuild"
      pattern: "bun-ai-api:ci"
    - from: "deploy job"
      to: "docker-image job"
      via: "needs: docker-image — the image is on GHCR before the webhook fires"
      pattern: "needs:\\s*docker-image"
    - from: "post-deploy smoke"
      to: "GITHUB_SHA"
      via: "the /health build stamp, baked by CACHEBUST -> ARG CACHEBUST -> ENV BUILD_VERSION"
      pattern: "ok \\$\\{GITHUB_SHA\\}"
---

<objective>
Close the last gap in the deploy chain: publish the container image CI already builds and smokes to
GHCR tagged by commit SHA, trigger the EasyPanel deploy from CI by webhook, and prove with a
post-deploy smoke that production converged to **this** commit.

Purpose: production currently answers `ok v1` on `/health` — a hand-typed static value that cannot
tell one build from another, because EasyPanel builds from git without passing `CACHEBUST`. CI
already bakes the commit SHA into the image and already asserts `/health == ok <sha>` against a real
container. Publishing that exact image is what finally lets production answer *which* build is live,
and the SHA assertion is the only check that can prove a deploy converged rather than silently
serving a stale container.

Output: `.github/workflows/ci.yml` gains per-job permissions, a pre-publish env-file leak gate, a
GHCR publish of the already-smoked image, and a new `deploy` job (webhook + bounded convergence
smoke) that skips cleanly while the operator's manual setup is still incomplete. `README.md` gains
the operator runbook and the rollback procedure.

Traceability: `F-NN` below refers to the numbered verified facts in the planning brief
(F-02 per-job permissions, F-04 skip-on-missing-secret, F-05 build traceability, F-07 smoke failure
modes, F-08 tags/registry name, F-09 the `${{ }}`-in-comment trap, F-11 public-log secrecy).
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.github/workflows/ci.yml
@Dockerfile
@README.md
@adapters/inbound/http/routes/health.ts
</context>

<constraints_for_every_task>
These are load-bearing and apply to all workflow edits in this plan. Violating any of them has
already cost this repo a failed run.

1. **Never write a GitHub expression inside a `run:` body.** Not in a command, not in a shell
   comment. GitHub interpolates `${{ ... }}` anywhere inside a `run:` string, including lines bash
   would treat as comments, and an expression with an empty body is a syntax error that rejects the
   *entire workflow file* before any job starts (F-09; run `30134707079`). Every value a `run:` body
   needs arrives through a step-level or job-level `env:` mapping and is read as a plain shell
   variable. `with:` fields (`build-args`, `tags`) may use expressions — they are not `run:` bodies.
2. **Do not rename the `verify` job or touch any of its steps' names or bodies.** Repository ruleset
   `require-ci-on-master` (id 19711116) resolves against the `verify` check name. The only permitted
   change to `verify` is adding its own `permissions:` block.
3. **Never echo a secret value, the webhook URL, or the production hostname.** The repo is public and
   these logs are world-readable (F-11). Use `curl -s` with stderr suppressed — `-S` prints
   resolver/connect errors that can contain the host, and GitHub only masks exact-string matches.
4. **No local docker.** The docker daemon is off and this machine is arm64 while the image is pinned
   to linux/amd64 (F-10). Every docker-level assertion in this plan is verified by reading a real CI
   run in Task 4, not locally.
5. Each new `run:` body opens with `set -euo pipefail`, matching the house style already in the file.
</constraints_for_every_task>

<tasks>

<task type="auto">
  <name>Task 1: Per-job permissions, pre-publish leak gate, and GHCR publish of the exact smoked image</name>
  <files>.github/workflows/ci.yml</files>
  <action>
Edit `.github/workflows/ci.yml` only. Four changes, all inside the `docker-image` job except the
permissions move.

**1a. Move `permissions` from workflow level to job level (F-02).** Delete the top-level
`permissions:` block (lines 8-9, `contents: read`). Add `permissions:` with `contents: read` to the
`verify` job, and `permissions:` with `contents: read` plus `packages: write` to the `docker-image`
job. Comment the `docker-image` block explaining that `packages: write` is scoped to the only job
that pushes to GHCR, so `verify` — the required check — never inherits registry write access, and
that the repo's `default_workflow_permissions` is `read` so the grant must be explicit. Adding a
`permissions:` key to `verify` is the sole edit permitted to that job (constraint 2).

**1b. Publish from the same build, never a second one.** Do **not** add a second
`docker/build-push-action` step and do **not** set `push: true` on the existing one. The existing
step uses `load: true` precisely so the smokes can `docker run` the image; a second build with
`push: true` would ship bits that no smoke ever executed, breaking the chain of guarantee. Instead
publish by re-tagging and pushing the local `bun-ai-api:ci` image after every smoke has passed. The
existing build step already carries `platforms: linux/amd64`, `build-args: CACHEBUST=${{ github.sha }}`
and the GHA cache — the publish inherits all of it because it is literally the same image object.

**1c. New step `Record the smoked image id`**, inserted immediately after `Build production image`.
Body: `set -euo pipefail`; read `docker image inspect bun-ai-api:ci --format '{{.Id}}'` into a
variable (no leading `$` on the braces — Go template syntax, not a GitHub expression); assert it
matches `^sha256:[0-9a-f]{64}$` and fail with `::error::` if not (anti-vacuous: an unparseable id
must never pass silently); append it to `$GITHUB_ENV` as `SMOKED_IMAGE_ID`. This is the invariant the
publish step later re-checks.

**1d. New step `Verify the image ships no unexpected env file`**, inserted immediately after the
existing `Verify the image ships no whisper model` step. This is the gate that makes going *public*
safe (F-08: the GHCR package will be world-readable). Body: `set -euo pipefail`; run
`docker run --rm --entrypoint sh bun-ai-api:ci -c 'find /app -maxdepth 2 -name ".env*" -type f 2>/dev/null'`
into a variable with `|| true`; iterate the results and fail with `::error::` on any path other than
`/app/.env.example` or `/app/.env.test`, printing only the offending *path* (never contents). Then
an anti-vacuous companion: assert `find /app -maxdepth 1 -name "package.json" -type f` returns
exactly one hit, so a broken `find` invocation cannot read as "no env files found" — mirror the
probe already used by the whisper-model gate. Comment the reasoning: on CI the build context is a
clean `actions/checkout` of a public repo, so a public image exposes nothing that is not already
public on GitHub; `.dockerignore` excludes `.env` and `.env.local` by exact name only, so this gate
is the tripwire for a future `.env.production`-style file; and the credential-prefix scan over the
two allowlisted files is not duplicated here because `needs: verify` already ran it against the
byte-identical tracked files at this same commit.

**1e. New step `Log in to GHCR`**, inserted after `Smoke - warm boot and degraded boot` and before
`Smoke - container logs on failure`. Use a plain `run:` with `docker login`, not a third-party
action — no new supply-chain dependency for three lines. Give the step an `env:` mapping
`GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}` (a mapping value, not a `run:` body — permitted). Body:
`set -euo pipefail`; `printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin`.
No PAT: the package will be public and the push is made by the repo's own token (F-03).

**1f. New step `Publish image to GHCR`**, immediately after the login step. Add a job-level `env:`
key on `docker-image` with `IMAGE: ghcr.io/betancourtfit/ai-api` (a static string, so no expression
reaches a `run:` body). Body: `set -euo pipefail`; re-assert
`docker image inspect bun-ai-api:ci --format '{{.Id}}'` still equals `$SMOKED_IMAGE_ID` and fail with
`::error::` naming the invariant if not — that is the machine-checked proof that what is being
published is the object the smokes ran, not a rebuild; then `docker tag bun-ai-api:ci "$IMAGE:$GITHUB_SHA"`,
`docker tag bun-ai-api:ci "$IMAGE:latest"`, `docker push "$IMAGE:$GITHUB_SHA"`, `docker push "$IMAGE:latest"`;
then print the pushed repo digest via
`docker image inspect "$IMAGE:$GITHUB_SHA" --format '{{index .RepoDigests 0}}'` (safe to log — the
package is public) preceded by a line stating this digest is the rollback handle; finally
`docker logout ghcr.io >/dev/null 2>&1 || true`. `$GITHUB_SHA` and `$GITHUB_ACTOR` are plain runner
environment variables (constraint 1). Both tags are pushed unconditionally because the job is already
gated by `if: github.event_name == 'push'` and this workflow only triggers `push` on `master` — note
that in a comment so the `:latest` semantics are not accidental. Do not touch the two existing
cleanup steps.
  </action>
  <verify>
    <automated>bun -e 'const y=Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()); if(y.permissions) throw new Error("workflow-level permissions block still present"); const j=y.jobs; const v=j.verify.permissions||{}; if(v.contents!=="read"||v.packages) throw new Error("verify permissions wrong: "+JSON.stringify(v)); const d=j["docker-image"].permissions||{}; if(d.contents!=="read"||d.packages!=="write") throw new Error("docker-image permissions wrong: "+JSON.stringify(d)); const st=j["docker-image"].steps; const names=st.map(s=>s.name??s.uses); for(const n of ["Record the smoked image id","Verify the image ships no unexpected env file","Log in to GHCR","Publish image to GHCR"]) if(!names.includes(n)) throw new Error("missing step: "+n); const i=(n)=>names.indexOf(n); if(!(i("Build production image")<i("Record the smoked image id"))) throw new Error("record must follow the build"); for(const s of ["Smoke - run the real container","Smoke - warm boot and degraded boot","Verify the image ships no unexpected env file"]) if(!(i(s)<i("Publish image to GHCR"))) throw new Error("publish must come after: "+s); if(st.filter(s=>String(s.uses??"").startsWith("docker/build-push-action")).length!==1) throw new Error("there must be exactly one build step - a second build breaks the smoked-image guarantee"); if(!JSON.stringify(j["docker-image"].env||{}).includes("ghcr.io/betancourtfit/ai-api")) throw new Error("IMAGE job env missing"); console.log("OK structure")' && bun -e 'const y=Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()); const want=new Set(["Record the smoked image id","Verify the image ships no unexpected env file","Log in to GHCR","Publish image to GHCR"]); let n=0; for(const j of Object.values(y.jobs)) for(const s of j.steps??[]) { if(!s.run||!want.has(s.name)) continue; if(s.run.includes("${{")) throw new Error("GitHub expression inside a run body: "+s.name); const r=Bun.spawnSync({cmd:["bash","-n"],stdin:Buffer.from(s.run)}); if(r.exitCode!==0) throw new Error("bash -n failed for "+s.name+": "+r.stderr.toString()); n++; } if(n!==4) throw new Error("expected 4 new run blocks, found "+n); console.log("OK bash -n on "+n+" new run blocks")' && grep -nE '\$\{\{[[:space:]]*\}\}' .github/workflows/ci.yml && exit 1 || true && bun -e 'const p=(t)=>Bun.YAML.parse(t).jobs.verify.steps.map(s=>JSON.stringify({n:s.name??null,u:s.uses??null,r:s.run??null,w:s.with??null})).join("\n"); const h=Bun.spawnSync({cmd:["git","show","HEAD:.github/workflows/ci.yml"]}); const a=p(h.stdout.toString()); const b=p(await Bun.file(".github/workflows/ci.yml").text()); if(a!==b) throw new Error("the verify job steps changed - ruleset require-ci-on-master resolves against this job"); console.log("OK verify job untouched")' && bun test && echo "ALL OK"</automated>
  </verify>
  <done>Workflow-level `permissions` is gone; `verify` has `contents: read` only; `docker-image` has `contents: read` + `packages: write`; exactly one build step exists; the four new steps are present in the required order, contain no GitHub expression, and each parses under `bash -n`; the `verify` job's steps are byte-identical to HEAD; no empty expression exists anywhere in the file; `bun test` still 119/119.</done>
</task>

<task type="auto">
  <name>Task 2: deploy job — EasyPanel webhook trigger + bounded post-deploy convergence smoke</name>
  <files>.github/workflows/ci.yml</files>
  <action>
Append a third job, `deploy`, to `.github/workflows/ci.yml`. Header: `needs: docker-image`,
`if: github.event_name == 'push'` (F-11 — a fork PR must never reach the deploy path; belt and
braces, since a skipped `needs` already skips dependents), `runs-on: ubuntu-latest`, and
`permissions:` with `contents: read` only — no `packages` scope, that is the whole point of the
per-job split in Task 1. The job runs no `actions/checkout`: it needs only `curl` and `jq`, both
preinstalled on `ubuntu-latest`. Comment that `needs: docker-image` is load-bearing — the webhook
must not fire until `:latest` on GHCR actually points at this commit.

Job-level `env:` maps the two secrets: `EASYPANEL_DEPLOY_WEBHOOK: ${{ secrets.EASYPANEL_DEPLOY_WEBHOOK }}`
and `PUBLIC_BASE_URL: ${{ secrets.PUBLIC_BASE_URL }}`. Comment why this indirection exists: the
`secrets` context is **not** available in any `if:` condition (verified against GitHub's context
availability table — job-level `if` sees only `github`/`needs`/`vars`/`inputs`, step-level `if` adds
`env`/`steps` but never `secrets`), so a missing secret cannot be gated with `if: secrets.X != ''`.
The skip is implemented in-shell instead, which also keeps the guard readable.

**Step 1 — `Trigger EasyPanel deploy`**, `id: deploy`, `timeout-minutes: 2`. Body:
`set -euo pipefail`; if `${EASYPANEL_DEPLOY_WEBHOOK:-}` is empty, emit
`::notice::EASYPANEL_DEPLOY_WEBHOOK is not set - skipping deploy and post-deploy smoke. Add the secret in Settings -> Secrets and variables -> Actions (see README 'Deploy pipeline').`,
write `deployed=false` to `$GITHUB_OUTPUT` and `exit 0` — a clean skip, never a failure (F-04: the
operator is creating these secrets in parallel and the workflow must not go red meanwhile). Otherwise
`code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$EASYPANEL_DEPLOY_WEBHOOK" || echo 000)"`.
`-s` without `-S` is deliberate (constraint 3): curl's error text can contain the host and GitHub
only masks exact-string matches. Accept `2xx` (test `$code` against `^2[0-9][0-9]$`); on anything
else emit `::error::EasyPanel deploy webhook returned HTTP <code> (URL deliberately not printed)` and
`exit 1`. On success print `Deploy webhook accepted (HTTP <code>)`, write `deployed=true` to
`$GITHUB_OUTPUT`.

**Step 2 — `Smoke - post-deploy`**, `if: steps.deploy.outputs.deployed == 'true'` (the `steps`
context *is* available in a step-level `if`, unlike `secrets`), `timeout-minutes: 15`, with a
step-level `env:` block of static strings — `HEALTH_BUDGET_SECONDS: "720"`,
`HEALTH_CONSECUTIVE: "3"`, `WHISPER_BUDGET_SECONDS: "180"` — so every budget is tunable in one place
and no literal appears twice. Body, `set -euo pipefail`:

- If `${PUBLIC_BASE_URL:-}` is empty, emit `::notice::PUBLIC_BASE_URL is not set - the deploy was triggered but production was not verified. Add the secret to enable the post-deploy smoke.` and `exit 0` (F-04 again: the two secrets can land independently).
- Normalise: `base="${PUBLIC_BASE_URL%/}"` to tolerate a trailing slash, then `echo "::add-mask::$base"` immediately — stripping the slash produces a string GitHub has not registered as a secret, so it must be masked explicitly before it can reach any log line.
- Poll `/health` for convergence. `expected="ok ${GITHUB_SHA}"`. Loop until `$(date +%s)` passes a deadline computed from `HEALTH_BUDGET_SECONDS`, sleeping 5s per iteration. Each iteration: `body="$(curl -s -m 10 "$base/health" 2>/dev/null || true)"`. If `$body` equals `$expected`, increment a `consecutive` counter, print `match <consecutive>/<HEALTH_CONSECUTIVE>`, and break out with success once it reaches `HEALTH_CONSECUTIVE`. Otherwise, if `consecutive` was already above zero, emit a `::warning::` that the reading reverted (`rollout still converging`) and reset `consecutive` to 0. Keep the last observed body in a variable. **Requiring N consecutive matches is the fix for the rollout race (F-07): EasyPanel can replace the container in place, and for a window the *old* container still answers 200 — a poll that accepts the first good read can pass against a container that is about to die.** Comment that explicitly.
- On budget exhaustion: emit `::error::/health never returned the expected build stamp for <N> consecutive reads within <budget>s (last body: '<last>')` and then a diagnostic branch before `exit 1` — if the last body is non-empty and starts with `ok ` but the remainder is not a 40-character hex string, add `::error::production reported build stamp '<remainder>' - EasyPanel still has a BUILD_VERSION environment variable set, which overrides the value baked into the image; delete it (see README 'Deploy pipeline')`; if the last body is empty, add `::error::no response from /health - the service may still be pulling the image, or EasyPanel is still building from git instead of deploying ghcr.io/betancourtfit/ai-api:latest`. These two are the exact failure modes the operator will actually hit, so the log must name them rather than leaving a bare timeout.
- Then `/ready` (F-07: `/health` returns `ok <version>` unconditionally and never touches whisper or the providers, so a `/health`-only smoke is a structural false green). `code="$(curl -s -o "$RUNNER_TEMP/ready.json" -w '%{http_code}' -m 15 "$base/ready" || echo 000)"`; require `200` and `jq -e '.ready == true'`, failing with `::error::` and the response body otherwise. `cat` the body — it carries provider names and booleans, no secrets. Print `.mode` and `.eligibleProviders` for the record but do **not** gate on them: `mode: "degraded"` is a legitimate documented state (CLAUDE.md §20) and must not fail a deploy.
- Then whisper, as a warning-only budget (F-07): if `.whisperAvailable` is not `true`, re-poll `/ready` every 10s up to `WHISPER_BUDGET_SECONDS`; if it flips to `true`, print how long it took; if it never does, emit `::warning::/ready reports whisperAvailable=false after <budget>s - expected only when the /models volume is empty and the 466 MB model is still downloading; transcriptions 503 until it lands, chat proxying is unaffected` and continue. Never fail on this — production's volume is already populated, so this should be a cache hit, and a slow model download is not a bad deploy.
- Close with a success line naming the verified SHA (`GITHUB_SHA` is public, safe to print).
  </action>
  <verify>
    <automated>bun -e 'const y=Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()); const d=y.jobs.deploy; if(!d) throw new Error("deploy job missing"); if(d.needs!=="docker-image"&&!(Array.isArray(d.needs)&&d.needs.includes("docker-image"))) throw new Error("deploy must need docker-image"); if(!String(d.if).includes("github.event_name == 'push'")) throw new Error("deploy not gated on push: "+d.if); const p=d.permissions||{}; if(p.packages) throw new Error("deploy must not have packages permission"); const e=d.env||{}; if(!String(e.EASYPANEL_DEPLOY_WEBHOOK||"").includes("secrets.EASYPANEL_DEPLOY_WEBHOOK")) throw new Error("EASYPANEL_DEPLOY_WEBHOOK not mapped from secrets at job level"); if(!String(e.PUBLIC_BASE_URL||"").includes("secrets.PUBLIC_BASE_URL")) throw new Error("PUBLIC_BASE_URL not mapped from secrets at job level"); const names=d.steps.map(s=>s.name); for(const n of ["Trigger EasyPanel deploy","Smoke - post-deploy"]) if(!names.includes(n)) throw new Error("missing step: "+n); const trig=d.steps.find(s=>s.name==="Trigger EasyPanel deploy"); if(trig.id!=="deploy") throw new Error("trigger step needs id: deploy"); const sm=d.steps.find(s=>s.name==="Smoke - post-deploy"); if(!String(sm.if).includes("steps.deploy.outputs.deployed")) throw new Error("smoke must gate on the deploy step output, not on the secrets context"); if(!sm["timeout-minutes"]) throw new Error("post-deploy smoke needs a timeout-minutes bound"); let n=0; for(const s of d.steps){ if(!s.run) continue; if(s.run.includes("${{")) throw new Error("GitHub expression inside a run body: "+s.name); if(!s.run.includes("set -euo pipefail")) throw new Error("missing set -euo pipefail: "+s.name); const r=Bun.spawnSync({cmd:["bash","-n"],stdin:Buffer.from(s.run)}); if(r.exitCode!==0) throw new Error("bash -n failed for "+s.name+": "+r.stderr.toString()); if(/curl[^\n]*-sS/.test(s.run)) throw new Error("curl -sS can leak the host into a public log: "+s.name); n++; } if(n!==2) throw new Error("expected 2 run blocks in deploy, found "+n); const all=await Bun.file(".github/workflows/ci.yml").text(); if(!all.includes("add-mask")) throw new Error("derived base URL is never re-masked"); console.log("OK deploy job")' && grep -nE '\$\{\{[[:space:]]*\}\}' .github/workflows/ci.yml && exit 1 || true && bun -e 'const p=(t)=>Bun.YAML.parse(t).jobs.verify.steps.map(s=>JSON.stringify({n:s.name??null,u:s.uses??null,r:s.run??null,w:s.with??null})).join("\n"); const h=Bun.spawnSync({cmd:["git","show","HEAD:.github/workflows/ci.yml"]}); const a=p(h.stdout.toString()); const b=p(await Bun.file(".github/workflows/ci.yml").text()); if(a!==b) throw new Error("the verify job steps changed"); console.log("OK verify job untouched")' && bun test && echo "ALL OK"</automated>
  </verify>
  <done>A `deploy` job exists with `needs: docker-image`, `if: github.event_name == 'push'`, no `packages` permission, both secrets mapped at job level, a `Trigger EasyPanel deploy` step with `id: deploy`, and a `Smoke - post-deploy` step gated on `steps.deploy.outputs.deployed` with a `timeout-minutes` bound; both run bodies parse under `bash -n`, contain no GitHub expression, open with `set -euo pipefail`, and use no `curl -sS`; the derived base URL is re-masked; the `verify` job is still untouched; `bun test` still 119/119.</done>
</task>

<task type="auto">
  <name>Task 3: README operator runbook and rollback procedure</name>
  <files>README.md</files>
  <action>
Add a `## Deploy pipeline (GHCR → EasyPanel)` section to `README.md`, placed after the intro block
and before `## Whisper model volume`. No app or workflow changes in this task.

Content, in this order:

**What CI does on every push to `master`.** `verify` (install, typecheck, test, env guards) →
`docker-image` (build with the commit SHA as `CACHEBUST`, audit the image, boot it three ways and
smoke it, then publish the *same* image object to `ghcr.io/betancourtfit/ai-api:<sha>` and `:latest`)
→ `deploy` (call the EasyPanel webhook, then poll production until `/health` reports the pushed SHA).
State plainly that only the image that passed every smoke is ever published — there is exactly one
build step in the job and the publish re-checks the image id.

**One-time operator setup**, as a numbered checklist. It must be numbered because the order matters:

1. Push to `master` once with this workflow in place. The `docker-image` job creates the package —
   **GitHub publishes a new package as private by default.**
2. Make the package public: `github.com/betancourtfit?tab=packages` → `ai-api` → *Package settings* →
   *Danger Zone* → *Change visibility* → **Public**. Also link it to this repository if GitHub has
   not already. Public visibility is what lets EasyPanel pull anonymously — there is deliberately no
   PAT and no registry credential anywhere in this setup.
3. EasyPanel → the service → *Source*: switch from **build from git** to **Docker image**, set
   `ghcr.io/betancourtfit/ai-api:latest`, leave registry credentials empty.
4. EasyPanel → the service → *Environment*: **delete the `BUILD_VERSION` variable** (it currently
   reads `v1`). Give this its own emphasised line — a runtime environment variable *overrides* the
   `ENV BUILD_VERSION` the image bakes from `CACHEBUST`, so leaving it set makes `/health` keep
   answering `ok v1` and the post-deploy smoke can never converge, no matter how correct the deploy is.
5. Keep the persistent volume mounted at `/models` (cross-reference the *Whisper model volume*
   section) and leave `WHISPER_MODEL_*` unset.
6. EasyPanel → the service → deployment webhook: copy the URL. GitHub → repo *Settings* → *Secrets
   and variables* → *Actions* → *New repository secret* → `EASYPANEL_DEPLOY_WEBHOOK`. Note that
   anyone holding this URL can trigger a deploy; rotate it in EasyPanel if it is ever exposed.
7. Add a second secret `PUBLIC_BASE_URL` — the public origin of the API, **no trailing slash**.

Then a short paragraph: until steps 6 and 7 are done, the `deploy` job runs, prints a `::notice::`
naming the missing secret, and exits successfully. CI stays green throughout the manual setup; a red
`deploy` job means a real deploy problem, never an incomplete configuration.

**Checking which build is live.** `curl -s https://<your-host>/health` returns `ok <commit-sha>`.
Compare it against the latest commit on `master`. Add one sentence explaining why this exists at all:
before the GHCR switch, EasyPanel built from git without passing `CACHEBUST`, so `/health` returned a
hand-typed static string that could not distinguish one build from another.

**Rolling back.** Point the EasyPanel service image at `ghcr.io/betancourtfit/ai-api:<older-sha>`
and redeploy; every commit that ever reached `master` has an immutable tag. Two caveats, both
explicit: `:latest` still points at the newest build, so a rollback that pins a SHA must be un-pinned
later; and **only the image is versioned — EasyPanel environment variables and service configuration
are not in git**, so a rollback does not restore configuration changes made since that build.

**Manual publish** (escape hatch, one line): the SHA tag is the rollback handle, and the digest of
every published image is printed by the `Publish image to GHCR` step in the corresponding run.
  </action>
  <verify>
    <automated>bun -e 'const r=await Bun.file("README.md").text(); const need=[["## Deploy pipeline","section heading"],["ghcr.io/betancourtfit/ai-api:latest","the :latest tag EasyPanel pulls"],["BUILD_VERSION","the EasyPanel env var that must be deleted"],["EASYPANEL_DEPLOY_WEBHOOK","the webhook secret name"],["PUBLIC_BASE_URL","the base URL secret name"],["Public","package visibility step"],["/models","the volume cross-reference"],["/health","the build-stamp check"]]; const missing=need.filter(([s])=>!r.includes(s)); if(missing.length) throw new Error("README missing: "+missing.map(m=>m[1]+" ("+m[0]+")").join(", ")); const sec=r.slice(r.indexOf("## Deploy pipeline")); if(!/1\./.test(sec)||!/7\./.test(sec)) throw new Error("the operator setup checklist is not a 7-step ordered list"); if(!/roll ?back|Rolling back/i.test(sec)) throw new Error("no rollback section"); if(sec.indexOf("## Whisper model volume")<0 && r.indexOf("## Deploy pipeline")>r.indexOf("## Whisper model volume")) throw new Error("Deploy pipeline section must precede Whisper model volume"); console.log("OK README")' && bun -e 'const r=await Bun.file("README.md").text(); for(const bad of ["gsk_","csk-","AKIA"]) if(r.includes(bad)) throw new Error("credential-looking token in README: "+bad); console.log("OK no credential prefixes")'</automated>
  </verify>
  <done>`README.md` has a `## Deploy pipeline (GHCR → EasyPanel)` section before `## Whisper model volume`, containing a 7-step ordered operator checklist (package visibility → deploy-image source → delete `BUILD_VERSION` → keep `/models` → two secrets), the green-while-unconfigured note, the "which build is live" check, and a rollback procedure with both caveats.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Human verification — push, read the run, complete the EasyPanel/GHCR setup, push again</name>
  <what-built>
CI now publishes the exact container image it smokes to `ghcr.io/betancourtfit/ai-api` (tagged by
commit SHA and `latest`), calls the EasyPanel deploy webhook, and polls production until `/health`
reports this commit's SHA on three consecutive reads. `permissions` moved from workflow level to per
job so the required `verify` check no longer inherits registry write access, and a new gate asserts
the (now world-readable) image ships no env file outside `.env.example` / `.env.test`.

Nothing here could be executed locally: the docker daemon is off, this machine is arm64 while the
image is pinned to linux/amd64, and neither GHCR auth nor the EasyPanel webhook exists outside a real
run. Every docker-level and network-level claim above is verified by reading the run.
  </what-built>
  <how-to-verify>
**Stage A — push and read the run (no manual setup yet).**

1. Push `master`. The two new secrets are expected to be *absent* at this point.
2. Open the run. `verify` and `docker-image` must be green; `deploy` must be **green, not skipped**,
   with a `::notice::` naming `EASYPANEL_DEPLOY_WEBHOOK` as missing. That is the F-04 requirement:
   incomplete configuration must never paint the run red.
3. In `docker-image`, confirm these lines and paste them back:
   - `Verify the image ships no unexpected env file` — an OK line, no offending paths.
   - `Publish image to GHCR` — the image-id invariant OK line, both `docker push` results, and the
     printed repo digest.
4. Confirm the job order actually held: `Publish image to GHCR` ran *after*
   `Smoke - warm boot and degraded boot`.
5. Visit `github.com/betancourtfit?tab=packages` → `ai-api`. Confirm the package exists, is linked to
   the repo, and shows two tags: the commit SHA and `latest`. It will be **private** — expected.
6. Report the total `docker-image` wall time (baseline was 76s on run `30136186084`; the publish adds
   an upload of roughly 700 MiB uncompressed).

**Stage B — complete the manual setup.** Work through the 7-step checklist in the new README
section, in order. The two easy-to-miss steps: **delete the `BUILD_VERSION` env var in EasyPanel**
(otherwise `/health` keeps answering `ok v1` and the smoke can never converge), and make the GHCR
package **public** *before* switching EasyPanel to deploy-image (otherwise the first pull 401s).

**Stage C — push again, with both secrets set.**

7. Push any commit to `master`. Watch the `deploy` job.
8. Confirm `Trigger EasyPanel deploy` prints `Deploy webhook accepted (HTTP 2xx)` and that neither
   the webhook URL nor the production hostname appears anywhere in the log (they should render as
   `***` if they appear at all).
9. Confirm `Smoke - post-deploy` reaches `match 3/3` and prints the `/ready` body with
   `"ready":true`. Paste the `/ready` line.
10. Independently confirm production: `curl -s https://<your-host>/health` must return
    `ok <the-sha-you-just-pushed>`. This is the first time production can name its own build.
11. Note whether `whisperAvailable` was `true` immediately (expected — the `/models` volume is
    already populated) or whether the warning-only retry branch fired.

If Stage C fails on the poll, the error message itself names the likely cause — paste the whole
`Smoke - post-deploy` step output rather than only the failure line.
  </how-to-verify>
  <resume-signal>Type "approved" with the pasted log lines from steps 3, 9 and 10, or paste the failing step output.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CI runner → GHCR | `GITHUB_TOKEN` with `packages: write` gains registry write for the first time |
| GHCR package → public internet | The image becomes world-readable; anyone can pull and inspect every layer |
| CI log → public internet | This repo is public; every log line printed is world-readable |
| CI runner → EasyPanel webhook | An outbound call to a capability URL that triggers a production deploy |
| CI runner → production API | Unauthenticated reads of `/health` and `/ready` (both pre-auth routes) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-ukq-01 | Information disclosure | The public GHCR image | mitigate | On CI the build context is a clean `actions/checkout` of an already-public repo, so the image exposes nothing not already public. Task 1d adds an in-image gate failing on any `/app/.env*` outside `.env.example`/`.env.test`, with an anti-vacuous `find` probe. `.dockerignore` already excludes `.env`/`.env.local`. The credential-prefix scan over the two allowlisted files is not duplicated — `needs: verify` runs it against the byte-identical tracked files at the same commit |
| T-ukq-02 | Information disclosure | Public CI logs | mitigate | Never echo `EASYPANEL_DEPLOY_WEBHOOK` or `PUBLIC_BASE_URL`; `curl -s` without `-S` so resolver/connect errors carrying the host never reach the log; the slash-stripped base URL is re-registered with `::add-mask::` because GitHub masks exact strings only; the `/health` and `/ready` bodies carry no secrets and are safe to print |
| T-ukq-03 | Elevation of privilege | `verify` job token scope | mitigate | Workflow-level `permissions` deleted; `verify` declares `contents: read` only, so the required check never inherits `packages: write`. `deploy` declares `contents: read` and no `packages` scope |
| T-ukq-04 | Tampering | Fork PR reaching publish or deploy | mitigate | Both `docker-image` and `deploy` carry `if: github.event_name == 'push'`; the workflow only triggers `push` on `master`; a `pull_request` from a fork receives a read-only token regardless |
| T-ukq-05 | Spoofing | Publishing bits that were never smoked | mitigate | Exactly one `docker/build-push-action` step in the job (machine-asserted in Task 1's verify); no second build and no `push: true` on the build; publish is a `docker tag` + `docker push` of the same `bun-ai-api:ci` object, placed after every smoke, and re-asserts the image id recorded immediately after the build |
| T-ukq-06 | Denial of service | Unbounded post-deploy poll | mitigate | `HEALTH_BUDGET_SECONDS` deadline plus `timeout-minutes: 15` on the smoke step and `timeout-minutes: 2` on the webhook call; no unbounded loop anywhere |
| T-ukq-07 | Spoofing | Smoke passing against the outgoing container during an in-place rollout | mitigate | Three consecutive exact `ok <sha>` reads spaced 5s apart, plus a `::warning::` when a match reverts; asserting the SHA (not merely a 200) is what makes an old container distinguishable |
| T-ukq-08 | Repudiation | Production cannot name its own build | mitigate | This task's core purpose: the SHA tag on GHCR plus the `CACHEBUST` → `ENV BUILD_VERSION` → `/health` chain, asserted post-deploy. Operator step 4 (delete EasyPanel's `BUILD_VERSION`) is what keeps a runtime override from re-breaking it |
| T-ukq-09 | Tampering | Anyone holding the webhook URL can trigger a production deploy | accept | Capability URLs are EasyPanel's design; the URL lives only as a GitHub Actions secret, is never echoed, and rotation instructions are in the README. The deploy pulls `:latest` from a repo-controlled registry, so an unauthorised trigger redeploys the current build rather than injecting one |
| T-ukq-SC | Tampering | Supply chain | mitigate | No npm/pip/cargo install in this task, so the Package Legitimacy Gate does not apply. No new third-party Action either: GHCR login uses a plain `docker login --password-stdin` rather than adding `docker/login-action`. The two existing `docker/*` actions are unchanged |
</threat_model>

<verification>
After Task 3, before the checkpoint:

1. `bun -e 'Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()); console.log("YAML OK")'`
2. `grep -nE '\$\{\{[[:space:]]*\}\}' .github/workflows/ci.yml` returns no match (an expression with
   an empty body rejects the whole workflow file and is invisible to both `Bun.YAML.parse` and
   `bash -n` — F-09).
3. `git diff HEAD -- .github/workflows/ci.yml` shows **no change inside the `verify` job** other than
   the added `permissions:` block.
4. `bun test` → 119/119, `bunx tsc --noEmit` → exit 0. No TypeScript is touched by this plan, so a
   regression here means something unrelated broke.
5. No `docker` command is run locally at any point (F-10).
</verification>

<success_criteria>
- `.github/workflows/ci.yml` declares `permissions` per job; workflow-level `permissions` is gone;
  only `docker-image` carries `packages: write`.
- Exactly one image build exists in the workflow, and `ghcr.io/betancourtfit/ai-api:<sha>` plus
  `:latest` are pushed from that same image object, after every smoke, with the image id re-asserted.
- The image is gated against shipping any env file outside `.env.example` / `.env.test` before it is
  published.
- With either secret missing, the `deploy` job finishes green and prints a `::notice::` naming the
  missing secret.
- With both secrets present, CI calls the webhook and asserts `/health == ok <github.sha>` on three
  consecutive reads within a bounded budget, then `/ready` 200 with `ready:true`; `whisperAvailable`
  is warning-only.
- No secret value, webhook URL or production hostname is printed in the public log.
- `README.md` carries the 7-step operator runbook and the rollback procedure with both caveats.
- Verified on a real Actions run (Task 4), not inferred from a green tick.
</success_criteria>

<output>
Create `.planning/quick/260724-ukq-ghcr-publish-easypanel-deploy-webhook-sm/260724-ukq-SUMMARY.md` when done.
</output>
