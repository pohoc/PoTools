using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Build.Logging.StructuredLogger;
using StructuredTask = Microsoft.Build.Logging.StructuredLogger.Task;

internal static class Program
{
    private const string ExporterVersion = "1.2.0";
    private static readonly HashSet<string> WindowsSystemLibraries = new(StringComparer.OrdinalIgnoreCase)
    {
        "advapi32", "bcrypt", "comctl32", "comdlg32", "crypt32", "dbghelp", "dnsapi",
        "dwmapi", "gdi32", "imm32", "iphlpapi", "kernel32", "libcmt", "libconcrt",
        "libcpmt", "libucrt", "libvcruntime", "mswsock", "netapi32", "ntdll", "normaliz",
        "odbc32", "odbccp32",
        "oldnames", "ole32", "oleaut32", "powrprof", "psapi", "rpcrt4", "secur32",
        "setupapi", "shell32", "shlwapi", "user32", "userenv", "uuid", "version",
        "winhttp", "winmm", "winspool", "wldap32", "ws2_32",
    };
    private static readonly Regex WholeArchive = new(
        """(?:/|-)(?:WHOLEARCHIVE):(?:"(?<quoted>[^"]+)"|(?<bare>[^,;\s]+))""",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private sealed record Library(string Name, string Kind, string? SourcePath, string? Sha256);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 7)
                throw new InvalidOperationException("usage: exporter <binlog> <node-source> <sdk-stage> <cargo-target> <node-version> <architecture> <node-commit>");

            var binlog = Path.GetFullPath(args[0]);
            var source = Path.GetFullPath(args[1]);
            var output = Path.GetFullPath(args[2]);
            var target = args[3];
            var nodeVersion = args[4];
            var architecture = args[5];
            var nodeCommit = args[6];

            RequireFile(binlog, "MSBuild binary log");
            RequireDirectory(source, "Node source");
            RequireDirectory(output, "SDK staging directory");
            if (Directory.EnumerateFileSystemEntries(output).Any())
                throw new InvalidOperationException("SDK staging directory must be empty.");
            var expectedTarget = architecture switch
            {
                "x64" => "x86_64-pc-windows-msvc",
                "x86" => "i686-pc-windows-msvc",
                _ => throw new InvalidOperationException($"Unsupported architecture: {architecture}"),
            };
            var (expectedVersion, expectedCommit) = architecture switch
            {
                "x64" => ("22.20.0", "caa20e28dc1f21a97f7b2a7134973fd6435b65f0"),
                "x86" => ("20.20.2", "3626fea570e44896ad99aaf3bf6e59def5adede5"),
                _ => throw new InvalidOperationException($"Unsupported architecture: {architecture}"),
            };
            if (nodeVersion != expectedVersion)
                throw new InvalidOperationException($"Architecture {architecture} requires Node {expectedVersion}; got {nodeVersion}.");
            if (nodeCommit != expectedCommit)
                throw new InvalidOperationException($"Architecture {architecture} requires Node source commit {expectedCommit}; got {nodeCommit}.");
            if (!string.Equals(target, expectedTarget, StringComparison.Ordinal))
                throw new InvalidOperationException($"Target {target} does not match architecture {architecture}.");

            var build = BinaryLog.ReadBuild(binlog);
            if (build is null || !build.Succeeded)
                throw new InvalidOperationException("MSBuild binlog does not describe a successful build.");

            var nodeProjects = Descendants(build).OfType<Project>()
                .Where(p => IsNodeProject(p.ProjectFile, source))
                .ToArray();
            if (nodeProjects.Length == 0)
                throw new InvalidOperationException("Binlog contains no Node node.vcxproj project; refusing to infer a link closure.");

