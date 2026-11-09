# Resolve the installed MSVC tools for this process only, then use CMake Presets.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$command = if ($args.Count) { $args[0] } else { 'help' }
$options = @($args | Select-Object -Skip 1)
$allowed = @('help', 'configure', 'build', 'start', 'launch', 'test', 'check', 'clean', 'package')
if ($command -notin $allowed) { throw "Unknown command: $command. Run .\spoon.ps1 help" }
if ($command -eq 'help') {
    Write-Output @'
.\spoon.ps1 configure             Configure CMake + Visual Studio (MSVC x64)
.\spoon.ps1 build                 Build Release, stage app and create NSIS Setup
.\spoon.ps1 start                 Build and run the Win32 + WebView2 app
.\spoon.ps1 launch                Run the existing native app
.\spoon.ps1 test                  Build and run CTest, including UI and installer tests
.\spoon.ps1 check                 Build without running or staging
.\spoon.ps1 package               Build and generate a distributable ZIP
.\spoon.ps1 clean                 Clean generated build outputs (keep dependencies)
Options: --debug / --release; start/launch: --smoke --demo --data-dir <directory>
UI and installer tests require a preinstalled Microsoft Edge WebView2 Evergreen Runtime.
The WebView2 SDK/static loader is downloaded and SHA-256 checked by CMake.
The app uses the original renderer in bin/ui; no Node.js, Electron or Rust runtime.
'@
    exit 0
}
$debugBuild = $options -contains '--debug'
if ($debugBuild -and $options -contains '--release') { throw 'Choose --debug or --release.' }
$preset = if ($debugBuild) { 'windows-debug' } else { 'windows-release' }
$binary = Join-Path $projectRoot ".local/build/$preset/bin/SpoonManager.exe"
$appArguments = @()
for ($index = 0; $index -lt $options.Count; $index++) {
    switch ($options[$index]) {
        '--debug' { }
        '--release' { }
        '--smoke' { $appArguments += '--smoke' }
        '--demo' { $appArguments += '--demo' }
        '--data-dir' {
            $index++
            if ($index -ge $options.Count -or $options[$index].StartsWith('--')) { throw '--data-dir requires a directory.' }
            $appArguments += @('--data-dir', $options[$index])
        }
        default { throw "Unknown option: $($options[$index])" }
    }
}
if ($appArguments.Count -and $command -notin @('start', 'launch')) { throw 'Application options require start or launch.' }
if ($appArguments -contains '--smoke' -and $appArguments -notcontains '--data-dir') {
    $appArguments += @('--data-dir', (Join-Path $projectRoot ".test-artifacts/cpp-smoke-$([guid]::NewGuid().ToString('N'))"))
}
function Assert-WebView2Runtime {
    # Microsoft documents both a per-machine 32-bit view and a per-user key.
    $clientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry32)
        try {
            $key = $baseKey.OpenSubKey($clientKey)
            if ($key) {
                try {
                    $runtimeVersion = [version]'0.0.0.0'
                    if ([version]::TryParse([string]$key.GetValue('pv'), [ref]$runtimeVersion) -and $runtimeVersion -gt [version]'0.0.0.0') { return }
                } finally { $key.Dispose() }
            }
        } finally { $baseKey.Dispose() }
    }
    throw 'Microsoft Edge WebView2 Evergreen Runtime is required. Install the x64 Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and retry. This script does not install or modify the runtime.'
}
if ($command -in @('start', 'launch', 'test')) { Assert-WebView2Runtime }
if ($command -eq 'launch') {
    if (!(Test-Path -LiteralPath $binary)) { throw 'Native binary missing. Run .\spoon.ps1 build first.' }
    $uiRoot = Join-Path (Split-Path -Parent $binary) 'ui'
    foreach ($asset in @('popup/popup.html', 'native-entry.js')) {
        if (!(Test-Path -LiteralPath (Join-Path $uiRoot $asset))) { throw "Native UI asset missing: $asset. Run .\spoon.ps1 build to refresh bin/ui." }
    }
    $startOptions = @{ FilePath = $binary; PassThru = $true }
    if ($appArguments -contains '--smoke') { $startOptions.WindowStyle = 'Hidden' }
    if ($appArguments.Count) { $startOptions.ArgumentList = ($appArguments | ForEach-Object { '"' + $_ + '"' }) }
    $process = Start-Process @startOptions
    if ($appArguments -contains '--smoke') { $process.WaitForExit(); exit $process.ExitCode }
    exit 0
}

