#include <node.h>
#include <libplatform/libplatform.h>
#include <v8.h>

#include <cstdio>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace {

int RunNodeInstance(
    node::MultiIsolatePlatform* platform,
    const std::vector<std::string>& node_args,
    const std::vector<std::string>& exec_args,
    const char* executable,
    const char* const* engine_args,
    size_t engine_argc,
    const unsigned char* bundle,
    size_t bundle_size) {
  int exit_code = 0;
  std::vector<std::string> errors;
  std::unique_ptr<node::CommonEnvironmentSetup> setup =
      node::CommonEnvironmentSetup::Create(platform, &errors, node_args, exec_args);
  if (!setup) {
    for (const std::string& error : errors) {
      std::fprintf(stderr, "PoTools Node embedder: %s\n", error.c_str());
    }
    return 1;
  }

  v8::Isolate* isolate = setup->isolate();
  v8::Local<v8::Context> context = setup->context();
  {
    v8::Locker locker(isolate);
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handle_scope(isolate);
    v8::Context::Scope context_scope(context);

    v8::Local<v8::String> source;
    if (!v8::String::NewFromUtf8(
             isolate,
             reinterpret_cast<const char*>(bundle),
             v8::NewStringType::kNormal,
             static_cast<int>(bundle_size))
             .ToLocal(&source)) {
      std::fprintf(stderr, "PoTools Node embedder: could not create engine source string\n");
      return 1;
    }

    v8::Local<v8::Array> argv = v8::Array::New(isolate, static_cast<int>(engine_argc + 2));
    auto set_arg = [&](uint32_t index, const char* value) {
      v8::Local<v8::String> text;
      if (!v8::String::NewFromUtf8(isolate, value, v8::NewStringType::kNormal).ToLocal(&text)) {
        return false;
      }
      return argv->Set(context, index, text).FromMaybe(false);
    };
    if (!set_arg(0, executable) || !set_arg(1, "engine-embedded.cjs")) {
      std::fprintf(stderr, "PoTools Node embedder: could not initialize engine argv\n");
      return 1;
    }
    for (size_t index = 0; index < engine_argc; ++index) {
      if (!set_arg(static_cast<uint32_t>(index + 2), engine_args[index])) {
        std::fprintf(stderr, "PoTools Node embedder: could not initialize engine argv\n");
        return 1;
      }
    }

    v8::Local<v8::Object> global = context->Global();
    v8::Local<v8::String> argv_key = v8::String::NewFromUtf8Literal(isolate, "__potoolsEngineArgv");
    v8::Local<v8::String> source_key = v8::String::NewFromUtf8Literal(isolate, "__potoolsEngineSource");
    if (!global->Set(context, argv_key, argv).FromMaybe(false) ||
        !global->Set(context, source_key, source).FromMaybe(false)) {
      std::fprintf(stderr, "PoTools Node embedder: could not initialize engine globals\n");
      return 1;
    }

    const char* bootstrap =
        "process.argv = globalThis.__potoolsEngineArgv;"
        "const { Module } = require('node:module');"
        "const entry = new Module(process.argv[1]);"
        "entry.filename = process.argv[1];"
        "entry.paths = Module._nodeModulePaths(process.cwd());"
        "entry._compile(globalThis.__potoolsEngineSource, process.argv[1]);";
    if (node::LoadEnvironment(setup->env(), bootstrap).IsEmpty()) {
      std::fprintf(stderr, "PoTools Node embedder: engine bundle failed during startup\n");
      return 1;
    }
    exit_code = node::SpinEventLoop(setup->env()).FromMaybe(1);
    node::Stop(setup->env());
  }
  return exit_code;
}

}  // namespace

extern "C" int potools_run_embedded_node(
    const char* executable,
    const char* const* engine_args,
    size_t engine_argc,
    const unsigned char* bundle,
    size_t bundle_size) {
  if (executable == nullptr || bundle == nullptr || bundle_size == 0) {
    std::fprintf(stderr, "PoTools Node embedder POTOOLS_NODE_EMBED_RUNTIME_V1: invalid engine bootstrap input\n");
    return 1;
  }
  if (bundle_size > static_cast<size_t>(std::numeric_limits<int>::max()) ||
      engine_argc > static_cast<size_t>(std::numeric_limits<int>::max() - 2)) {
    std::fprintf(stderr, "PoTools Node embedder: engine bootstrap input is too large\n");
    return 1;
  }

  std::vector<std::string> node_args{executable};
  node_args.emplace_back("--max-old-space-size=768");
  auto initialization = node::InitializeOncePerProcess(node_args, {
          node::ProcessInitializationFlags::kNoInitializeV8,
          node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
      });
  for (const std::string& error : initialization->errors()) {
    std::fprintf(stderr, "PoTools Node embedder: %s\n", error.c_str());
  }
  if (initialization->early_return() != 0) {
    const int code = initialization->exit_code();
    node::TearDownOncePerProcess();
    return code;
  }

  std::unique_ptr<node::MultiIsolatePlatform> platform = node::MultiIsolatePlatform::Create(4);
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();
  const int exit_code = RunNodeInstance(
      platform.get(),
      initialization->args(),
      initialization->exec_args(),
      executable,
      engine_args,
      engine_argc,
      bundle,
      bundle_size);
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
  return exit_code;
}
