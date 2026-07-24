---
phase: quick-260724-shs
plan: 01
type: execute
wave: 1
depends_on: [quick-260724-rp0]
files_modified:
  - .github/workflows/ci.yml
autonomous: false
requirements: [QUICK-260724-shs]

must_haves:
  truths:
    - "The CI docker-image job starts the production image with its real start.sh entrypoint and fails fast if the container exits during startup"
    - "GET /health on the running container returns exactly `ok <pushed commit SHA>`, proving the CACHEBUST -> ARG -> ENV BUILD_VERSION -> handleHealth chain reaches runtime"
    - "GET /ready returns 200 with ready=true and mode=ok"
    - "A real transcription of whisper-models/sample.wav through POST /v1/audio/transcriptions returns 200 with non-empty text — the only assertion that proves whisper-server survived start.sh's background '&'"
    - "A failed smoke prints the container logs; the container is removed whether the smoke passes or fails"
    - "The image's Bun version is asserted against an absolute >= 1.1.39 floor that does not decay as upstream publishes new releases"
    - "The dependency audit's anti-vacuous guard is derived from package.json's declared inventory instead of the hardcoded 5"
    - "The allowlisted tracked .env files are scanned for live-credential prefixes, reporting only the file name and the provider label"
  artifacts:
    - path: ".github/workflows/ci.yml"
      provides: "verify job (unchanged step list, hardened guard body) + docker-image job with Bun-version assert, inventory-derived audit guard, and the container smoke"
      contains: "Smoke - run the real container"
  key_links:
    - from: ".github/workflows/ci.yml (Smoke - run the real container)"
      to: "the running bun-ai-api:ci container on published port 3001"
      via: "docker run -d -p 3001:3001 with its real CMD ./start.sh"
      pattern: "docker run -d --name smoke"
    - from: ".github/workflows/ci.yml (smoke)"
      to: "whisper-models/sample.wav"
      via: "curl -F file=@ from the actions/checkout workspace"
      pattern: "whisper-models/sample.wav"
    - from: "GITHUB_SHA"
      to: "GET /health response body"
      via: "build-args CACHEBUST -> ARG CACHEBUST -> ENV BUILD_VERSION -> handleHealth"
      pattern: "ok \\$\\{GITHUB_SHA\\}"
---

<objective>
Close the structural hole in CI: the production image is built and its dependency tree is audited,
but **nothing has ever run the container**. The one existing `docker run` deliberately overrides the
entrypoint (`--entrypoint bun`) precisely so `start.sh` does not launch. A runtime change shipped
(Bun 1.1.29 -> 1.3.11, Cerebras SDK 1.91.0 -> 1.64.1, Groq SDK 1.4.0 -> 1.2.1) with zero evidence
that the image boots.

This plan adds a real container smoke to the existing `docker-image` job and hardens the two guards
that job and the `verify` job already carry.

Purpose:
- Prove the image boots under its real entrypoint, that `/health` answers with the *expected build's*
  SHA, that `/ready` is ready, and that whisper-server is genuinely alive.
- A `/health`-only smoke would be a structural false green: `handleHealth` returns
  `ok ${process.env.BUILD_VERSION}` and touches nothing else, while `start.sh` launches whisper-server
  with a background `&` under a `set -e` that does not cover background processes and with no
  supervisor. Whisper can be dead and the container reports healthy. **Only a real transcription
  detects that.**
- Replace two decaying guards with assertions that stay true over time, and add a value-blind
  credential scan to the permanently-allowlisted tracked env files (this repo is PUBLIC).

Output: `.github/workflows/ci.yml` only. No application code, no `start.sh`, no Dockerfile changes.
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
@start.sh
@config.ts
@composition/container.ts
@adapters/inbound/http/router.ts
@adapters/inbound/http/routes/health.ts
@adapters/inbound/http/routes/ready.ts
@adapters/inbound/http/routes/transcriptions.ts
@application/use-cases/get-readiness.ts
@.planning/quick/260724-rp0-dockerfile-bun-1-3-11-job-de-build-de-im/260724-rp0-SUMMARY.md
</context>

<verified_facts>
Established this session by reading source and by running the mechanics locally. Do NOT re-derive.

