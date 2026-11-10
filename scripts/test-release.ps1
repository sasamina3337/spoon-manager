param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$Root
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$version = (Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json).version
$name = "SpoonManager-$version-win64"
$zipPath = Join-Path $ProjectRoot "dist/releases/$name.zip"
$installer = Join-Path $ProjectRoot "dist/installers/$name-Setup.exe"
if (!(Test-Path -LiteralPath $zipPath) -or !(Test-Path -LiteralPath $installer)) {
    Write-Output 'Release artifacts are not built; build the Release configuration first.'
    exit 77
}
$runPath = Join-Path ([IO.Path]::GetFullPath($Root)) ('run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $runPath | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $prefix = "$name/"
    $payloadRoot = Join-Path $ProjectRoot '.local/build/windows-release/installer-stage'
    $expected = @(Get-ChildItem -LiteralPath $payloadRoot -Recurse -File | ForEach-Object {
        $_.FullName.Substring($payloadRoot.Length + 1).Replace('\', '/')
    })
    $actual = @()
    foreach ($entry in $zip.Entries) {
        if (!$entry.FullName.StartsWith($prefix, [StringComparison]::Ordinal) -or $entry.FullName.Contains('..') -or $entry.FullName.Contains('\')) {
            throw 'Unexpected ZIP path.'
        }
        if ($entry.FullName.EndsWith('/')) { continue }
        $relative = $entry.FullName.Substring($prefix.Length)
        if ($relative -match '(^|/)(\.env[^/]*|connection\.json|state\.json|tokens\.json|node_modules|test-data)(/|$)|\.(pdb|obj|lib|log|pem|key|pfx|p12|dmp)$' -or
            $relative -match '(^|/)(msvcp|vcruntime|concrt)[0-9_]+d[^/]*\.dll$' -or
            $relative -notmatch '^(SpoonManager\.exe|cloudflared\.exe|LICENSE|[^/]+\.dll|ui/.+|licenses/.+|documentation/.+)$') {
            throw "Private, Debug or unexpected ZIP file: $relative"
        }
        $actual += $relative
        $sourceFile = Join-Path $payloadRoot $relative
        if (!(Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Unexpected payload: $relative" }
        $sha = [Security.Cryptography.SHA256]::Create()
        $stream = $entry.Open()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }
        if ($hash -cne (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash) { throw "ZIP differs from installer payload: $relative" }
    }
    if (@(Compare-Object $expected $actual).Count) { throw 'ZIP and installer payload file lists differ.' }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $runPath)
$portable = Join-Path $runPath $name
foreach ($binary in @((Join-Path $portable 'SpoonManager.exe'), $installer)) {
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($binary).ProductVersion -ne $version) { throw 'Release binary product version does not match package.json.' }
}
if ((Get-FileHash (Join-Path $portable 'cloudflared.exe')).Hash -ne '2493DBC168923BB3E59E5E7716F71DECED92992EEA9ACD6E9D74F84AC7751343') { throw 'Cloudflared checksum mismatch.' }
$modules = Get-Content -Raw -Encoding UTF8 (Join-Path $portable 'licenses/cloudflared-dependencies.json') | ConvertFrom-Json
if ($modules.Count -ne 66) { throw 'Incomplete Cloudflared license manifest.' }
$notices = Get-Content -Raw -Encoding UTF8 (Join-Path $portable 'licenses/cloudflared-dependencies.txt')
foreach ($module in $modules) { if (!$notices.Contains($module.path + ' ' + $module.version) -or !$notices.Contains($module.goChecksum)) { throw 'Missing module license record.' } }
$envPath = Join-Path $ProjectRoot '.env'
if (Test-Path -LiteralPath $envPath) {
    $secrets = @(Get-Content -Encoding UTF8 -LiteralPath $envPath | ForEach-Object {
        if ($_ -match '^\s*(?:export\s+)?[A-Za-z_][A-Za-z_0-9]*\s*=\s*(.*)$') {
            $value = $Matches[1].Trim().Trim('"').Trim("'")
            if ($value.Length -ge 8) { $value }
        }
    })
    foreach ($file in Get-ChildItem -LiteralPath $portable -Recurse -File) {
        $content = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($file.FullName))
        foreach ($secret in $secrets) { if ($content.Contains($secret)) { throw 'A local environment value was found in the release. Value suppressed.' } }
    }
}
$dataPath = Join-Path $runPath 'isolated-data'
$process = Start-Process -FilePath (Join-Path $portable 'SpoonManager.exe') -ArgumentList @('--smoke', '--data-dir', ('"' + $dataPath + '"')) -WindowStyle Hidden -PassThru
if (!$process.WaitForExit(60000)) { $process.Kill(); throw 'Portable application smoke test timed out.' }
$process.Refresh()
if ($process.ExitCode -ne 0) { throw "Portable application failed: $($process.ExitCode)" }
$report = Get-Content -Raw -Encoding UTF8 (Join-Path $dataPath 'smoke-result.json') | ConvertFrom-Json
if (!$report.ok -or $report.networkActions -ne $false) { throw 'Portable smoke test failed.' }
& (Join-Path $ProjectRoot 'scripts/test-installer.ps1') -Installer $installer -Root (Join-Path $runPath 'installer-check')
Write-Output "Release ZIP ($($actual.Count) files), license manifests, credential exclusions, portable startup and Release installer lifecycle passed."
