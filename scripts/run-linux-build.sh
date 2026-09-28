#!/usr/bin/env bash
# 授权 Docker Desktop 后，在仓库根目录运行本脚本即完成 Linux x64 打包：
#   ./scripts/run-linux-build.sh
# 产物输出到 release/Linux/（deb/rpm/appimage）。
# 优先使用 potools-builder:latest（apt/Node/pnpm/Rust 已预装，省去每次
# 安装工具链的 10+ 分钟）；镜像不存在时回退到裸 debian:bookworm 自装。
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=potools-builder:latest
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "未找到 ${IMAGE}，回退裸 debian:bookworm（将现场安装工具链，较慢）"
  IMAGE=debian:bookworm
fi
# 构建在容器内部文件系统 /build 进行（macOS 绑定挂载与 linuxdeploy 不兼容），
# pnpm store 与 cargo registry 用命名卷持久化，二次构建显著加速。
exec docker run --rm -v "$PWD":/repo -w /repo \
  -v potools-build:/build \
  -v potools-target:/build/apps/desktop/src-tauri/target \
  -v potools-pnpm-store:/root/.local/share/pnpm/store \
  -v potools-cargo-registry:/root/.cargo/registry \
  "$IMAGE" bash scripts/build-linux-in-docker.sh