**Routing / auth.** `PRE_AUTH_ROUTES` = `/health`, `/ready`, Gemini `:generateContent`. `POST_AUTH_ROUTES`
= transcriptions, providers-status, models, chat-completions. So `/v1/audio/transcriptions` **requires
`Authorization: Bearer $PERSONAL_PROXY_API_KEY`**; `/health` and `/ready` do not.

**Transcription gate.** `handleTranscriptions` returns 400 `model_not_found` unless
`config.whisperModelAlias !== null && input.model === config.whisperModelAlias`. And `buildContainer`
selects `HttpWhisperService` only when `whisperModelAlias` is non-null, otherwise `NoopWhisperService`.
`WHISPER_MODEL_ALIAS` is therefore mandatory for the smoke, and the multipart `model` field must equal
it exactly.

**Readiness math.** `getReadiness` -> `ready = proxyKeyConfigured && eligibleProviders.length > 0`;
`mode = !proxyKeyConfigured ? 'not_configured' : unavailable.length === 0 ? 'ok' : 'degraded'`.
`buildContainer` feeds the store `configured: { cerebras: Boolean(cfg.cerebrasApiKey), groq: Boolean(cfg.groqApiKey) }`
— **presence only, the value is never used**, and no upstream call happens on `/ready`. Dummy values
give `ready:true, mode:"ok"`. `/ready` also awaits `transcription.health()` (2 s timeout) and reports
`whisperAvailable`, but that never changes the status code.

**Whisper timeout.** `config.whisperTimeoutMs` defaults to **30_000**. The runner is 2-vCPU and
`ggml-small.bin` was compiled with `GGML_NATIVE=OFF` (no AVX tuning). An 11-second clip can exceed 30 s
and the route would return 503. `WHISPER_TIMEOUT_MS` must be raised for the smoke.

**Test asset.** `whisper-models/sample.wav` is tracked (352 078 bytes, `RIFF ... WAVE, Microsoft PCM,
16 bit, mono 16000 Hz`, ~11 s). No `.gitattributes` / no LFS, so `actions/checkout` yields the real
bytes. Being WAV, whisper-server's `--convert` ffmpeg path is not exercised. It arrives from the
**runner's checkout**, not from inside the image — nothing needs to be copied into the container.
Its content is English (the classic whisper.cpp sample) while the production default is
`WHISPER_LANGUAGE=es`, so **assert only that `.text` is a non-empty string — never assert on content.**

**Env files.** `git ls-files` matches exactly one env file: `.env.test`. `.dockerignore` excludes
`.env` and `.env.local` but **not** `.env.test`, so `.env.test` ships inside the image — harmless here
because the Dockerfile sets `NODE_ENV=production`, so Bun never auto-loads `.env.test`. Out of scope;
note it as a follow-up.

**Direct-dependency inventory.** `package.json` declares 3 `dependencies` + 1 `devDependencies` +
1 `peerDependencies` (`typescript`) = **5**, matching the 5 tokens the real run parsed. `bun install`
runs *before* `ENV NODE_ENV=production` in the Dockerfile, so devDependencies are installed.
`peerDependencies` **must** be included in the count expression or the check breaks on `typescript`.
Verified locally: `jq -r '[(.dependencies//{}), (.devDependencies//{}), (.peerDependencies//{})] | map(keys) | add | unique | length' package.json` -> `5`.

**Version-floor comparison.** Verified locally with `printf '%s\n%s\n' 1.1.39 "$v" | sort -V | head -n1`:
1.1.29 and 1.0.0 fail the floor; 1.1.39, 1.3.11, 2.0.0 pass. `sort -V` is GNU on ubuntu-latest and also
works on this macOS box.

**Credential regexes.** Verified against synthetic fixtures only (never against a real env file):
`gsk_[A-Za-z0-9]{20,}`, `csk-[A-Za-z0-9]{20,}`, `(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}`,
`AKIA[A-Z0-9]{16}` all match a synthetic key and all stay clean against `sk-xxxx`,
`sk-your-key-here`, `csk-REPLACE_ME`. The `(^|[^A-Za-z0-9])` anchor on the OpenAI pattern is
**load-bearing**: verified that without it, every Cerebras `csk-…` key also trips the OpenAI pattern
(`csk-` contains `sk-`).

