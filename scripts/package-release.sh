#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

detect_platform() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "macos"
      ;;
    Linux)
      printf '%s\n' "linux"
      ;;
    *)
      printf '%s\n' "unknown"
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      printf '%s\n' "x64"
      ;;
    arm64|aarch64)
      printf '%s\n' "arm64"
      ;;
    *)
      uname -m
      ;;
  esac
}

normalize_deb_arch() {
  case "$1" in
    x64)
      printf '%s\n' "amd64"
      ;;
    arm64)
      printf '%s\n' "arm64"
      ;;
    *)
      return 1
      ;;
  esac
}

VERSION="${ONE_CLAW_RELEASE_VERSION:-1.0.2}"
PLATFORM="${ONE_CLAW_RELEASE_PLATFORM:-$(detect_platform)}"
ARCH="${ONE_CLAW_RELEASE_ARCH:-$(detect_arch)}"
NAME="one-claw-v${VERSION}-${PLATFORM}-${ARCH}"
OUT_DIR="$ROOT/release"
STAGE_DIR="$OUT_DIR/$NAME"
ARCHIVE_TGZ="$OUT_DIR/${NAME}.tar.gz"
ARCHIVE_ZIP="$OUT_DIR/${NAME}.zip"
DEB_ARCHIVE=""

create_linux_deb() {
  if [[ "$PLATFORM" != "linux" ]]; then
    return 0
  fi

  local deb_arch
  if ! deb_arch="$(normalize_deb_arch "$ARCH")"; then
    echo "Skipping .deb packaging for unsupported Linux architecture: $ARCH" >&2
    return 0
  fi

  local deb_package_name="${ONE_CLAW_DEB_PACKAGE_NAME:-one-claw}"
  local deb_version="${ONE_CLAW_DEB_VERSION:-$VERSION}"
  local deb_maintainer="${ONE_CLAW_DEB_MAINTAINER:-Lsogod <opensource@one-claw.local>}"
  local deb_build_root="$OUT_DIR/.deb-build/$NAME"
  local control_dir="$deb_build_root/control"
  local data_dir="$deb_build_root/data"
  local install_dir="$data_dir/opt/$deb_package_name"
  local installed_size

  DEB_ARCHIVE="$OUT_DIR/${deb_package_name}_${deb_version}_${deb_arch}.deb"

  rm -rf "$deb_build_root"
  mkdir -p "$control_dir" "$install_dir" "$data_dir/usr/bin"

  cp -R "$STAGE_DIR"/. "$install_dir/"

  cat > "$data_dir/usr/bin/one" <<EOF
#!/usr/bin/env bash
set -euo pipefail

exec /opt/$deb_package_name/bin/one "\$@"
EOF
  chmod 755 "$data_dir/usr/bin/one"

  installed_size="$(du -sk "$data_dir" | awk '{print $1}')"

  cat > "$control_dir/control" <<EOF
Package: $deb_package_name
Version: $deb_version
Section: utils
Priority: optional
Architecture: $deb_arch
Maintainer: $deb_maintainer
Depends: bash, curl
Homepage: https://github.com/Lsogod/OneClaw
Installed-Size: $installed_size
Description: One Claw terminal AI coding assistant
 One Claw is a terminal AI coding assistant wired to Codex via a local
 Anthropic-compatible adapter.
 .
 bun and the codex CLI must be installed separately before running one.
EOF

  printf '2.0\n' > "$deb_build_root/debian-binary"

  (
    cd "$control_dir"
    tar -czf "$deb_build_root/control.tar.gz" \
      --uid 0 --gid 0 --uname root --gname root \
      .
  )

  (
    cd "$data_dir"
    tar -czf "$deb_build_root/data.tar.gz" \
      --uid 0 --gid 0 --uname root --gname root \
      .
  )

  rm -f "$DEB_ARCHIVE"
  (
    cd "$deb_build_root"
    ar -cr "$DEB_ARCHIVE" debian-binary control.tar.gz data.tar.gz
  )

  rm -rf "$deb_build_root"
}

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/dist" "$OUT_DIR"

bun build --target bun --outdir ./dist --preload ./runtime/preload.ts ./entrypoints/cli.tsx
bun build --target bun --outdir ./dist \
  ./packages/codex-anthropic-adapter/src/server.ts \
  ./packages/codex-anthropic-adapter/src/stack.ts

cp -R "$ROOT/dist"/. "$STAGE_DIR/dist/"
cp "$ROOT/README.md" "$STAGE_DIR/README.md"
cp "$ROOT/packages/codex-anthropic-adapter/README.md" "$STAGE_DIR/ADAPTER.md"
printf '%s\n' "$VERSION" > "$STAGE_DIR/VERSION"

cat > "$STAGE_DIR/bin/one" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -h "$SOURCE" ]]; do
  DIR="$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P -- "$(dirname -- "$SOURCE")/.." && pwd)"

export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to run One Claw release builds." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is required to run One Claw in codex mode." >&2
  exit 1
fi

ONE_CLAW_CONFIG_DIR="${ONE_CLAW_CONFIG_DIR:-$HOME/.one-claw}"
LEGACY_CLAUDE_CONFIG_DIR="${HOME}/.claude"
LEGACY_CLAUDE_GLOBAL_FILE="${HOME}/.claude.json"
ISOLATED_CLAUDE_GLOBAL_FILE="${ONE_CLAW_CONFIG_DIR}/.claude.json"

