#!/usr/bin/env bash
# 授权 Docker Desktop 后，在仓库根目录运行本脚本即完成 Linux x64 打包：
#   ./scripts/run-linux-build.sh
# 产物输出到 release/Linux/（deb/rpm/appimage）。
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker run --rm -v "$PWD":/repo -w /repo debian:bookworm bash scripts/build-linux-in-docker.sh
