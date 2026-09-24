use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=POTOOLS_NODE_EMBED_SDK");
    println!("cargo:rerun-if-env-changed=POTOOLS_ENGINE_BUNDLE");
    println!("cargo:rerun-if-env-changed=POTOOLS_WIN_MSVC_SYSROOT");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");

    if env::var_os("CARGO_FEATURE_NODE_EMBED").is_some() {
        build_node_embed();
    }

    tauri_build::build()
}

fn build_node_embed() {
    verify_embedded_config();
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        panic!("the node-embed feature currently requires a Windows MSVC target");
    }

    let sdk = PathBuf::from(env::var_os("POTOOLS_NODE_EMBED_SDK").unwrap_or_else(|| {
        panic!("node-embed requires POTOOLS_NODE_EMBED_SDK pointing to a prepared static Node SDK")
    }));
    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let bundle = PathBuf::from(env::var_os("POTOOLS_ENGINE_BUNDLE").unwrap_or_else(|| {
        panic!("node-embed requires POTOOLS_ENGINE_BUNDLE pointing to engine-embedded.cjs")
    }));
    if !bundle.is_file() {
        panic!(
            "embedded engine bundle does not exist: {}",
            bundle.display()
        );
    }

    let include_dirs = [
        sdk.join("include/node"),
        sdk.join("include/v8"),
        sdk.join("include/generated"),
    ];
    for include in &include_dirs {
        if !include.is_dir() {
            panic!(
                "Node embed SDK is missing include directory: {}",
                include.display()
            );
        }
    }
    let lib_dir = sdk.join("lib");
    let link_manifest = sdk.join("link-libraries.txt");
    track_tree(&sdk);
    let sdk_target = read_required(&sdk.join("target.txt"));
    let node_version = read_required(&sdk.join("node-version.txt"));
    let expected_node_version = match target.as_str() {
        "x86_64-pc-windows-msvc" => "22.20.0",
        "i686-pc-windows-msvc" => "20.20.2",
        _ => panic!("node-embed does not support target {target}"),
    };
    if sdk_target != target {
        panic!("Node embed SDK target {sdk_target} does not match Cargo target {target}");
    }
    if node_version != expected_node_version {
        panic!("Node embed SDK has Node {node_version}; {target} requires Node {expected_node_version}");
    }
    if !lib_dir.is_dir() || !link_manifest.is_file() {
        panic!(
            "Node embed SDK must contain lib/ and link-libraries.txt: {}",
            sdk.display()
        );
    }
    verify_sdk_metadata(&sdk, &target, expected_node_version, &link_manifest);

    println!(
        "cargo:rerun-if-changed={}",
        sdk.join("target.txt").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        sdk.join("node-version.txt").display()
    );
    println!("cargo:rerun-if-changed={}", bundle.display());
    println!("cargo:rerun-if-changed={}", link_manifest.display());
    println!("cargo:rustc-env=POTOOLS_ENGINE_BUNDLE={}", bundle.display());

    let mut cpp = cc::Build::new();
    cpp.cpp(true)
        .std("c++20")
        .file("native/node_embed.cpp")
        .includes(include_dirs)
        .define("NODE_WANT_INTERNALS", "1")
        .warnings(false);
    // MSVC 风格驱动用 /EHsc + 静态 CRT；交叉编译的 GNU 风格 clang 需显式对齐
    // Node SDK 静态库的 MT_StaticRelease 运行时标记（Rust msvc target 默认 crt-static）
    if cpp.get_compiler().is_like_msvc() {
        cpp.flag("/EHsc").static_crt(true);
    } else {
        cpp.flag("-fexceptions")
            .flag("-fms-runtime-lib=static_lib")
            .define("_MT", None);
    }
    if let Some(sysroot) = env::var_os("POTOOLS_WIN_MSVC_SYSROOT") {
        let sysroot = PathBuf::from(sysroot);
        let standard_headers = sysroot.join("include/c++/msstl");
        let windows_headers = sysroot.join("include");
        for include in [&standard_headers, &windows_headers] {
            if !include.is_dir() {
                panic!(
                    "Windows MSVC sysroot is missing headers: {}",
                    include.display()
                );
            }
            cpp.include(include);
        }
        println!("cargo:rerun-if-changed={}", standard_headers.display());
        println!("cargo:rerun-if-changed={}", windows_headers.display());
    }
    cpp.compile("potools_node_embed_bridge");
    println!("cargo:rerun-if-changed=native/node_embed.cpp");

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    link_node_libraries(&link_manifest, &lib_dir);
}

fn verify_embedded_config() {
    let raw = env::var("TAURI_CONFIG")
        .expect("node-embed requires the Windows embedded Tauri config override");
    let config: serde_json::Value =
        serde_json::from_str(&raw).expect("TAURI_CONFIG is not valid JSON");
    let no_resources = config
        .pointer("/bundle/resources")
        .and_then(serde_json::Value::as_array)
        .is_some_and(Vec::is_empty);
    if !no_resources {
        panic!("node-embed requires bundle.resources=[] so no engine sidecar is packaged");
    }
    let build_command = config
        .pointer("/build/beforeBuildCommand")
        .and_then(serde_json::Value::as_str);
    if build_command != Some("pnpm --filter @potools/desktop build") {
        panic!("node-embed must build the frontend without preparing a sidecar runtime");
    }
}

