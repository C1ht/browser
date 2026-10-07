#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Install a build toolchain from Ubuntu 24.04 packages and crates.io, for
# machines that cannot reach Mozilla's toolchain servers (mach bootstrap).
# Matches mozconfigs/dev. Run as root.
set -euo pipefail

llvm=20
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  clang-$llvm lld-$llvm llvm-$llvm libclang-$llvm-dev \
  libclang-rt-$llvm-dev libclang-rt-$llvm-dev-wasm32 \
  libc++-$llvm-dev-wasm32 libc++abi-$llvm-dev-wasm32 wasi-libc \
  libgtk-3-dev libdbus-1-dev libpulse-dev libasound2-dev libx11-xcb-dev \
  libxt-dev libdrm-dev libxkbcommon-dev libwayland-dev libxrandr-dev \
  libxcomposite-dev libxdamage-dev libxfixes-dev libxcursor-dev libxi-dev \
  libxtst-dev libfontconfig-dev libfreetype-dev nasm m4 unzip zip watchman

# Same version mach bootstrap would fetch.
cargo install --locked cbindgen --version 0.29.4

# Ubuntu splits the WASI sysroot between /usr (wasi-libc) and LLVM's prefix
# (libc++). Gecko wants one directory, so link them together.
sysroot="${MOZBUILD_STATE_PATH:-$HOME/.mozbuild}/wasi-sysroot"
rm -rf "$sysroot"
mkdir -p "$sysroot/include/wasm32-wasi" "$sysroot/lib/wasm32-wasi"
ln -s /usr/include/wasm32-wasi/* "$sysroot/include/wasm32-wasi/"
ln -s "/usr/lib/llvm-$llvm/include/wasm32-wasi/c++" "$sysroot/include/wasm32-wasi/c++"
ln -s /usr/lib/wasm32-wasi/* "$sysroot/lib/wasm32-wasi/"
ln -sf "/usr/lib/llvm-$llvm/lib/wasm32-wasi/"libc++*.a "$sysroot/lib/wasm32-wasi/"
echo "Toolchain ready. WASI sysroot: $sysroot"
