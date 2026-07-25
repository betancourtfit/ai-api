#!/usr/bin/env bash
set -eu

# ensure-model.sh — idempotent, checksum-verified provisioning of the whisper
# model into a runtime volume (D-01). Standalone command, not sourced: on
# exit 0 the file at $WHISPER_MODEL_PATH exists and (when a checksum was
# supplied) matches it; on exit 1 the model is unavailable and nothing
# partial has been left behind. Must run unmodified on both Debian (the
# image) and macOS (the dev machine) — D-08 — hence the sha256_of shim below
# and bash 3.2 syntax throughout (no ${v,,}).

# Portability shim (D-08): prefer sha256sum (Debian/coreutils), fall back to
# shasum -a 256 (macOS). Both print "<hex digest>  <filename>"; keep only the
# first whitespace-delimited field so callers never see the filename.
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "whisper-model: unavailable: no sha256sum or shasum available" >&2
        exit 1
    fi
}

path="${WHISPER_MODEL_PATH:-}"
url="${WHISPER_MODEL_URL:-}"
sha="${WHISPER_MODEL_SHA256:-}"

# 1. Path is mandatory — start.sh owns the defaults, this script applies none.
if [ -z "$path" ]; then
    echo "whisper-model: unavailable: WHISPER_MODEL_PATH is empty" >&2
    exit 1
fi

# 2. Normalise the expected digest to lowercase (bash 3.2 — no ${v,,}), then
# validate it is either empty or exactly 64 hex characters. A typo'd checksum
# must be a loud config error, not a silent re-download loop.
sha="$(printf '%s' "$sha" | tr 'A-Z' 'a-z')"
if [ -n "$sha" ]; then
    if [ "${#sha}" -ne 64 ]; then
        echo "whisper-model: unavailable: WHISPER_MODEL_SHA256 is not a 64-character hex digest" >&2
        exit 1
    fi
    case "$sha" in
        *[!0-9a-f]*)
            echo "whisper-model: unavailable: WHISPER_MODEL_SHA256 is not a 64-character hex digest" >&2
            exit 1
            ;;
    esac
fi

# 3. Ensure the destination directory exists — covers a read-only or
# unmounted volume.
dir="$(dirname "$path")"
if ! mkdir -p "$dir" 2>/dev/null; then
    echo "whisper-model: unavailable: cannot create $dir" >&2
    exit 1
fi

# 4. Cache check. No expected digest lets an operator-mounted model through
# unverified; a matching digest is a clean cache hit; a mismatch discards the
# file (D-07: re-verify on every boot, not just after downloading) so a
# failed re-download below leaves nothing rather than a known-bad file.
if [ -e "$path" ]; then
    if [ -z "$sha" ]; then
        echo "whisper-model: cache hit at $path (unverified: WHISPER_MODEL_SHA256 not set)"
        exit 0
    fi
    actual="$(sha256_of "$path")"
    if [ "$actual" = "$sha" ]; then
        echo "whisper-model: cache hit at $path"
        exit 0
    fi
    echo "whisper-model: checksum mismatch on cached file, discarding" >&2
    rm -f "$path"
fi

# 5. Refuse to fetch anything unverifiable or unencrypted before downloading.
if [ -z "$url" ]; then
    echo "whisper-model: unavailable: WHISPER_MODEL_URL is empty" >&2
    exit 1
fi
case "$url" in
    https://*) ;;
    *)
        echo "whisper-model: unavailable: WHISPER_MODEL_URL must be https" >&2
        exit 1
        ;;
esac
if [ -z "$sha" ]; then
    echo "whisper-model: unavailable: refusing to download without WHISPER_MODEL_SHA256" >&2
    exit 1
fi

# 6. Sweep stale temporaries left by a hard kill (SIGKILL bypasses traps) so
# they cannot fill the volume. -mmin is portable across GNU and BSD find.
find "$dir" -maxdepth 1 -name '.model.*' -mmin +60 -delete 2>/dev/null || true

# 7. mktemp retries on collision via O_EXCL, so this is safe even when two
# containers share the volume (D-06). The trap fires on every exit path —
# including a bare `mv` making $tmp no longer exist — so no path needs to
# repeat the cleanup itself.
tmp="$(mktemp "$dir/.model.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "whisper-model: downloading from $url"
set +e
curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused --connect-timeout 20 --max-time 1800 -o "$tmp" "$url"
curl_rc=$?
set -e
if [ "$curl_rc" -ne 0 ]; then
    echo "whisper-model: unavailable: download failed (curl exit $curl_rc)" >&2
    exit 1
fi

# 9. Verify before install — both values are public constants, so logging a
# prefix of each is safe and is the only way to debug upstream drift.
actual="$(sha256_of "$tmp")"
if [ "$actual" != "$sha" ]; then
    echo "whisper-model: unavailable: checksum mismatch (expected ${sha:0:12}..., got ${actual:0:12}...)" >&2
    exit 1
fi

# 10. Same directory as $path, therefore the same filesystem, therefore an
# atomic rename (D-06): the final path is only ever written by a rename of a
# file that has already been verified.
if ! mv -f "$tmp" "$path"; then
    echo "whisper-model: unavailable: install failed" >&2
    exit 1
fi
echo "whisper-model: install ok at $path"