migrate_isolated_config() {
  mkdir -p "$ONE_CLAW_CONFIG_DIR"

  if [[ ! -e "$ONE_CLAW_CONFIG_DIR/.migration-complete" ]]; then
    if [[ -d "$LEGACY_CLAUDE_CONFIG_DIR" ]]; then
      if command -v rsync >/dev/null 2>&1; then
        rsync -a "$LEGACY_CLAUDE_CONFIG_DIR"/ "$ONE_CLAW_CONFIG_DIR"/ >/dev/null 2>&1 || true
      else
        cp -R "$LEGACY_CLAUDE_CONFIG_DIR"/. "$ONE_CLAW_CONFIG_DIR"/ 2>/dev/null || true
      fi
    fi

    if [[ -f "$LEGACY_CLAUDE_GLOBAL_FILE" && ! -f "$ISOLATED_CLAUDE_GLOBAL_FILE" ]]; then
      cp "$LEGACY_CLAUDE_GLOBAL_FILE" "$ISOLATED_CLAUDE_GLOBAL_FILE"
    fi

    : > "$ONE_CLAW_CONFIG_DIR/.migration-complete"
  fi
}

migrate_isolated_config
export CLAUDE_CONFIG_DIR="$ONE_CLAW_CONFIG_DIR"

DEFAULT_CODEX_HOME="${HOME}/.codex"
if [[ -n "${CODEX_HOME:-}" && ! -e "${CODEX_HOME}" ]]; then
  export CODEX_HOME="$DEFAULT_CODEX_HOME"
elif [[ -z "${CODEX_HOME:-}" ]]; then
  export CODEX_HOME="$DEFAULT_CODEX_HOME"
fi

if [[ ! -e "$CODEX_HOME" ]]; then
  mkdir -p "$CODEX_HOME"
fi

ADAPTER_URL="${ONE_CLAW_ADAPTER_BASE_URL:-http://127.0.0.1:4317}"
HEALTH_URL="${ADAPTER_URL%/}/health"
STACK_LOG="${ONE_CLAW_STACK_LOG:-${TMPDIR:-/tmp}/one-claw-stack.log}"
STACK_PID=""
STARTED_STACK=0
SKIP_STACK=0
HAS_PRINT=0
HAS_OUTPUT_FORMAT=0
HAS_INCLUDE_PARTIAL=0
HAS_VERBOSE=0
OUTPUT_FORMAT_VALUE=""

healthcheck() {
  curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
}

cleanup() {
  local exit_code=$?
  if [[ "$STARTED_STACK" == "1" && -n "$STACK_PID" ]]; then
    kill "$STACK_PID" >/dev/null 2>&1 || true
    wait "$STACK_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}

for arg in "$@"; do
  case "$arg" in
    -p|--print)
      HAS_PRINT=1
      ;;
    --output-format)
      HAS_OUTPUT_FORMAT=1
      OUTPUT_FORMAT_VALUE="__NEXT__"
      ;;
    --output-format=*)
      HAS_OUTPUT_FORMAT=1
      OUTPUT_FORMAT_VALUE="${arg#--output-format=}"
      ;;
    --include-partial-messages)
      HAS_INCLUDE_PARTIAL=1
      ;;
    --verbose)
      HAS_VERBOSE=1
      ;;
    -v|--version|-V|-h|--help)
      SKIP_STACK=1
      ;;
  esac
done

if [[ "$OUTPUT_FORMAT_VALUE" == "__NEXT__" ]]; then
  PREV=""
  for arg in "$@"; do
    if [[ "$PREV" == "--output-format" ]]; then
      OUTPUT_FORMAT_VALUE="$arg"
      break
    fi
    PREV="$arg"
  done
fi

if [[ "${1-}" == "auth" ]]; then
  SKIP_STACK=1
fi

trap cleanup EXIT INT TERM

if [[ "$SKIP_STACK" != "1" ]] && ! healthcheck; then
  : >"$STACK_LOG"
  (
    cd "$ROOT"
    bun "$ROOT/dist/stack.js"
  ) >>"$STACK_LOG" 2>&1 &
  STACK_PID=$!
  STARTED_STACK=1

  for _ in $(seq 1 80); do
    if healthcheck; then
      break
    fi
    if ! kill -0 "$STACK_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  if ! healthcheck; then
    echo "Failed to start the One Claw backend stack." >&2
    echo "Stack log: $STACK_LOG" >&2
    exit 1
  fi
fi

EXTRA_ARGS=()
if [[ "$HAS_PRINT" == "1" && "$HAS_OUTPUT_FORMAT" == "0" ]]; then
  EXTRA_ARGS+=(--output-format text)
fi
if [[ "$HAS_PRINT" == "1" && "$HAS_INCLUDE_PARTIAL" == "0" ]]; then
  EXTRA_ARGS+=(--include-partial-messages)
fi
if [[ "$HAS_PRINT" == "1" && "$OUTPUT_FORMAT_VALUE" == "stream-json" && "$HAS_VERBOSE" == "0" ]]; then
  EXTRA_ARGS+=(--verbose)
fi

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  CLAUDE_CODE_PROVIDER=codex bun --preload "$ROOT/dist/runtime/preload.js" "$ROOT/dist/entrypoints/cli.js" "$@" "${EXTRA_ARGS[@]}"
else
  CLAUDE_CODE_PROVIDER=codex bun --preload "$ROOT/dist/runtime/preload.js" "$ROOT/dist/entrypoints/cli.js" "$@"
fi
EOF

chmod +x "$STAGE_DIR/bin/one"

(
  cd "$OUT_DIR"
  rm -f "$ARCHIVE_TGZ" "$ARCHIVE_ZIP"
  tar -czf "$ARCHIVE_TGZ" "$NAME"
  zip -qr "$ARCHIVE_ZIP" "$NAME"
)

create_linux_deb

echo "Created release artifacts:"
echo "  $ARCHIVE_TGZ"
echo "  $ARCHIVE_ZIP"
if [[ -n "$DEB_ARCHIVE" ]]; then
  echo "  $DEB_ARCHIVE"
fi