**Tooling.** `jq` is preinstalled on `ubuntu-latest`. `Bun.YAML.parse` exists on the local Bun 1.3.11
and parses this workflow; `Bun.spawnSync(["bash","-n",file])` runs clean over all 5 current `run:` blocks.
Current step names: `verify` = `["actions/checkout@v7","oven-sh/setup-bun@v2","Install","Typecheck","Test","Guard - no secret env files tracked"]`;
`docker-image` = `["actions/checkout@v7","docker/setup-buildx-action@v3","Build production image","Verify image deps match bun.lock"]`.

**Binding quirk (do not paper over).** `createServer` passes `hostname: config.hostname` and
`config.hostname = env["HOSTNAME"] ?? "0.0.0.0"`. Docker sets `HOSTNAME` to the container ID, so the
app binds the container's own IP rather than `0.0.0.0`. Published ports still reach it (DNAT /
docker-proxy target the container IP), and this is exactly what production does today. **Do not pass
`-e HOSTNAME=0.0.0.0`** — that would mask production behaviour. If `/health` never answers, the dumped
`docker logs` will show `Server is running on http://<container-id>:3001`; that is a real finding to
report, not something to override.
</verified_facts>

<tasks>

<task type="auto">
  <name>Task 1: Harden the Bun-version, anti-vacuous, and env-credential guards</name>
  <files>.github/workflows/ci.yml</files>
  <action>
Three edits to `.github/workflows/ci.yml`. Do not touch the `Build production image` step or the
`verify` job's `checkout` / `setup-bun` / `Install` / `Typecheck` / `Test` steps — repository ruleset
`require-ci-on-master` requires the `verify` job by name, and Task 1's verification asserts its step
**name list is byte-identical** to the current one.

**(A) `verify` job — extend the step named exactly `Guard - no secret env files tracked`.**
Keep its existing tracked-file check verbatim and append a second gate below it. Preface it with a
comment stating: this repo is PUBLIC, `.env.test` is permanently allowlisted *by name*, so name-based
allowlisting alone cannot detect a live key pasted into it; and only the file name plus a provider
label are ever emitted because the CI log is public.

Gate body, in this order:
1. Anti-vacuous self-test first. Build a synthetic token with `printf 'GROQ_API_KEY=gsk_%s\n' "0123456789abcdefghij" > "$RUNNER_TEMP/env-scan-selftest"` (write to a file — never `echo` a token into the log), assert `grep -qE 'gsk_[A-Za-z0-9]{20,}' "$RUNNER_TEMP/env-scan-selftest"` matches, and on failure emit `::error::credential scanner self-test failed — the gate is vacuous` and `exit 1`. Remove the temp file afterwards. Without this, a quoting or regex regression silently turns the gate into a no-op — the same failure mode the existing dependency-audit guard exists to prevent.
2. `allowlisted="$(git ls-files | grep -E '(^|/)\.env\.(example|test)$' || true)"`. An empty result is a legitimate state, not a failure — say so in a comment.
3. Iterate four `label:regex` pairs over each allowlisted file: `Groq:gsk_[A-Za-z0-9]{20,}`, `Cerebras:csk-[A-Za-z0-9]{20,}`, `OpenAI:(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}`, `AWS:AKIA[A-Z0-9]{16}`. Split with `label="${spec%%:*}"` / `pattern="${spec#*:}"`. Add an inline comment that the `(^|[^A-Za-z0-9])` anchor on the OpenAI pattern is load-bearing because `csk-` contains `sk-`, and that the `{20,}` floor is what keeps placeholders like `sk-xxxx` from firing.
4. Match with **`grep -qE` only**. Never `grep` without `-q`, never `cat`, never echo a line, a match, or a count. On a hit emit exactly `::error::Possible live <label> credential in tracked file <path> — rotate it and remove it from the file (value deliberately not printed)` and set `leak=1`; collect every hit across all files and patterns, then `exit 1` at the end when `leak` is set.
5. Close with `echo "OK: no live-credential prefixes in the allowlisted env files"`.

