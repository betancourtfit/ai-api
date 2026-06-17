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
FROM --platform=linux/amd64 oven/bun:1.1.29 AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       cmake \
       git \
       ca-certificates \
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

# ============================================================
# Stage 2: final — Bun proxy + whisper-server sidecar
# ============================================================
# Must match the builder arch (amd64) — the copied whisper-server binary is amd64.
FROM --platform=linux/amd64 oven/bun:1.1.29

WORKDIR /app

# Install runtime OpenMP dependency (libstdc++ already present in base).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled whisper-server binary onto PATH.
COPY --from=builder /whisper.cpp/build/bin/whisper-server /usr/local/bin/whisper-server

# Install Bun dependencies (cache-friendly layer).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the full application (includes index.ts, whisper-models/, start.sh, etc.).
COPY . .

# Make the entrypoint executable.
RUN chmod +x start.sh

# Environment
ENV NODE_ENV=production
ENV PORT=3001
ENV WHISPER_HOST=127.0.0.1
ENV WHISPER_PORT=8080

EXPOSE 3001

# Entrypoint: launches whisper-server sidecar then exec's the Bun proxy.
CMD ["./start.sh"]
