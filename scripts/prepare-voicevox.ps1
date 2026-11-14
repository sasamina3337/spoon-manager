param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $project 'licenses/voicevox-manifest.json') | ConvertFrom-Json
$cache = Join-Path $project '.local/voicevox-cache'
$root = Join-Path $project '.local/voicevox'
New-Item -ItemType Directory -Force $cache, $root, "$root/runtime", "$root/models", "$root/licenses" | Out-Null
function Acquire($entry, $name) {
    $path = Join-Path $cache $name
    if (!(Test-Path -LiteralPath $path)) {
        $download = "$path.download"
        Invoke-WebRequest -UseBasicParsing -Uri $entry.url -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ine $entry.sha256) {
            throw "VOICEVOX download checksum mismatch: $name."
        }
        Move-Item -LiteralPath $download -Destination $path
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.sha256) {
        throw "VOICEVOX checksum mismatch: $name. Remove this cache file and retry."
    }
    return $path
}
$core = Acquire $manifest.core 'core.zip'
$ort = Acquire $manifest.ort 'ort.tgz'
$dictionary = Acquire $manifest.dictionary 'dict-github.tgz'
Expand-Archive -LiteralPath $core -DestinationPath "$cache/core" -Force
tar -xzf $ort -C $cache
if ($LASTEXITCODE) { throw 'ONNX Runtime extraction failed.' }
tar -xzf $dictionary -C $cache
if ($LASTEXITCODE) { throw 'Open JTalk dictionary extraction failed.' }
$coreRoot = Join-Path $cache "core/voicevox_core-windows-x64-$($manifest.version)"
$ortRoot = Join-Path $cache 'voicevox_onnxruntime-win-x64-1.17.3'
Copy-Item -LiteralPath "$coreRoot/lib/voicevox_core.dll" -Destination "$root/runtime"
Copy-Item -LiteralPath "$ortRoot/lib/voicevox_onnxruntime.dll" -Destination "$root/runtime"
Copy-Item -LiteralPath "$cache/open_jtalk_dic_utf_8-1.11" -Destination $root -Recurse -Force
Copy-Item -LiteralPath "$coreRoot/LICENSE" -Destination "$root/licenses/CORE-LICENSE.txt"
Copy-Item -LiteralPath "$ortRoot/TERMS.txt" -Destination "$root/licenses/ONNX-TERMS.txt"
Copy-Item -LiteralPath "$ortRoot/third-party-notices.html" -Destination "$root/licenses/ONNX-third-party-notices.html"
Copy-Item -LiteralPath "$cache/open_jtalk_dic_utf_8-1.11/COPYING" -Destination "$root/licenses/OpenJTalk-dictionary-COPYING.txt"
foreach ($entry in $manifest.models) {
    $file = Acquire $entry $entry.name
    $destination = if ($entry.name.EndsWith('.vvm')) { "$root/models" } else { "$root/licenses" }
    Copy-Item -LiteralPath $file -Destination $destination
    Write-Output "Verified $($entry.name)"
}
Copy-Item -LiteralPath (Join-Path $project 'licenses/voicevox-manifest.json') -Destination "$root/catalog.json"
Copy-Item -LiteralPath (Join-Path $project 'licenses/VOICEVOX-MODEL-REVIEW.md') -Destination "$root/licenses"
Write-Output 'VOICEVOX runtime, dictionary, reviewed models and licenses are ready.'