            var linkTasks = nodeProjects.SelectMany(p => Descendants(p).OfType<Target>())
                .Where(t => string.Equals(t.Name, "Link", StringComparison.OrdinalIgnoreCase) && t.Succeeded)
                .SelectMany(t => Descendants(t).OfType<StructuredTask>())
                .Where(t => string.Equals(t.Name, "Link", StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (linkTasks.Length != 1)
                throw new InvalidOperationException($"Expected exactly one successful Node Link task, found {linkTasks.Length}.");

            var task = linkTasks[0];
            var dependencies = ReadParameterValues(task, "AdditionalDependencies");
            var options = ReadParameterValues(task, "AdditionalOptions");
            var directories = ReadParameterValues(task, "AdditionalLibraryDirectories");
            var allObjects = Directory
                .EnumerateFiles(Path.Combine(source, "out"), "*.obj", SearchOption.AllDirectories)
                .Select(Path.GetFullPath)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var nativeObjects = allObjects.Where(path => IsNativeCoffObject(path, architecture)).ToList();
            var nonNative = allObjects.Except(nativeObjects).ToList();
            Console.WriteLine($"Object scan: {allObjects.Count} total, {nativeObjects.Count} native COFF, {nonNative.Count} excluded.");
            foreach (var sample in nonNative.Take(10))
                Console.WriteLine("  excluded: " + sample);
            var objectFiles = nativeObjects;
            if (dependencies.Count == 0)
                throw new InvalidOperationException("Node Link task has no readable AdditionalDependencies parameter.");
            if (objectFiles.Count == 0)
                throw new InvalidOperationException("Node build tree has no object files; node-only components (crdtp/inspector) would be missing from the SDK.");

            var wholeTokens = new List<string>();
            foreach (var option in options)
            {
                foreach (Match match in WholeArchive.Matches(option))
                    wholeTokens.Add(match.Groups["quoted"].Success ? match.Groups["quoted"].Value : match.Groups["bare"].Value);
                if (option.Contains("WHOLEARCHIVE", StringComparison.OrdinalIgnoreCase) &&
                    !WholeArchive.IsMatch(option))
                    throw new InvalidOperationException($"Cannot parse a WHOLEARCHIVE option reliably: {option}");
            }
            if (wholeTokens.Count == 0)
                throw new InvalidOperationException("Node Link task does not expose a parseable /WHOLEARCHIVE option.");

            var searchDirectories = ResolveSearchDirectories(source, directories);
            var localLibraries = Directory.EnumerateFiles(Path.Combine(source, "out"), "*.lib", SearchOption.AllDirectories)
                .Select(Path.GetFullPath)
                .ToArray();
            var libraries = new List<Library>();
            var copiedByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (var raw in dependencies.SelectMany(SplitList))
            {
                var token = NormalizeLibraryToken(raw);
                if (!token.EndsWith(".lib", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Unrecognized linker dependency (not a .lib file): {raw}");
                var resolved = ResolveLocalLibrary(token, source, searchDirectories, localLibraries);
                if (resolved is null)
                {
                    throw new InvalidOperationException($"Could not resolve linker dependency from the successful Link task: {raw}");
                }
                if (!IsInsideSource(resolved, source))
                {
                    var systemName = Path.GetFileNameWithoutExtension(token);
                    if (string.IsNullOrWhiteSpace(systemName)
                        || !WindowsSystemLibraries.Contains(systemName)
                        || !IsTrustedWindowsLibraryPath(resolved))
                        throw new InvalidOperationException($"Linker dependency resolves outside Node source and is not a verified Windows toolchain library: {raw} -> {resolved}");
                    AddUnique(libraries, new Library(systemName, "system", null, null));
                    continue;
                }

                AddStaticLibrary(libraries, copiedByName, resolved, "static");
            }

            foreach (var raw in wholeTokens)
            {
                var token = NormalizeLibraryToken(raw);
                if (!token.EndsWith(".lib", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Unrecognized /WHOLEARCHIVE target: {raw}");
                var resolved = ResolveLocalLibrary(token, source, searchDirectories, localLibraries);
                if (resolved is null || !IsInsideSource(resolved, source))
                    throw new InvalidOperationException($"/WHOLEARCHIVE target is not a unique Node build library: {raw}");
                AddStaticLibrary(libraries, copiedByName, resolved, "whole");
            }

            // node.exe target links loose objects (crdtp/inspector protocol, node_main) that live in no
            // component .lib; archive them so the SDK can satisfy those symbols without the binlog.
            var libExe = Environment.GetEnvironmentVariable("POTOOLS_LIB_EXE");
            if (string.IsNullOrWhiteSpace(libExe) || !File.Exists(libExe))
                throw new InvalidOperationException("POTOOLS_LIB_EXE must point to the MSVC lib.exe used to archive node.exe link objects.");
            var extrasLibrary = Path.Combine(output, "node_extras.lib");
            ArchiveObjects(libExe, objectFiles, extrasLibrary, architecture);
            AddStaticLibrary(libraries, copiedByName, extrasLibrary, "static");

            // GYP also wires component libraries into node.exe via ProjectReference (v8_compiler,
            // v8_turboshaft, …) which never appear in the Link task's AdditionalDependencies. They
            // are consumed as plain archives after the whole-archive set, so collect them too.
            var componentLibraryDirectory = Path.Combine(source, "out/Release/lib");
            if (Directory.Exists(componentLibraryDirectory))
            {
                foreach (var component in Directory.EnumerateFiles(componentLibraryDirectory, "*.lib")
                             .Select(Path.GetFullPath)
                             .Where(path => !copiedByName.ContainsKey(Path.GetFileName(path)))
                             .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
                {
                    AddStaticLibrary(libraries, copiedByName, component, "static");
                }
            }

            if (!libraries.Any(l => l.Kind == "whole" && string.Equals(l.Name, "libnode", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("The complete manifest does not whole-archive libnode.lib.");
            if (libraries.Count < 2)
                throw new InvalidOperationException("Refusing to write a suspiciously incomplete linker manifest.");

            CopyHeaders(source, output);
            var libDirectory = Path.Combine(output, "lib");
            Directory.CreateDirectory(libDirectory);
            foreach (var pair in copiedByName)
            {
                var destination = Path.Combine(libDirectory, pair.Key);
                File.Copy(pair.Value, destination, overwrite: false);
            }

            var manifestPath = Path.Combine(output, "link-libraries.txt");
            var manifest = new StringBuilder()
                .AppendLine($"# Generated from the successful Node v{nodeVersion} MSBuild Link task binlog.")
                .AppendLine("# Do not edit by hand; rebuild this SDK with scripts/build-node-embed-sdk.ps1.");
            foreach (var library in libraries)
                manifest.Append(library.Kind).Append(' ').AppendLine(library.Name);
            File.WriteAllText(manifestPath, manifest.ToString(), new UTF8Encoding(false));

            File.WriteAllText(Path.Combine(output, "target.txt"), target + "\n", new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(output, "node-version.txt"), nodeVersion + "\n", new UTF8Encoding(false));
            var metadata = new
            {
                schemaVersion = 1,
                exporterVersion = ExporterVersion,
                nodeVersion,
                nodeCommit,
                architecture,
                cargoTarget = target,
                compilerConfiguration = "Release",
                manifestSha256 = Hash(manifestPath),
                binlogSha256 = Hash(binlog),
                libraries = libraries.Select(l => new { l.Name, l.Kind, fileSha256 = l.Sha256 }).ToArray(),
            };
            File.WriteAllText(Path.Combine(output, "build-metadata.json"),
                JsonSerializer.Serialize(metadata, new JsonSerializerOptions
                {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                }) + "\n",
                new UTF8Encoding(false));

            Console.WriteLine($"Exported {libraries.Count} linker entries ({copiedByName.Count} Node static libraries, {objectFiles.Count} link objects archived) for {target}.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Node SDK manifest export failed closed: " + error);
            return 1;
        }
    }

    // NameValueNode（及其子类 Property/TaskParameterProperty）与 TreeNode 平行，都直接派生自 BaseNode；
    // 遍历必须以 BaseNode 为界，否则任务参数属性节点根本不可见。
    private static IEnumerable<BaseNode> Descendants(BaseNode node)
    {
        if (node is TreeNode { HasChildren: true } parent)
        {
            foreach (var child in parent.Children.OfType<BaseNode>())
            {
                yield return child;
                foreach (var descendant in Descendants(child))
                    yield return descendant;
            }
        }
    }

    private static bool IsNodeProject(string? projectFile, string source)
    {
        if (string.IsNullOrWhiteSpace(projectFile) || !string.Equals(Path.GetFileName(projectFile), "node.vcxproj", StringComparison.OrdinalIgnoreCase))
            return false;
        var fullPath = Path.GetFullPath(projectFile);
        var root = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    private static List<string> ReadParameterValues(StructuredTask task, string parameterName)
    {
        var values = new List<string>();
        foreach (var node in Descendants(task))
        {
            var name = node switch
            {
                TaskParameterProperty property when string.Equals(property.ParameterName, parameterName, StringComparison.OrdinalIgnoreCase) => property.Name,
                Parameter parameter when string.Equals(parameter.ParameterName, parameterName, StringComparison.OrdinalIgnoreCase) => parameter.Name,
                TaskParameterItem item when string.Equals(item.ParameterName, parameterName, StringComparison.OrdinalIgnoreCase) => item.Name,
                _ => null,
            };
            if (name is not null)
            {
                if (node is NameValueNode nameValue && !string.IsNullOrWhiteSpace(nameValue.Value)) values.Add(nameValue.Value);
                else if (node is TreeNode parent) values.AddRange(parent.Children.OfType<Item>().Select(i => i.Text).Where(s => !string.IsNullOrWhiteSpace(s)));
            }
        }

        // Older MSBuild task-parameter records may omit ParameterName and use the item/parameter name directly.
        if (values.Count == 0)
        {
            foreach (var node in Descendants(task))
            {
                if (node is Parameter parameter && string.Equals(parameter.Name, parameterName, StringComparison.OrdinalIgnoreCase))
                    values.AddRange(parameter.Children.OfType<Item>().Select(i => i.Text).Where(s => !string.IsNullOrWhiteSpace(s)));
                else if (node is NameValueNode property && string.Equals(property.Name, parameterName, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(property.Value))
                    values.Add(property.Value);
            }
        }
        return values;
    }

    private static IEnumerable<string> SplitList(string value)
    {
        foreach (var part in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var item = part.Trim().Trim('"');
            if (item.Length > 0 && item != "%(AdditionalDependencies)") yield return item;
            else if (item == "%(AdditionalDependencies)") throw new InvalidOperationException("Unexpanded %(AdditionalDependencies) in successful Link task.");
        }
    }

    private static string NormalizeLibraryToken(string token)
    {
        var value = token.Trim().Trim('"');
        if (value.Length == 0 || value.Contains('$') || value.Contains('%') || value.StartsWith('@'))
            throw new InvalidOperationException($"Unexpanded or opaque library token: {token}");
        return value.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
    }

    private static List<string> ResolveSearchDirectories(string source, IEnumerable<string> values)
    {
        var result = new List<string> { Path.Combine(source, "out/Release/lib"), Path.Combine(source, "out/Release") };
        var environmentLibraryPaths = (Environment.GetEnvironmentVariable("LIB") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var value in values.Concat(environmentLibraryPaths).SelectMany(SplitList))
        {
            var item = value.Trim().Trim('"');
            if (item.Contains('$') || item.Contains('%')) continue;
            var path = Path.IsPathRooted(item) ? item : Path.Combine(source, item);
            if (Directory.Exists(path)) result.Add(Path.GetFullPath(path));
        }
        return result.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static string? ResolveLocalLibrary(string token, string source, List<string> searchDirectories, string[] localLibraries)
    {
        var candidate = Path.IsPathRooted(token) ? Path.GetFullPath(token) : null;
        if (candidate is not null && File.Exists(candidate))
            return candidate;

        var fileName = Path.GetFileName(token);
        var exact = localLibraries.Where(path => string.Equals(Path.GetFileName(path), fileName, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (exact.Length > 1)
            throw new InvalidOperationException($"Ambiguous Node build library '{fileName}' has {exact.Length} candidates: {string.Join(" | ", exact)}");
        if (exact.Length == 1) return exact[0];

        var fromSearch = searchDirectories.Select(path => Path.Combine(path, fileName)).Where(File.Exists).Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (fromSearch.Length > 1)
            throw new InvalidOperationException($"Ambiguous linker library '{fileName}': {string.Join(" | ", fromSearch)}");
        return fromSearch.Length == 1 ? fromSearch[0] : null;
    }

    private static bool IsInsideSource(string path, string source)
    {
        return IsWithinDirectory(path, source);
    }

    private static bool IsTrustedWindowsLibraryPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var trustedRoots = new[]
        {
            Environment.GetEnvironmentVariable("WindowsSdkDir"),
            Environment.GetEnvironmentVariable("VCToolsInstallDir"),
        }.Where(root => !string.IsNullOrWhiteSpace(root));
        if (trustedRoots.Any(root => IsWithinDirectory(fullPath, root!))) return true;

        var normalized = fullPath.Replace('/', '\\');
        return (normalized.Contains("\\Windows Kits\\", StringComparison.OrdinalIgnoreCase)
                && normalized.Contains("\\Lib\\", StringComparison.OrdinalIgnoreCase))
            || (normalized.Contains("\\VC\\Tools\\MSVC\\", StringComparison.OrdinalIgnoreCase)
                && normalized.Contains("\\lib\\", StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsWithinDirectory(string path, string directory)
    {
        var root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        return Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    private static void AddStaticLibrary(List<Library> libraries, Dictionary<string, string> copiedByName, string path, string kind)
    {
        var fileName = Path.GetFileName(path);
        var name = Path.GetFileNameWithoutExtension(fileName);
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidOperationException($"Invalid static library name: {path}");
        if (copiedByName.TryGetValue(fileName, out var existing) && !string.Equals(existing, path, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"Two project libraries map to SDK/lib/{fileName}: {existing} and {path}");
        copiedByName[fileName] = path;
        var prior = libraries.FindIndex(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
        var library = new Library(name, kind, path, Hash(path));
        if (prior >= 0)
        {
            if (libraries[prior].SourcePath is not null && !string.Equals(libraries[prior].SourcePath, path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Conflicting manifest entries for {name}.");
            if (kind == "whole") libraries[prior] = library;
            return;
        }
        libraries.Add(library);
    }

    private static void AddUnique(List<Library> libraries, Library library)
    {
        var index = libraries.FindIndex(l => string.Equals(l.Name, library.Name, StringComparison.OrdinalIgnoreCase));
        if (index < 0) libraries.Add(library);
        else if (libraries[index].Kind != "system") throw new InvalidOperationException($"Library {library.Name} resolves both locally and as a system dependency.");
    }

    private static void CopyHeaders(string source, string output)
    {
        var nodeHeaders = Path.Combine(source, "src");
        var v8Headers = Path.Combine(source, "deps/v8/include");
        // GYP 的 ninja/make 后端生成树在 obj/gen；Windows vcbuild 的 msvs 后端在 obj/global_intermediate。
        var generatedHeaders = new[]
        {
            Path.Combine(source, "out/Release/obj/gen"),
            Path.Combine(source, "out/Release/obj/global_intermediate"),
        }.FirstOrDefault(Directory.Exists);
        RequireDirectory(nodeHeaders, "Node headers (src)");
        RequireDirectory(v8Headers, "V8 headers");
        if (generatedHeaders is null)
            throw new DirectoryNotFoundException("Missing generated Node headers: checked out/Release/obj/gen and out/Release/obj/global_intermediate.");
        CopyHeaderTree(nodeHeaders, Path.Combine(output, "include/node"));
        CopyHeaderTree(v8Headers, Path.Combine(output, "include/v8"));
        CopyHeaderTree(generatedHeaders, Path.Combine(output, "include/generated"));
        RequireFile(Path.Combine(output, "include/node/node.h"), "staged node.h");
        RequireFile(Path.Combine(output, "include/v8/v8.h"), "staged v8.h");
    }

    private static void CopyHeaderTree(string source, string destination)
    {
        var copied = 0;
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories)
                     .Where(path => new[] { ".h", ".hpp", ".inc", ".def" }.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase)))
        {
            var relative = Path.GetRelativePath(source, file);
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: false);
            copied++;
        }
        if (copied == 0) throw new InvalidOperationException($"No C/C++ headers found under {source}");
    }

    // /GL（全程序优化）对象是 LTCG 中间格式而非原生 COFF，lib.exe 可以归档但 lld-link 无法消费；
    // 其符号已由 whole-archive 的组件库提供，这里按 COFF 机器号过滤掉。
    // /bigobj 对象是合法 COFF 变体（0x0+0xFFFF 签名，machine 位于 offset 20），lld-link 支持消费。
    private static bool IsNativeCoffObject(string path, string architecture)
    {
        var expected = architecture switch
        {
            "x64" => 0x8664,
            "x86" => 0x14C,
            _ => throw new InvalidOperationException($"Unsupported architecture: {architecture}"),
        };
        var bytes = new byte[22];
        using var stream = File.OpenRead(path);
        if (stream.Read(bytes, 0, bytes.Length) < bytes.Length) return false;
        var machine = BitConverter.ToUInt16(bytes, 0) == 0 && BitConverter.ToUInt16(bytes, 4) == 0xFFFF
            ? BitConverter.ToUInt16(bytes, 20)   // bigobj
            : BitConverter.ToUInt16(bytes, 0);   // 标准 COFF
        return machine == expected;
    }

    private static void ArchiveObjects(string libExe, List<string> objectFiles, string outputLibrary, string architecture)
    {
        var machine = architecture switch
        {
            "x64" => "X64",
            "x86" => "X86",
            _ => throw new InvalidOperationException($"Unsupported architecture: {architecture}"),
        };
        var responseFile = Path.Combine(Path.GetTempPath(), $"node-embed-obj-{Guid.NewGuid():N}.rsp");
        try
        {
            File.WriteAllLines(responseFile, objectFiles.Select(path => '"' + path + '"'));
            var info = new System.Diagnostics.ProcessStartInfo
            {
                FileName = libExe,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                Arguments = $"/MACHINE:{machine} /OUT:\"" + outputLibrary + "\" @\"" + responseFile + "\"",
            };
            using var process = System.Diagnostics.Process.Start(info)!;
            var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                var tail = output.Length > 3000 ? output[^3000..] : output;
                throw new InvalidOperationException($"lib.exe failed to archive {objectFiles.Count} node link objects: {tail}");
            }
            RequireFile(outputLibrary, "archived node_extras.lib");
        }
        finally
        {
            File.Delete(responseFile);
        }
    }

    private static string Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void RequireFile(string path, string label)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"Missing {label}: {path}", path);
    }

    private static void RequireDirectory(string path, string label)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"Missing {label}: {path}");
    }
}
