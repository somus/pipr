#!/bin/sh
set -eu

repo="${PIPR_REPO:-somus/pipr}"
version="${PIPR_VERSION:-latest}"
install_dir="${PIPR_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "pipr install: unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    echo "pipr install: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

asset="pipr-${os}-${arch}"
if [ "$version" = "latest" ]; then
  url="https://github.com/${repo}/releases/latest/download/${asset}"
else
  url="https://github.com/${repo}/releases/download/${version}/${asset}"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT HUP TERM
tmp_file="${tmp_dir}/pipr"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp_file"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$tmp_file"
else
  echo "pipr install: curl or wget is required" >&2
  exit 1
fi

chmod 755 "$tmp_file"
mkdir -p "$install_dir"
mv "$tmp_file" "${install_dir}/pipr"

if "${install_dir}/pipr" --help >/dev/null 2>&1; then
  echo "pipr installed to ${install_dir}/pipr"
else
  echo "pipr install: installed binary did not run" >&2
  exit 1
fi

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add ${install_dir} to PATH to run pipr from any directory." ;;
esac
