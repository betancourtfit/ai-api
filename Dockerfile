# ============================================================
# Stage 1: builder — compile whisper-server from whisper.cpp
# ============================================================
# Build ON the same oven/bun base as the final stage so the whisper-server binary
# links against the exact glibc/libstdc++ it will run on (a newer Debian builder
# produces GLIBC_2.3x/GLIBCXX symbols the runtime lacks). Multi-stage keeps the
# build toolchain out of the final image.
# Pinned to linux/amd64: deploy target is a CPU-only amd64 mini-pc (EasyPanel).
# Pinning lets the image build on an arm64 host (Apple Silicon, via emulation) and
# still produce a binary that runs on the mini-pc. On a native amd64 builder it is
# a no-op.
# Pinned to 1.3.11: Bun before v1.1.39 cannot read this repo's text `bun.lock`
# format and silently resolves from the `^` ranges in package.json instead, so
# `bun install --frozen-lockfile` below exits 0 having installed different
# versions than the test suite covers. Matches `setup-bun` in
# .github/workflows/ci.yml — the two must be bumped together. See
# .planning/quick/260724-rp0-dockerfile-bun-1-3-11-job-de-build-de-im/ for the
# empirical evidence.
FROM --platform=linux/amd64 oven/bun:1.3.11 AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       cmake \
       git \
       ca-certificates \
       curl \
    && rm -rf /var/lib/apt/lists/*

# Clone whisper.cpp pinned to a verified tag that includes the server example.
# --depth 1 keeps the layer lean. The whisper-server target is built by default
# via WHISPER_BUILD_EXAMPLES=ON (no separate server-specific cmake flag needed).
RUN git clone --depth 1 --branch v1.7.6 \
    https://github.com/ggml-org/whisper.cpp /whisper.cpp

WORKDIR /whisper.cpp

# GGML_NATIVE=OFF disables -march/-mcpu=native so the binary uses a portable
# x86-64 baseline that runs on any mini-pc CPU (native tuning would bake in the
# build host's instruction set). ponytail: baseline = no AVX tuning; if inference
# speed matters, build with -DGGML_NATIVE=ON on the mini-pc itself instead.
# BUILD_SHARED_LIBS=OFF statically links libwhisper/libggml into the binary, so
# the final image needs only the single whisper-server executable (no .so copying
# or LD_LIBRARY_PATH wiring).
RUN cmake -B build -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build --target whisper-server -j

# Binary is at /whisper.cpp/build/bin/whisper-server

# The model is no longer fetched or baked into the image (quick task 260724-mv1):
# it is now provisioned at container boot into the /models runtime volume by
# ensure-model.sh, sha256-verified, so the 426 MB blob stops re-entering every
# GHA layer cache. `curl` stays in this stage's apt-get line above even though
# it is now unused here — editing that instruction would invalidate every
# cached layer below it and force a full whisper.cpp recompile to save ~3 MB in
# a stage that never ships.

# ============================================================
# Stage 2: final — Bun proxy + whisper-server sidecar
# ============================================================
# Must match the builder arch (amd64) — the copied whisper-server binary is amd64.
FROM --platform=linux/amd64 oven/bun:1.3.11

WORKDIR /app

# Runtime deps: libgomp1 (OpenMP; libstdc++ already in base) and ffmpeg, which
# whisper-server --convert shells out to for non-WAV inputs (m4a/mp4/webm/aac —
# the iOS/n8n-default formats). Without it those uploads 503. curl and
# ca-certificates (D-10) are added because ensure-model.sh needs an https
# downloader with real TLS verification and `curl` is absent from the
# oven/bun base image; mild attack-surface increase accepted for a
# single-user personal deployment that already ships bash, bun and ffmpeg.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled whisper-server binary onto PATH.
COPY --from=builder /whisper.cpp/build/bin/whisper-server /usr/local/bin/whisper-server

# Install Bun dependencies (cache-friendly layer).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# CACHEBUST busts every layer below it when its value changes. Set it to the git
# SHA (or any changing value) in EasyPanel build args / `docker build --build-arg`
# so a "force rebuild" can't silently reuse a stale app layer. The heavy whisper
# build in stage 1 stays cached — only the cheap app copy/install below re-runs.
ARG CACHEBUST=0
RUN echo "cachebust=${CACHEBUST}"

# Copy the full application (includes index.ts, start.sh, ensure-model.sh, etc.).
COPY . .

# Make the entrypoints executable.
RUN chmod +x start.sh ensure-model.sh

# Environment
ENV NODE_ENV=production
ENV PORT=3001
ENV WHISPER_HOST=127.0.0.1
ENV WHISPER_PORT=8080
# Surfaced by GET /health so you can confirm which build is live (CACHEBUST is
# still in scope from its declaration above).
ENV BUILD_VERSION=${CACHEBUST}

# Whisper model provisioning (runtime volume, quick task 260724-mv1). The
# production model identity is unchanged — still ggml-small — only its
# *location* moved out of the image and into /models. These three must move
# together whenever the model changes, and must stay byte-identical to the
# :- fallbacks in start.sh so `docker inspect` and a bare `./start.sh` agree.
ENV WHISPER_MODEL_PATH=/models/ggml-small.bin
ENV WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
ENV WHISPER_MODEL_SHA256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b

# Ensure the mount point exists so a bare `docker run` (no volume attached)
# still gets an anonymous volume rather than writing into the image layer.
# EasyPanel must mount a persistent volume at /models — see README.md.
RUN mkdir -p /models
VOLUME /models

EXPOSE 3001

# Entrypoint: launches whisper-server sidecar then exec's the Bun proxy.
CMD ["./start.sh"]
