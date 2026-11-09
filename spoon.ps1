# C++20 / Win32 + WebView2 entry point. No Node.js, Electron or Rust runtime.
& (Join-Path $PSScriptRoot 'scripts/cpp-tools.ps1') @args
exit $LASTEXITCODE
