[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('x64', 'x86')]
    [string] $Architecture,

    [Parameter(Mandatory = $true)]
    [string] $NodeSourceRoot,

    [Parameter(Mandatory = $true)]
    [string] $OutputRoot
)

$ErrorActionPreference = 'Stop'
$NodeVersion = if ($Architecture -eq 'x64') { '22.20.0' } else { '20.20.2' }
$NodeTagCommit = if ($Architecture -eq 'x64') { 'caa20e28dc1f21a97f7b2a7134973fd6435b65f0' } else { '3626fea570e44896ad99aaf3bf6e59def5adede5' }
$StructuredLoggerVersion = '2.3.246'
$Target = if ($Architecture -eq 'x64') { 'x86_64-pc-windows-msvc' } else { 'i686-pc-windows-msvc' }

function Resolve-ExistingDirectory([string] $Path, [string] $Label) {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$Label is not a directory: $Path"
    }
    return $resolved
}

if ($env:OS -ne 'Windows_NT') { throw 'This SDK builder must run in Windows PowerShell or PowerShell 7 on Windows.' }
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'git.exe is required.' }
if (-not (Get-Command dotnet.exe -ErrorAction SilentlyContinue)) { throw '.NET 8 SDK (dotnet.exe) is required to run the pinned binlog exporter.' }
$installedSdks = (& dotnet.exe --list-sdks 2>$null | Out-String)
if ($LASTEXITCODE -ne 0 -or $installedSdks -notmatch '(?m)^8\.') { throw '.NET 8 SDK is required to run the pinned binlog exporter.' }

$source = Resolve-ExistingDirectory $NodeSourceRoot 'NodeSourceRoot'
$output = [System.IO.Path]::GetFullPath($OutputRoot)
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Node source does not exist: $source" }

# A build starts from the exact immutable Node release tag in a pristine clone.
$head = (& git.exe -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to read Node source Git revision.' }
if ($head -ne $NodeTagCommit) { throw "Expected Node v$NodeVersion commit $NodeTagCommit; got $head." }
$status = @(& git.exe -C $source status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw 'Node source must be a pristine checkout (git status must be empty).' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'vcbuild.bat') -PathType Leaf)) { throw 'vcbuild.bat is missing from Node source.' }
if (Test-Path -LiteralPath (Join-Path $source 'out')) { throw 'Node source already has out/ build output. Use a fresh pristine source checkout for each architecture.' }

$destination = Join-Path $output $Target
if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite existing SDK: $destination" }
$parent = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$work = Join-Path $parent ('.node-embed-sdk-' + $Target + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$logPath = Join-Path $work 'vcbuild.log'
$binlogPath = Join-Path $source 'out/Release/node.binlog'

try {
    Push-Location $source
    try {
        $archArgument = if ($Architecture -eq 'x64') { 'x64' } else { 'x86' }
        $command = 'call vcbuild.bat release ' + $archArgument + ' vs2022 no-cctest openssl-no-asm binlog > "' + $logPath + '" 2>&1'
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = Join-Path $env:WINDIR 'System32/cmd.exe'
        $start.Arguments = '/d /s /c "' + $command + '"'
        $start.WorkingDirectory = $source
        $start.UseShellExecute = $false
        $process = [System.Diagnostics.Process]::Start($start)
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "vcbuild.bat failed with exit code $($process.ExitCode). Full output retained at $logPath"
        }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $binlogPath -PathType Leaf)) {
        throw "vcbuild reported success but its expected binary log is missing. Build output retained at $logPath"
    }

    # Generate into an unpublished staging directory. Exporter failures never leave a partial SDK.
    $stage = Join-Path $work 'sdk'
    New-Item -ItemType Directory -Path $stage | Out-Null
    $projectDir = Join-Path $work 'exporter'
    New-Item -ItemType Directory -Path $projectDir | Out-Null
    $projectFile = Join-Path $projectDir 'NodeLinkManifestExporter.csproj'
    $projectXml = @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MSBuild.StructuredLogger" Version="$StructuredLoggerVersion" />
    <PackageReference Include="Microsoft.Build.Framework" Version="17.5.0" />
    <PackageReference Include="Microsoft.Build.Utilities.Core" Version="17.5.0" />
    <PackageReference Include="System.Collections.Immutable" Version="8.0.0" />
    <PackageReference Include="System.Memory" Version="4.6.0" />
    <PackageReference Include="System.Runtime.CompilerServices.Unsafe" Version="6.1.0" />
  </ItemGroup>
</Project>
"@
    [System.IO.File]::WriteAllText($projectFile, $projectXml, [System.Text.UTF8Encoding]::new($false))
    $exporterSource = Join-Path $PSScriptRoot 'node-embed-manifest-exporter.cs'
    if (-not (Test-Path -LiteralPath $exporterSource -PathType Leaf)) { throw "Pinned exporter source is missing: $exporterSource" }
    Copy-Item -LiteralPath $exporterSource -Destination (Join-Path $projectDir 'Program.cs')

    $exportLog = Join-Path $work 'exporter.log'
    & dotnet.exe run --project $projectFile --configuration Release -- $binlogPath $source $stage $Target $NodeVersion $Architecture $NodeTagCommit 2>&1 | Tee-Object -FilePath $exportLog
    if ($LASTEXITCODE -ne 0) { throw "Binlog manifest export failed. Full diagnostics retained at $exportLog and $logPath" }

    $required = @(
        'target.txt', 'node-version.txt', 'link-libraries.txt', 'build-metadata.json',
        'include/node/node.h', 'include/v8/v8.h', 'include/generated'
    )
    foreach ($item in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $item))) { throw "Exporter produced an incomplete SDK; missing $item. Diagnostics: $exportLog" }
    }
    if (-not (Get-ChildItem -LiteralPath (Join-Path $stage 'lib') -Filter '*.lib' -File | Select-Object -First 1)) {
        throw "Exporter produced no static libraries. Diagnostics: $exportLog"
    }

    # Rename within the same volume so consumers only see a complete SDK.
    Move-Item -LiteralPath $stage -Destination $destination
    Write-Host "Node $NodeVersion static embed SDK created: $destination"
    Write-Host "Build diagnostics: $logPath"
    Write-Host "Binary log: $binlogPath"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host "Failure diagnostics retained in: $work"
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        Write-Host 'Last 80 vcbuild log lines:'
        Get-Content -LiteralPath $logPath -Tail 80
    }
    throw
}
