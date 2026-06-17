# ============================================================
# Stage 1: builder — compile whisper-server from whisper.cpp
# ============================================================
FROM debian:bookworm-slim AS builder

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

RUN cmake -B build -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build build --target whisper-server -j --config Release

# Binary is at /whisper.cpp/build/bin/whisper-server

# ============================================================
# Stage 2: final — Bun proxy + whisper-server sidecar
# ============================================================
FROM oven/bun:1.1.29

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
