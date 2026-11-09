param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Root
)
$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($Root)
$runPath = Join-Path $rootPath ('run-' + [guid]::NewGuid().ToString('N'))
$installPath = Join-Path $runPath 'Installed App'
$dataPath = Join-Path $runPath 'Isolated Data'
New-Item -ItemType Directory -Path $runPath -Force | Out-Null

function Wait-OwnedProcess($Process, [int]$Milliseconds, [string]$Action = 'subprocess') {
    if (!$Process.WaitForExit($Milliseconds)) {
        $Process.Kill()
        throw "Installer test $Action timed out."
    }
    $Process.Refresh()
    if ($Process.ExitCode -eq 2 -and $Action -eq 'Setup') {
        throw 'Microsoft Edge WebView2 Evergreen Runtime must be preinstalled for installer tests. Install the x64 Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and retry. The test does not install or modify the runtime.'
    }
    if ($Process.ExitCode -ne 0) { throw "Installer test $Action failed: $($Process.ExitCode)" }
}

# /TESTMODE skips registry/Start-menu writes, but uses exactly the normal payload.
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp'
$before = if (Test-Path -LiteralPath $registry) { (Get-ItemProperty -LiteralPath $registry | ConvertTo-Json -Compress) } else { '' }
$process = Start-Process -FilePath ([IO.Path]::GetFullPath($Installer)) -ArgumentList ('/S /TESTMODE /D=' + $installPath) -WindowStyle Hidden -PassThru
Wait-OwnedProcess $process 30000 'Setup'
$installed = Join-Path $installPath 'SpoonManager.exe'
foreach ($file in @('SpoonManager.exe', 'Uninstall.exe', 'vcruntime140.dll', 'msvcp140.dll', 'LICENSE', 'licenses/WebView2.txt', 'licenses/WebView2-NOTICE.txt', 'licenses/cloudflared-dependencies.txt', 'licenses/cloudflared-dependencies.json', 'licenses/go-runtime.txt', 'licenses/nsis.txt', 'licenses/microsoft-runtime.txt', 'licenses/nlohmann-json-components.txt', 'ui/popup/popup.html', 'ui/native-entry.js', 'ui/icons/reader.ico', 'ui/icons/reader.svg', 'ui/shared/spoon-permissions.js', 'documentation/Development.md')) {
    if (!(Test-Path -LiteralPath (Join-Path $installPath $file))) { throw "Missing installed payload: $file" }
}
foreach ($file in @('.env', 'connection.json', 'state.json', 'spoon/tokens.json')) {
    if (Test-Path -LiteralPath (Join-Path $installPath $file)) { throw 'User credentials or records appeared in the installer payload.' }
}
$process = Start-Process -FilePath $installed -ArgumentList @('--smoke', '--data-dir', ('"' + $dataPath + '"')) -WindowStyle Hidden -PassThru
Wait-OwnedProcess $process 60000 'installed app'
$report = Get-Content -LiteralPath (Join-Path $dataPath 'smoke-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$report.ok -or $report.networkActions -ne $false) { throw 'Installed application smoke test failed.' }

# Unknown files must survive uninstall; this is not real application/user data.
$sentinel = Join-Path $installPath 'preserve-test-user-file.txt'
[IO.File]::WriteAllText($sentinel, 'installer-test-sentinel')
$uninstaller = Join-Path $installPath 'Uninstall.exe'
$process = Start-Process -FilePath $uninstaller -ArgumentList ('/S /TESTMODE _?=' + $installPath) -WindowStyle Hidden -PassThru
Wait-OwnedProcess $process 30000 'uninstaller'
if (Test-Path -LiteralPath $installed) { throw 'Uninstall did not remove the installed application.' }
if (!(Test-Path -LiteralPath $sentinel)) { throw 'Uninstall removed an unknown file.' }
if (!(Test-Path -LiteralPath (Join-Path $dataPath 'state.json'))) { throw 'Uninstall removed separate user data.' }
$after = if (Test-Path -LiteralPath $registry) { (Get-ItemProperty -LiteralPath $registry | ConvertTo-Json -Compress) } else { '' }
if ($before -ne $after) { throw 'Installer test modified the real product registration.' }
Write-Output 'NSIS install, installed-app smoke, uninstall and data-preservation checks passed.'
