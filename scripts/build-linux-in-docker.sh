#!/usr/bin/env bash
# Worker-only 迁移阶段 10：Debian 12 容器内 Linux x64 全量打包。
# 依赖：仓库挂载在 /repo（读写）。apt/Node/rustup/npm 全部走国内镜像，
# crates 走仓库自带的 rsproxy 配置（apps/desktop/.cargo/config.toml）。
# 既可在 potools-builder:latest（工具链已预装，跳过 1-4 步）也可在
# 裸 debian:bookworm 中运行。
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if command -v cargo >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  echo "=== 使用预装工具链（potools-builder 镜像）==="
  source "$HOME/.cargo/env" 2>/dev/null || true
  # pnpm 12 不读 npm_config_registry 环境变量，必须落 .npmrc
  grep -q npmmirror /root/.npmrc 2>/dev/null || \
    printf 'registry=https://registry.npmmirror.com\n' > /root/.npmrc
else

# 1. apt 换 TUNA 镜像（debian:bookworm 默认国际源在国内极慢）
cat > /etc/apt/sources.list <<'SOURCES'
deb http://mirrors.tuna.tsinghua.edu.cn/debian/ bookworm main contrib non-free non-free-firmware
deb http://mirrors.tuna.tsinghua.edu.cn/debian/ bookworm-updates main contrib non-free non-free-firmware
deb http://mirrors.tuna.tsinghua.edu.cn/debian-security/ bookworm-security main contrib non-free non-free-firmware
SOURCES

apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg build-essential file pkg-config xz-utils \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libxdo-dev \
  git python3 >/dev/null

# 2. Node 20（npmmirror 二进制分发，免 nodesource 国际源）
NODE_VERSION=v20.19.5
curl -fsSL -o /tmp/node.tar.xz "https://npmmirror.com/mirrors/node/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
mkdir -p /usr/local/lib/nodejs
tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1
ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
ln -sf /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
export PATH="/usr/local/lib/nodejs/bin:$PATH"

# 3. pnpm：直接 npm 安装（corepack 自带密钥环过旧，验签 pnpm 元数据必失败）
#    registry 必须写入 /root/.npmrc——pnpm 12 不读 npm_config_registry 环境变量
export npm_config_registry=https://registry.npmmirror.com
npm install -g pnpm@12.5.1 >/dev/null
printf 'registry=https://registry.npmmirror.com\n' > /root/.npmrc

# 4. Rust stable（rustup 走 rsproxy）
export RUSTUP_DIST_SERVER=https://rsproxy.cn
export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh | sh -s -- -y --default-toolchain stable --profile minimal >/dev/null
source "$HOME/.cargo/env"

fi

# 5. 构建挪到容器内部文件系统 /build：Docker Desktop for Mac 的绑定挂载上，
#    linuxdeploy 往 AppDir 拷贝系统库会 Permission denied（deb/rpm 不受影响，
#    但统一在 /build 构建最稳）。target 随仓库一起复制，保留 cargo 编译缓存。
BUILD=/build
mkdir -p "$BUILD"
tar -C /repo \
  --exclude=./.git \
  --exclude=./node_modules \
  --exclude=./apps/web/node_modules \
  --exclude=./packages/core/node_modules \
  --exclude=./packages/engine/node_modules \
  --exclude=./release \
  --exclude=./apps/desktop/target \
  -cf - . | tar -C "$BUILD" -xf -

cd "$BUILD"
pnpm install --frozen-lockfile

# 6. AppImage 工具在容器内以解包方式运行（无 FUSE）
export APPIMAGE_EXTRACT_AND_RUN=1

# 7. 预下载 AppImage 打包工具到 tauri 缓存（GitHub 直连在国内近乎停滞）
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$CACHE"
fetch_gh() { # fetch_gh <github-url> <dest>
  local url="$1" dest="$2" ok=0
  for base in "https://gh-proxy.com/" "https://ghfast.top/" "https://ghproxy.net/" ""; do
    if curl -fsSL --connect-timeout 15 --max-time 300 -o "$dest.part" "${base}${url}"; then
      mv "$dest.part" "$dest"; ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { echo "无法下载 $url"; exit 1; }
}
# 缓存文件名与 tauri-bundler prepare_tools 严格一致（多一个架构后缀都不行）
[ -s "$CACHE/AppRun-x86_64" ] || fetch_gh "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64" "$CACHE/AppRun-x86_64"
[ -s "$CACHE/linuxdeploy-x86_64.AppImage" ] || fetch_gh "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage" "$CACHE/linuxdeploy-x86_64.AppImage"
[ -s "$CACHE/linuxdeploy-plugin-gtk.sh" ] || fetch_gh "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh" "$CACHE/linuxdeploy-plugin-gtk.sh"
[ -s "$CACHE/linuxdeploy-plugin-gstreamer.sh" ] || fetch_gh "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh" "$CACHE/linuxdeploy-plugin-gstreamer.sh"
[ -s "$CACHE/linuxdeploy-plugin-appimage.AppImage" ] || fetch_gh "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage" "$CACHE/linuxdeploy-plugin-appimage.AppImage"
chmod +x "$CACHE/AppRun-x86_64" "$CACHE/linuxdeploy-x86_64.AppImage" "$CACHE/linuxdeploy-plugin-appimage.AppImage"
# linuxdeploy 靠 PATH 找 linuxdeploy-plugin-*（extract-and-run 模式下同目录发现失效）
export PATH="$CACHE:$PATH"

rm -rf "$BUILD/apps/desktop/target/x86_64-unknown-linux-gnu/release/bundle"
pnpm tauri build ${POTOOLS_TAURI_VERBOSE:+--verbose} --bundles "${BUNDLES:-deb,rpm,appimage}" --target x86_64-unknown-linux-gnu

# 8. 产物拷回挂载目录，再按标准路径收集
BUNDLE="$BUILD/apps/desktop/target/x86_64-unknown-linux-gnu/release/bundle"
DEST="/repo/apps/desktop/target/x86_64-unknown-linux-gnu/release/bundle"
mkdir -p "$DEST/deb" "$DEST/rpm" "$DEST/appimage"
cp -f "$BUNDLE"/deb/*.deb "$DEST/deb/" 2>/dev/null || true
cp -f "$BUNDLE"/rpm/*.rpm "$DEST/rpm/" 2>/dev/null || true
cp -f "$BUNDLE"/appimage/*.AppImage "$DEST/appimage/" 2>/dev/null || true

cd /repo
node scripts/collect-release-artifacts.mjs linux x64
echo "=== Linux x64 打包完成 ==="
ls -la /repo/release/Linux/