**(B) `docker-image` job — new step named exactly `Verify image Bun version`, inserted between
`Build production image` and `Verify image deps match bun.lock`.**
Body under `set -euo pipefail`:
- `bun_version="$(docker run --rm --entrypoint bun bun-ai-api:ci --version | tr -d '[:space:]')"`, then echo it.
- Anti-vacuous: if it does not match `^[0-9]+\.[0-9]+\.[0-9]+$`, emit `::error::` naming the unparsed value and `exit 1` — an unreadable version must never pass silently.
- Floor `min="1.1.39"`; compute `lowest="$(printf '%s\n%s\n' "$min" "$bun_version" | sort -V | head -n1)"` and fail when `[ "$lowest" != "$min" ]`, with an `::error::` explaining that Bun before 1.1.39 cannot read this repo's text `bun.lock` and silently resolves from `package.json`'s `^` ranges instead.
- Comment why this complements rather than replaces the lockfile audit: 1.1.39 is the release that introduced the text lockfile format, so the floor is absolute and never decays, whereas the `bun.lock` diff can only detect drift for as long as versions newer than the pins exist upstream.

**(C) `docker-image` job — replace the hardcoded threshold inside `Verify image deps match bun.lock`.**
Delete `if [ "$count" -lt 5 ]; then … "check is vacuous" … fi` and put in its place:
- `expected="$(jq -r '[(.dependencies//{}), (.devDependencies//{}), (.peerDependencies//{})] | map(keys) | add | unique | length' package.json)"`, with a comment that `peerDependencies` must be included because `typescript` lives there and does appear in `bun pm ls`, and that `jq` is preinstalled on `ubuntu-latest`.
- Guard the derivation itself: if `expected` is not a positive integer, emit `::error::Could not derive the direct-dependency count from package.json` and `exit 1`.
- Then `if [ "$count" -ne "$expected" ]` -> `::error::Dependency audit parsed $count package(s) from the image but package.json declares $expected direct dependenc(ies) — the audit is not covering the declared inventory` and `exit 1`. Comment that removing a dependency legitimately now moves both numbers together, instead of the old behaviour of reporting a false "check is vacuous".
- Leave the `@cerebras/cerebras_cloud_sdk` and `groq-sdk` presence assertions and the whole `bun.lock` comparison loop untouched — those encode a real invariant, not a threshold.
  </action>
  <verify>
    <automated>cd "$(git rev-parse --show-toplevel)" && bun -e 'const y=Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text());const nm=(j)=>y.jobs[j].steps.map((s)=>s.name??s.uses);const exp=["actions/checkout@v7","oven-sh/setup-bun@v2","Install","Typecheck","Test","Guard - no secret env files tracked"];if(JSON.stringify(nm("verify"))!==JSON.stringify(exp))throw new Error("verify job step list changed (required check!): "+JSON.stringify(nm("verify")));const d=nm("docker-image");if(!d.includes("Verify image Bun version"))throw new Error("missing step: Verify image Bun version");if(d.indexOf("Verify image Bun version")>d.indexOf("Verify image deps match bun.lock"))throw new Error("Bun version step must precede the deps audit");const t=await Bun.file(".github/workflows/ci.yml").text();if(/count.*-lt 5/.test(t))throw new Error("hardcoded anti-vacuous threshold still present");if(!/peerDependencies/.test(t))throw new Error("expected-count expression must include peerDependencies");for(const j of Object.keys(y.jobs))for(const s of y.jobs[j].steps){if(!s.run)continue;const f="/tmp/gsd-ci-"+j+"-"+String(s.name??"x").replace(/\W+/g,"_")+".sh";await Bun.write(f,s.run);const r=Bun.spawnSync(["bash","-n",f]);if(r.exitCode!==0)throw new Error("bash -n failed "+j+"/"+s.name+": "+r.stderr.toString());}const g=Bun.spawnSync(["bash","/tmp/gsd-ci-verify-Guard_no_secret_env_files_tracked.sh"],{cwd:process.cwd(),env:{...process.env,RUNNER_TEMP:"/tmp"}});console.log(g.stdout.toString());console.log(g.stderr.toString());if(g.exitCode!==0)throw new Error("env guard dry-run FAILED — read the ::error:: line above, do NOT open or print the file, escalate to the human");console.log("Task 1 OK");'</automated>
  </verify>
  <done>
`verify`'s step name list is unchanged and its guard step now also runs the value-blind credential
scan (dry-run executed locally and reported clean, printing no file contents). `docker-image` asserts
the image's Bun version against the absolute 1.1.39 floor before auditing dependencies, and the audit's
anti-vacuous guard is derived from `package.json` instead of the literal 5. Every `run:` block still
passes `bash -n`.

