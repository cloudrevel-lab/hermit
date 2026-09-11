#!/bin/sh
# Hermit Console installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/cloudrevel-lab/hermit/main/install.sh | sh
#
# Installs Hermit under HERMIT_HOME (default ~/.hermit). If a suitable Node is
# already on PATH it is used; otherwise a private Node runtime is downloaded
# once. The `hermit` command is linked into HERMIT_BIN_DIR (default
# ~/.local/bin). Nothing else on the machine is touched.

set -e

if [ -z "$HERMIT_HOME" ]; then HERMIT_HOME="$HOME/.hermit"; fi
if [ -z "$HERMIT_BIN_DIR" ]; then HERMIT_BIN_DIR="$HOME/.local/bin"; fi
if [ -z "$HERMIT_NODE_CHANNEL" ]; then HERMIT_NODE_CHANNEL="latest-v22.x"; fi

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"

case "$(uname -s)" in
  Darwin) node_os=darwin ;;
  Linux)  node_os=linux ;;
  *) die "unsupported OS: $(uname -s). On Windows, use install.ps1." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) node_arch=arm64 ;;
  x86_64|amd64)  node_arch=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)' >/dev/null 2>&1
}

find_runtime_node() {
  for candidate in "$HERMIT_HOME"/runtime/node-*/bin/node; do
    [ -x "$candidate" ] || continue
    if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)' >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN=""
NPM_CLI=""

if node_ok; then
  NODE_BIN="$(command -v node)"
  say "Using the Node already on PATH ($(node -v))."
elif NODE_BIN="$(find_runtime_node)"; then
  NPM_CLI="$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"
  say "Using the Node runtime already installed in $HERMIT_HOME."
else
  say "No suitable Node found; downloading a private runtime (one-time)."
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT INT TERM
  listing="$(curl -fsSL "https://nodejs.org/dist/$HERMIT_NODE_CHANNEL/")" || die "could not reach nodejs.org"
  file="$(printf '%s\n' "$listing" | grep -o "node-v[0-9.]*-$node_os-$node_arch[.]tar[.]gz" | head -1)"
  [ -n "$file" ] || die "no Node build found for $node_os-$node_arch"
  ver="$(printf '%s' "$file" | sed -e 's/^node-//' -e "s/-$node_os-$node_arch[.]tar[.]gz$//")"
  say "  Node $ver ($node_os-$node_arch)"
  curl -fsSL "https://nodejs.org/dist/$ver/$file" -o "$dir/$file" || die "Node download failed"
  if curl -fsSL "https://nodejs.org/dist/$ver/SHASUMS256.txt" -o "$dir/SHASUMS256.txt" 2>/dev/null; then
    want="$(awk -v f="$file" '$2 == f { print $1 }' "$dir/SHASUMS256.txt")"
    if [ -n "$want" ]; then
      if command -v shasum >/dev/null 2>&1; then
        got="$(shasum -a 256 "$dir/$file" | awk '{print $1}')"
      else
        got="$(sha256sum "$dir/$file" | awk '{print $1}')"
      fi
      [ "$want" = "$got" ] || die "checksum mismatch for $file"
      say "  checksum ok"
    fi
  fi
  mkdir -p "$HERMIT_HOME/runtime"
  tar -xzf "$dir/$file" -C "$HERMIT_HOME/runtime" || die "could not extract Node"
  node_dir="$HERMIT_HOME/runtime/node-$ver-$node_os-$node_arch"
  NODE_BIN="$node_dir/bin/node"
  NPM_CLI="$node_dir/lib/node_modules/npm/bin/npm-cli.js"
  [ -x "$NODE_BIN" ] || die "Node did not install where expected"
fi

run_npm() {
  if [ -n "$NPM_CLI" ]; then
    "$NODE_BIN" "$NPM_CLI" "$@"
  else
    npm "$@"
  fi
}

# Installs from npm. Set HERMIT_TARBALL to a tarball URL or path to install a
# specific build instead (for example a GitHub release asset).
if [ -n "$HERMIT_TARBALL" ]; then
  spec="$HERMIT_TARBALL"
else
  spec="hermit-console@latest"
fi

say "Installing Hermit into $HERMIT_HOME ..."
mkdir -p "$HERMIT_HOME"
run_npm install --global --prefix "$HERMIT_HOME" --no-fund --no-audit "$spec" >/dev/null 2>&1 \
  || die "npm install failed (check your network, or set HERMIT_TARBALL to a tarball)"

# npm's shim uses `#!/usr/bin/env node`, which fails when we installed a private
# runtime that is not on PATH. Write our own launcher against the Node we found.
mkdir -p "$HERMIT_HOME/bin"
rm -f "$HERMIT_HOME/bin/hermit"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' \
  "$NODE_BIN" \
  "$HERMIT_HOME/lib/node_modules/hermit-console/bin/hermit.mjs" \
  > "$HERMIT_HOME/bin/hermit"
chmod +x "$HERMIT_HOME/bin/hermit"

mkdir -p "$HERMIT_BIN_DIR"
ln -sf "$HERMIT_HOME/bin/hermit" "$HERMIT_BIN_DIR/hermit"

say ""
say "Hermit installed."
say "  launcher: $HERMIT_BIN_DIR/hermit"
case ":$PATH:" in
  *":$HERMIT_BIN_DIR:"*)
    say "  run:      hermit"
    ;;
  *)
    say ""
    say "$HERMIT_BIN_DIR is not on your PATH. Add it, then open a new terminal:"
    say "  export PATH=$HERMIT_BIN_DIR"
    ;;
esac