$originalEnvironment = @{}
Get-ChildItem Env: | ForEach-Object { $originalEnvironment[$_.Name] = $_.Value }
Push-Location $projectRoot
try {
    # Match Ninja's include scanner regardless of the Windows display language.
    $env:VSLANG = '1033'
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (!(Test-Path -LiteralPath $vswhere)) { throw 'Install Microsoft C++ Build Tools (Desktop development with C++).' }
    $installation = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if (!$installation) { throw 'MSVC x64 was not found.' }
    $devcmd = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
    if ($devcmd -match '["%!\r\n]') { throw 'Unsupported Build Tools path.' }
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/Lib'
    $sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.FullName 'um/x64/kernel32.lib')) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'um/x64/DbgHelp.Lib')) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt/x64/ucrt.lib'))
    } | Sort-Object { [version]$_.Name } | Select-Object -Last 1
    if (!$sdk) { throw 'A complete Windows SDK with x64 libraries was not found.' }
    $setupInfo = New-Object System.Diagnostics.ProcessStartInfo
    $setupInfo.FileName = $env:ComSpec
    $setupInfo.Arguments = '/d /s /c ""' + $devcmd + '" -no_logo -arch=x64 -host_arch=x64 -winsdk=' + $sdk.Name + ' >nul && set"'
    $setupInfo.UseShellExecute = $false
    $setupInfo.CreateNoWindow = $true
    $setupInfo.RedirectStandardOutput = $true
    $setupInfo.RedirectStandardError = $true
    $setup = [System.Diagnostics.Process]::Start($setupInfo)
    $environmentLines = $setup.StandardOutput.ReadToEnd() -split "`r?`n"
    $setupError = $setup.StandardError.ReadToEnd()
    $setup.WaitForExit()
    if ($setup.ExitCode -ne 0) { throw "MSVC environment initialization failed: $setupError" }
    $setup.Dispose()
    foreach ($line in $environmentLines) {
        if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
    if (!(Get-Command cmake.exe -ErrorAction SilentlyContinue)) {
        $cmakePath = Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin'
        $env:PATH = "$cmakePath;$env:PATH"
    }
    if ($command -eq 'clean') {
        $cache = Join-Path $projectRoot ".local/build/$preset/CMakeCache.txt"
        if (Test-Path -LiteralPath $cache) { & cmake --build --preset $preset --target clean; exit $LASTEXITCODE }
        exit 0
    }
    $cache = Join-Path $projectRoot ".local/build/$preset/CMakeCache.txt"
    $presetFile = Join-Path $projectRoot 'CMakePresets.json'
    $presetStamp = Join-Path $projectRoot ".local/build/$preset/preset.sha256"
    $presetHash = (Get-FileHash -LiteralPath $presetFile -Algorithm SHA256).Hash
    # CMake regenerates when CMakeLists or included CMake files change.
    # Reapply the preset explicitly only for first configuration or preset edits.
    $configure = $command -eq 'configure' -or !(Test-Path -LiteralPath $cache)
    if (!$configure) { $configure = !(Test-Path -LiteralPath $presetStamp) -or [IO.File]::ReadAllText($presetStamp) -ne $presetHash }
    if (!(Test-Path -LiteralPath (Join-Path $projectRoot ".local/build/$preset/SpoonManager.slnx")) -and !(Test-Path -LiteralPath (Join-Path $projectRoot ".local/build/$preset/SpoonManager.sln"))) { $configure = $true }
    if ($configure) {
        & cmake --preset $preset
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        [IO.File]::WriteAllText($presetStamp, $presetHash)
    }
    if ($command -eq 'configure') { exit 0 }
    $jobs = [Math]::Min(8, [Environment]::ProcessorCount)
    $buildArguments = @('--build', '--preset', $preset, '--parallel', $jobs)
    if ($command -in @('check', 'start')) { $buildArguments += @('--target', 'spoon-manager') }
    & cmake @buildArguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    switch ($command) {
        'test' { & ctest --preset $preset; exit $LASTEXITCODE }
        'build' { & cmake --install ".local/build/$preset" --config $(if ($debugBuild) { 'Debug' } else { 'Release' }); exit $LASTEXITCODE }
        'package' { & cmake --build --preset $preset --target package; exit $LASTEXITCODE }
        'start' {
            $startOptions = @{ FilePath = $binary; PassThru = $true }
            if ($appArguments -contains '--smoke') { $startOptions.WindowStyle = 'Hidden' }
            if ($appArguments.Count) { $startOptions.ArgumentList = ($appArguments | ForEach-Object { '"' + $_ + '"' }) }
            $process = Start-Process @startOptions
            if ($appArguments -contains '--smoke') { $process.WaitForExit(); exit $process.ExitCode }
        }
    }
    exit 0
} finally {
    Pop-Location
    foreach ($item in @(Get-ChildItem Env:)) {
        if (!$originalEnvironment.ContainsKey($item.Name)) { [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process') }
    }
    foreach ($name in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process') }
}