**If the credential dry-run reports a hit: STOP.** Do not open, print, `cat`, or quote the file.
Report only the file name and the provider label to the human and wait — a hit means a live key is
committed in a public repo and needs rotation before anything is pushed.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add the real-container smoke to the docker-image job</name>
  <files>.github/workflows/ci.yml</files>
  <action>
Append three steps to the `docker-image` job, after `Verify image deps match bun.lock`, in this exact
order. Nothing in this task may reference `${{ secrets.* }}` — Task 2's verification fails the whole
workflow if the string `secrets.` appears anywhere in it.

**Step 1 — name `Smoke - run the real container`, with `timeout-minutes: 10`** (the only step here that
can hang; without it a wedged container burns runner minutes until the 6-hour default).
Body under `set -euo pipefail`:

*Start.* `docker run -d --name smoke -p 3001:3001` with these `-e` flags and **literal dummy values
only**, then `bun-ai-api:ci`. The image already sets `PORT=3001` and `EXPOSE 3001`.
- `PERSONAL_PROXY_API_KEY=ci-smoke-not-a-real-key` — needed twice: the Bearer gate on
  `/v1/audio/transcriptions` (a `POST_AUTH_ROUTES` entry) and `proxyKeyConfigured` inside
  `getReadiness`, without which `/ready` is `{ready:false, mode:"not_configured"}` and returns 503.
