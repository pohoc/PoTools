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
# 宿主代理的 fake-ip DNS 会接管一切域名解析，且其 http:80 出口时好时坏——
# 用国内公共 DNS 直查真实 IP 钉进容器，所有镜像下载直连国内，代理插不上手。
# mirrors.tuna.tsinghua.edu.cn 的真实 IP（CERNET）——fake-ip 模式下任何 DNS
# 查询都被宿主代理劫持成 198.18.x.x，只能静态钉。
ADDHOSTS=(--add-host 'mirrors.tuna.tsinghua.edu.cn:101.6.15.130')

exec docker run --rm -v "$PWD":/repo -w /repo \
  -e POTOLS_BUILD_STAMP \
  -e http_proxy -e https_proxy -e no_proxy \
  "${ADDHOSTS[@]}" \
  -v potools-build:/build \
  -v potools-target:/build/apps/desktop/target \
  -v potools-pnpm-store:/root/.local/share/pnpm/store \
  -v potools-cargo-registry:/root/.cargo/registry \
  "$IMAGE" bash scripts/build-linux-in-docker.sh
