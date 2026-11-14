# Developer-only license collection; does not build or run upstream code.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cache = Join-Path $project '.local/voicevox-license-sources'
New-Item -ItemType Directory -Force $cache | Out-Null
$archive = Join-Path $cache 'core-0.17.1.zip'
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://codeload.github.com/VOICEVOX/voicevox_core/zip/refs/tags/0.17.1' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive).Hash -ine '0f8b3b8aaaa7c992eab54749416282d7e2fa4b0bd72094187cec78e46398e338') { throw 'CORE source archive checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $cache -Force
$source = Join-Path $cache 'voicevox_core-0.17.1'
$env:CARGO_HOME = Join-Path $cache 'cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $cache 'target'
$metadataFile = Join-Path $cache 'metadata.json'
& cargo +stable metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --manifest-path (Join-Path $source 'Cargo.toml') --features voicevox_core_c_api/load-onnxruntime > $metadataFile
if ($LASTEXITCODE) { throw 'Unable to resolve upstream license sources.' }
$slimFile = Join-Path $cache 'license-packages.json'
& node (Join-Path $PSScriptRoot 'voicevox-license-metadata.mjs') $metadataFile $slimFile
if ($LASTEXITCODE) { throw 'Unable to reduce metadata to production dependencies.' }
$metadata = Get-Content -Raw -Encoding UTF8 $slimFile | ConvertFrom-Json
$records = @()
$parts = [Collections.Generic.List[string]]::new()
$parts.Add("VOICEVOX CORE 0.17.1 third-party license notices`n`nSources: https://github.com/VOICEVOX/voicevox_core/tree/0.17.1`nSource archive SHA256: $((Get-FileHash $archive).Hash)`n`nThis collection covers the locked Windows production/build dependency graph reachable from voicevox_core_c_api. Development-only edges are excluded. Inclusion can be broader than the DLL's linked code due to Cargo feature unification. No upstream build script is executed by this collector.`n")
foreach ($package in $metadata.packages | Sort-Object name,version) {
    $directory = Split-Path -Parent $package.manifest_path
    $files = @(Get-ChildItem -LiteralPath $directory -Recurse -File | Where-Object {
        ($_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT|AUTHORS|PATENTS)([._-].*)?$' -or $_.FullName -match '\\LICENSES\\') -and $_.Length -lt 2000000
    })
    # Workspace crates inherit the repository's MIT license.
    if (!$files.Count -and $package.source -eq $null) { $files = @(Get-Item -LiteralPath (Join-Path $source 'LICENSE')) }
    $licenseSource = $package.source
    if (!$files.Count -and $package.repository -match '^https://github.com/([^/]+/[^/]+?)(?:\.git)?/?$') {
        $repository = $Matches[1]
        $vcs = Get-Content -Raw -Encoding UTF8 (Join-Path $directory '.cargo_vcs_info.json') | ConvertFrom-Json
        $commit = $vcs.git.sha1
        if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'Missing pinned upstream license revision.' }
        $licenseSource = "https://github.com/$repository/tree/$commit"
        foreach ($name in @('LICENSE','LICENSE-MIT','LICENSE-APACHE','COPYING','NOTICE','license-mit','license-apache','license','.github/license-mit','.github/license-apache')) {
            $filename = $name.Replace('/', '-')
            $file = Join-Path $cache "$($package.name)-$($package.version)-$filename.txt"
            if (!(Test-Path -LiteralPath $file)) {
                try { Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/$repository/$commit/$name" -OutFile $file }
                catch { continue }
            }
            $files += Get-Item -LiteralPath $file
        }
    }
    if (!$files.Count) { throw "Missing license text for $($package.name) $($package.version)" }
    $parts.Add("`n================ $($package.name) $($package.version) ================`nDeclared license: $($package.license)`nSource: $($package.source)`nLicense source: $licenseSource`n")
    $notices = @()
    foreach ($file in $files | Sort-Object FullName) {
        $relative = if ($file.FullName.StartsWith($directory)) { $file.FullName.Substring($directory.Length).TrimStart('\','/') } else { $file.Name }
        $parts.Add("`n--- $relative ---`n" + [IO.File]::ReadAllText($file.FullName))
        $notices += @{file=$relative;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()}
    }
    $records += @{name=$package.name;version=$package.version;license=$package.license;source=$package.source;licenseSource=$licenseSource;checksum=$package.checksum;notices=$notices}
}
foreach ($name in @('LICENSE-APACHE','LICENSE-MIT','COPYRIGHT')) {
    $file = Join-Path $cache "rust-1.96.0-$name.txt"
    if (!(Test-Path -LiteralPath $file)) { Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/rust-lang/rust/1.96.0/$name" -OutFile $file }
    $parts.Add("`n================ Rust standard runtime 1.96.0 / $name ================`nSource: https://github.com/rust-lang/rust/blob/1.96.0/$name`n" + [IO.File]::ReadAllText($file))
}
[IO.File]::WriteAllText((Join-Path $project 'licenses/voicevox-core-dependencies.txt'), ($parts -join "`n"), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $project 'licenses/voicevox-core-dependencies.json'), (ConvertTo-Json -InputObject $records -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output "Collected $($records.Count) locked package license records."