- `CEREBRAS_API_KEY=ci-dummy-cerebras` and `GROQ_API_KEY=ci-dummy-groq` — only their *presence*
  matters (`buildContainer` passes `Boolean(cfg.cerebrasApiKey)` into the store's `configured` map).
  Without them `eligibleProviders` is empty and `/ready` is 503. This smoke never makes an upstream
  call, so dummies are correct and a real key must never be used.
- `WHISPER_MODEL_ALIAS=whisper-1` — `buildContainer` picks `HttpWhisperService` only when it is
  non-null, and `handleTranscriptions` 400s unless the request's `model` equals it exactly.
- `WHISPER_TIMEOUT_MS=180000` — the default is 30 000 ms and an ~11 s clip on a 2-vCPU runner with a
  `GGML_NATIVE=OFF` build of `ggml-small.bin` can exceed it, turning a healthy container into a 503.
Add a comment: **do not pass `-e HOSTNAME`.** Docker sets `HOSTNAME` to the container ID and
`config.hostname` reads it, so the app binds the container IP — which is exactly what production does.
Overriding it would mask production behaviour.

*Wait for liveness (retries, never a fixed sleep).* Loop up to 60 times, 1 s apart. Each iteration:
first assert the container is still alive with `docker inspect -f '{{.State.Running}}' smoke` (note
the braces carry no leading `$`, so GitHub Actions does not treat them as an expression; append
`|| echo false` so a removed container does not abort under `set -e`) and, when it is not `true`,
emit `::error::container exited during startup` and `exit 1` immediately — otherwise a dead container
leaves this step polling a port that will never open until the step timeout. Then try
`curl -fsS -m 2 http://127.0.0.1:3001/health >/dev/null 2>&1` and break on success. If the loop
exhausts, `::error::` that `/health` never answered within 60 s and `exit 1`.

*Assert the build stamp.* `health="$(curl -fsS -m 5 http://127.0.0.1:3001/health)"`, compare against
`"ok ${GITHUB_SHA}"` using the `GITHUB_SHA` environment variable (not a `${{ }}` interpolation), and
on mismatch print both expected and actual — a commit SHA is public. Comment that this is the
assertion closing the `build-args CACHEBUST` -> `ARG CACHEBUST` -> `ENV BUILD_VERSION` -> `handleHealth`
chain, which has been fed by the build for two runs with nothing ever verifying it reaches runtime.

*Assert readiness.* `ready_body="$(curl -fsS -m 10 http://127.0.0.1:3001/ready)"`, echo it, then
`jq -e '.ready == true'` and `jq -e '.mode == "ok"'` on it (both dummy provider keys are present, so a
`degraded` result means the store's `configured` map did not see them). Capture
`whisper_available="$(printf '%s' "$ready_body" | jq -r '.whisperAvailable')"` into a shell variable
for later but **do not gate on it** — whisper.cpp's own `GET /health` may 404 on the pinned v1.7.6
build, and the 466 MB model may still be loading at this point.

*Transcribe for real.* Retry loop, at most 24 attempts, 5 s apart:
`code="$(curl -s -o "$RUNNER_TEMP/smoke-transcription.json" -w '%{http_code}' -m 240 -X POST http://127.0.0.1:3001/v1/audio/transcriptions -H "Authorization: Bearer ci-smoke-not-a-real-key" -F "file=@whisper-models/sample.wav" -F "model=whisper-1" || echo 000)"`.
The `|| echo 000` is required: under `set -e` a curl connection error would otherwise abort the step
instead of retrying. Break on `200`. Retry on `503` (whisper still loading — `HttpWhisperService.transcribe`
fails fast on connection refused) and on `000`. Treat **every other code as terminal**: print the
response body (it is an OpenAI-shaped error, no secrets) and `exit 1`. Exhausting the loop is a
failure with an `::error::`. `whisper-models/sample.wav` comes from the runner's `actions/checkout`
(tracked, 352 KB, RIFF WAVE 16-bit mono 16 kHz), so nothing needs to be copied into the container and
the ffmpeg `--convert` path is not involved.

*Assert the transcript exists, not what it says.*
`jq -e '(.text | type == "string") and ((.text | length) > 0)' "$RUNNER_TEMP/smoke-transcription.json"`,
then echo the first 200 characters of `.text` (the sample is public repo content). Comment that this
is **the only assertion that proves whisper-server survived `start.sh`'s background `&`** — `/health`
returns `ok <sha>` unconditionally and never touches whisper, so a `/health`-only smoke is a
structural false green. Add a comment that content is deliberately not asserted because the sample is
English while the production default is `WHISPER_LANGUAGE=es`.

*Cross-check the whisper probe.* After the transcription succeeds, if `whisper_available` is not
`true`, emit `::warning::/ready reported whisperAvailable=false while a real transcription succeeded — HttpWhisperService.health() probes GET /health on whisper-server and that endpoint may not exist on the pinned v1.7.6 build`.
A warning, never a failure — it is a free diagnostic about whether `/ready`'s whisper field can be trusted.

**Step 2 — name `Smoke - container logs on failure`, `if: failure()`**, running `docker logs smoke || true`.
It must sit after the smoke step and before cleanup, otherwise the container is already gone when it
runs. `if: failure()` rather than `always()` keeps green runs quiet. Comment that the logs are safe to
print: the app's structured logger emits metadata only — never keys, prompts, responses, or transcripts
(CLAUDE.md §19) — and every key in this container is a dummy anyway.

**Step 3 — name `Smoke - remove container`, `if: always()`**, running `docker rm -f smoke || true`,
so a failed smoke never leaks a running container into a subsequent step or a self-hosted runner.
  </action>
  <verify>
    <automated>cd "$(git rev-parse --show-toplevel)" && bun -e 'const t=await Bun.file(".github/workflows/ci.yml").text();const y=Bun.YAML.parse(t);const d=y.jobs["docker-image"].steps;const at=(n)=>d.findIndex((s)=>s.name===n);const i1=at("Smoke - run the real container"),i2=at("Smoke - container logs on failure"),i3=at("Smoke - remove container");if(i1<0||i2<0||i3<0)throw new Error("missing smoke step(s): "+JSON.stringify(d.map((s)=>s.name??s.uses)));if(!(i1<i2&&i2<i3))throw new Error("smoke step order wrong: run -> logs -> cleanup");if(!d[i1]["timeout-minutes"])throw new Error("smoke step needs timeout-minutes");if(d[i2].if!=="failure()")throw new Error("logs step must be if: failure()");if(d[i3].if!=="always()")throw new Error("cleanup step must be if: always()");if(/secrets\./.test(t))throw new Error("workflow references secrets.* — the smoke must use dummy values only");const r=d[i1].run;for(const nd of ["docker run -d --name smoke","GITHUB_SHA","/ready","whisper-models/sample.wav","docker inspect"])if(!r.includes(nd))throw new Error("smoke step missing: "+nd);if(!/docker logs smoke/.test(d[i2].run))throw new Error("logs step must run docker logs smoke");if(!/docker rm -f smoke/.test(d[i3].run))throw new Error("cleanup step must run docker rm -f smoke");for(const j of Object.keys(y.jobs))for(const s of y.jobs[j].steps){if(!s.run)continue;const f="/tmp/gsd-ci2-"+j+"-"+String(s.name??"x").replace(/\W+/g,"_")+".sh";await Bun.write(f,s.run);const x=Bun.spawnSync(["bash","-n",f]);if(x.exitCode!==0)throw new Error("bash -n failed "+j+"/"+s.name+": "+x.stderr.toString());}console.log("Task 2 OK");'</automated>
  </verify>
  <done>
`docker-image` gains three steps in the order run -> logs-on-failure -> cleanup-always; the smoke step
carries `timeout-minutes`; the workflow contains no `secrets.` reference; the smoke asserts `/health`
against `GITHUB_SHA`, `/ready`, and a real transcription of `whisper-models/sample.wav`; and every
`run:` block still passes `bash -n`. Nothing outside `.github/workflows/ci.yml` was modified —
confirm with `git status --porcelain`.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
`.github/workflows/ci.yml` now (1) scans the allowlisted tracked `.env` files for live-credential
prefixes without ever printing a value, (2) asserts the image's Bun version against an absolute
`>= 1.1.39` floor, (3) derives the dependency audit's anti-vacuous threshold from `package.json`
instead of a hardcoded 5, and (4) starts the production image with its real `start.sh` entrypoint and
asserts `/health` = `ok <sha>`, `/ready` = ready, and a real transcription of
`whisper-models/sample.wav`.

None of this has run on a real runner. `docker-image` is gated on `github.event_name == 'push'` and
the local Docker daemon is off / this machine is arm64 while the image is pinned `linux/amd64`, so the
only possible verification is a push to `master`.
  </what-built>
  <how-to-verify>
1. Push the commit(s) to `master` (`verify` is a required check with admin bypass, so a direct push works).
2. Watch the run: `gh run list --branch master --limit 1` then `gh run watch <run-id>`.
3. Expect **both** jobs green. `verify` should still take ~15 s. `docker-image` was 100 s steady-state
   before this change; budget roughly 60-150 s more for the container smoke (model load plus ~11 s of
   audio on a 2-vCPU runner), so ~3-4 min total is normal.
4. Read the actual log lines, do not trust the green tick alone —
   `gh run view <run-id> --log --job <docker-image-job-id> | grep -E 'Image Bun version|declares|ok [0-9a-f]{40}|whisperAvailable|transcript|Success'`.
   Confirm:
   - `Image Bun version: 1.3.11` followed by the `OK: image Bun 1.3.11 >= 1.1.39` line
   - the dependency audit still prints `Success: all 5 image dependencies match bun.lock` and now
     reports the derived expected count rather than the literal 5
   - `/health` matched `ok <the exact SHA you pushed>` — this is the first time the
     CACHEBUST -> BUILD_VERSION chain has ever been proven at runtime
   - the `/ready` body with `"ready":true,"mode":"ok"`, and note what `whisperAvailable` says
   - a non-empty transcript excerpt printed from `sample.wav`
   - whether a `::warning::` about `whisperAvailable=false` appeared — if it did, `/ready`'s whisper
     field is unreliable and that is a real (out-of-scope) finding worth recording
5. In the `verify` job log, confirm `OK: no live-credential prefixes in the allowlisted env files`.
6. Confirm the required check is still reported under the name `verify` (ruleset `require-ci-on-master`,
   id 19711116, points at that exact name).

**If the smoke fails**, the `Smoke - container logs on failure` step already dumped `docker logs`.
Read it first:
- `Server is running on http://<container-id>:3001` plus a `/health` timeout means the `HOSTNAME`
  binding quirk documented in `<verified_facts>` bit — report it, do **not** patch it with
  `-e HOSTNAME=0.0.0.0`, which would hide production behaviour.
- whisper-server errors (missing model, failed `--convert`, immediate exit) mean `start.sh`'s
  background launch is genuinely broken in the image — exactly the class of bug this smoke exists to
  find. Report it; fixing `start.sh` is out of scope for this task.
- A transcription that only ever returns 503 while whisper-server logs look healthy means the
  timeout budget is still short — report the observed latency.
  </how-to-verify>
  <resume-signal>Type "approved" with the run id, or paste the failing step's log excerpt.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| workflow output -> public CI log | Anything a step prints is world-readable; this repo is public |
| tracked files -> public repo | `.env.test` is permanently allowlisted by name and world-readable |
| runner -> smoke container | The container is started with attacker-irrelevant dummy credentials and is reachable only on the runner's loopback |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-shs-01 | Information Disclosure | `verify` credential scan | mitigate | Match with `grep -qE` only; the `::error::` names the file path and provider label and never a value, a line, or a count. Self-test writes its synthetic token to a file with `printf`, never to stdout. Task 1's `<done>` forbids opening the file on a hit. |
| T-shs-02 | Information Disclosure | smoke container env | mitigate | Only literal dummy values are passed; the workflow must contain no `secrets.` string at all, asserted by Task 2's automated verify. No `docker inspect` of the container config is performed. |
| T-shs-03 | Information Disclosure | `docker logs smoke` on failure | accept | The app's structured logger emits metadata only — never keys, Authorization headers, prompts, responses, audio, or transcripts (CLAUDE.md §19) — and every credential in this container is a dummy. |
| T-shs-04 | Spoofing | literal Bearer value in the workflow | accept | `ci-smoke-not-a-real-key` authenticates only against a throwaway container on an ephemeral runner's loopback, torn down by an `if: always()` step. |
| T-shs-05 | Denial of Service | hung container or hung curl | mitigate | `timeout-minutes: 10` on the smoke step, `-m` on every curl, bounded retry loops, and a `docker inspect` liveness assert inside the wait loop so a dead container fails in seconds instead of polling to the step timeout. |
| T-shs-06 | Tampering | container leaked into later steps | mitigate | `Smoke - remove container` runs `docker rm -f smoke` under `if: always()`. |
| T-shs-SC | Tampering | supply chain | mitigate | This change installs no npm/pip/cargo package and introduces no new GitHub Action — it reuses `actions/checkout@v7`, `docker/setup-buildx-action@v3`, and `docker/build-push-action@v6`, already pinned in this workflow. No package-legitimacy checkpoint applies. |
</threat_model>

<verification>
- `.github/workflows/ci.yml` is the only modified file (`git status --porcelain`).
- Both tasks' automated `bun -e` checks pass, including `bash -n` over every `run:` block.
- The `verify` job's step **name list** is byte-identical to before (the required check must keep
  reporting under the name `verify`).
- A real push to `master` produces a green `verify` and a green `docker-image`, with the smoke's
  `/health`, `/ready`, and transcription assertions all visible in the log.
</verification>

<success_criteria>
1. CI runs the production container under its real `start.sh` entrypoint on every push to `master`.
2. `/health` is asserted to equal `ok <pushed SHA>` — the CACHEBUST -> BUILD_VERSION chain is proven
   at runtime for the first time.
3. `/ready` is asserted `ready:true, mode:"ok"`.
4. A real transcription of `whisper-models/sample.wav` returns 200 with a non-empty `text`, proving
   whisper-server survived `start.sh`'s background launch.
5. A failing smoke dumps `docker logs`; the container is removed on every outcome.
6. The image's Bun version is asserted against a non-decaying `>= 1.1.39` floor.
7. The dependency audit's anti-vacuous guard tracks `package.json`'s declared inventory.
8. The allowlisted tracked env files are scanned for live-credential prefixes, emitting file name and
   provider label only.
9. The `verify` job's step list is unchanged, so ruleset `require-ci-on-master` still resolves.
</success_criteria>

<out_of_scope>
Explicitly NOT in this plan: GHCR push, EasyPanel webhook, deploy or post-deploy smoke; moving the
whisper model to a volume; dependabot / trivy / gitleaks / CodeQL; a nightly contract test against
real providers; branch-protection ruleset changes; renaming `verify` or altering its existing steps;
any change to application code, `start.sh`, or the `Dockerfile`.

Observed but deliberately untouched (record as follow-ups in the SUMMARY, do not act):
- `.env.test` is not in `.dockerignore`, so it ships inside the production image. Inert today because
  `NODE_ENV=production` means Bun never auto-loads it.
- `start.sh` has no supervisor for the background whisper-server. This plan *detects* a dead sidecar;
  it does not fix the lifecycle.
- `dist/index.js` is still a stale pre-Phase-1 build artifact in the tree.
</out_of_scope>

<output>
Create `.planning/quick/260724-shs-smoke-del-contenedor-en-ci-arranque-heal/260724-shs-SUMMARY.md` when done.
</output>