fn verify_sdk_metadata(sdk: &Path, target: &str, node_version: &str, manifest: &Path) {
    let metadata_path = sdk.join("build-metadata.json");
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(&metadata_path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", metadata_path.display())),
    )
    .unwrap_or_else(|error| panic!("invalid {}: {error}", metadata_path.display()));
    let architecture = if target == "x86_64-pc-windows-msvc" {
        "x64"
    } else {
        "x86"
    };
    if metadata["schemaVersion"].as_u64() != Some(1)
        || metadata["cargoTarget"].as_str() != Some(target)
        || metadata["nodeVersion"].as_str() != Some(node_version)
        || metadata["architecture"].as_str() != Some(architecture)
    {
        panic!(
            "{} metadata does not match target {target} and Node {node_version}",
            metadata_path.display()
        );
    }

    let manifest_hash = hash_file(manifest);
    if metadata["manifestSha256"].as_str() != Some(manifest_hash.as_str()) {
        panic!("{} hash does not match SDK metadata", manifest.display());
    }

    let declared = metadata["libraries"]
        .as_array()
        .unwrap_or_else(|| panic!("{} has no libraries array", metadata_path.display()));
    let mut metadata_entries = std::collections::HashSet::new();
    for entry in declared {
        let kind = entry["kind"].as_str().unwrap_or_default();
        let name = entry["name"].as_str().unwrap_or_default();
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || !metadata_entries.insert((kind.to_string(), name.to_string()))
        {
            panic!(
                "{} contains an invalid or duplicate library entry",
                metadata_path.display()
            );
        }
        if matches!(kind, "static" | "whole") {
            let library_path = sdk.join("lib").join(format!("{name}.lib"));
            let expected_hash = entry["fileSha256"].as_str().unwrap_or_default();
            if expected_hash.len() != 64 || hash_file(&library_path) != expected_hash {
                panic!(
                    "{} is missing or its SHA-256 does not match SDK metadata",
                    library_path.display()
                );
            }
        } else if kind != "system" {
            panic!(
                "{} has an unsupported library kind '{kind}'",
                metadata_path.display()
            );
        }
    }

    let manifest_entries = fs::read_to_string(manifest)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", manifest.display()))
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let (kind, name) = line.split_once(' ').unwrap_or_else(|| {
                panic!("{} contains an invalid entry: {line}", manifest.display())
            });
            (kind.to_string(), name.trim().to_string())
        })
        .collect::<std::collections::HashSet<_>>();
    if manifest_entries != metadata_entries {
        panic!("{} entries do not match SDK metadata", manifest.display());
    }
}

fn hash_file(path: &Path) -> String {
    let mut file = fs::File::open(path)
        .unwrap_or_else(|error| panic!("cannot open {}: {error}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .unwrap_or_else(|error| panic!("cannot hash {}: {error}", path.display()));
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    format!("{:x}", hasher.finalize())
}

fn track_tree(root: &Path) {
    println!("cargo:rerun-if-changed={}", root.display());
    let entries = fs::read_dir(root)
        .unwrap_or_else(|error| panic!("cannot read SDK directory {}: {error}", root.display()));
    for entry in entries {
        let path = entry
            .unwrap_or_else(|error| panic!("cannot read SDK entry in {}: {error}", root.display()))
            .path();
        if path.is_dir() {
            track_tree(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn read_required(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
        .trim()
        .to_string()
}

fn link_node_libraries(manifest: &Path, lib_dir: &Path) {
    let content = fs::read_to_string(manifest)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", manifest.display()));
    let mut has_whole_libnode = false;
    for (line_number, raw_line) in content.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (kind, name) = line.split_once(' ').unwrap_or_else(|| {
            panic!(
                "{}:{} must be '<static|whole|system> <name>'",
                manifest.display(),
                line_number + 1
            )
        });
        let name = name.trim();
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            panic!(
                "{}:{} has invalid library name",
                manifest.display(),
                line_number + 1
            );
        }
        match kind {
            "static" => println!("cargo:rustc-link-lib=static={name}"),
            "whole" => {
                has_whole_libnode |= name == "libnode";
                let library = lib_dir.join(format!("{name}.lib"));
                if !library.is_file() {
                    panic!(
                        "Node embed SDK is missing static library: {}",
                        library.display()
                    );
                }
                println!("cargo:rustc-link-arg=/WHOLEARCHIVE:{}", library.display());
            }
            "system" => println!("cargo:rustc-link-lib={name}"),
            _ => panic!(
                "{}:{} has unsupported library kind '{kind}'",
                manifest.display(),
                line_number + 1
            ),
        }
    }
    if !has_whole_libnode {
        panic!(
            "{} must whole-archive the official static libnode target; an empty or partial manifest is not a valid Node embed SDK",
            manifest.display()
        );
    }
}
