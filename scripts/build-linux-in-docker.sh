#!/usr/bin/env bash
# Worker-only 迁移阶段 10：Debian 12 容器内 Linux x64 全量打包。
# 依赖：仓库挂载在 /repo（读写），宿主 cargo-xwin 缓存无关。
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg build-essential file pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libxdo-dev \
  git python3 >/dev/null

# Node 20 + corepack pnpm（与仓库 engines 对齐）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
corepack enable
corepack prepare pnpm@12.5.1 --activate

# Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal >/dev/null
source "$HOME/.cargo/env"

cd /repo
pnpm install --frozen-lockfile

# AppImage 工具在容器内以解包方式运行（无 FUSE）
export APPIMAGE_EXTRACT_AND_RUN=1
pnpm tauri build --bundles deb,rpm,appimage --target x86_64-unknown-linux-gnu

node scripts/collect-release-artifacts.mjs linux x64
echo "=== Linux x64 打包完成 ==="
ls -la /repo/release/Linux/
