; Per-user native C++ installer. No elevation, drivers, telemetry or PATH changes.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WordFunc.nsh"

!ifndef STAGE_DIR
  !error "Build using the spoon-installer CMake target."
!endif
Name "Spoon Manager"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Spoon Manager"
RequestExecutionLevel user
; VVM data is already compressed/encrypted. zlib avoids spending minutes on
; every package rebuild trying to recompress hundreds of MB of model data.
SetCompressor /SOLID zlib
ManifestDPIAware true
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Spoon Manager"
VIAddVersionKey /LANG=1033 "FileDescription" "Spoon Manager Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "sasamina"
VIAddVersionKey /LANG=1033 "LegalCopyright" "sasamina"
!define MUI_ICON "${PRODUCT_ICON}"
!define MUI_UNICON "${PRODUCT_ICON}"
!define MUI_ABORTWARNING

Var TestMode
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "English"

; Official Evergreen detection: the 32-bit machine registry view on x64 Windows
; and the per-user key. Never download/install a runtime, including in TESTMODE.
; https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
Function RequireWebView2Runtime
  SetRegView 32
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $2 != ""
    ${VersionCompare} $2 "0.0.0.0" $3
    ${If} $3 == "1"
      Return
    ${EndIf}
  ${EndIf}
  ReadRegStr $2 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $2 != ""
    ${VersionCompare} $2 "0.0.0.0" $3
    ${If} $3 == "1"
      Return
    ${EndIf}
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "Microsoft Edge WebView2 Evergreen Runtime is required.$\r$\nInstall the x64 Evergreen Runtime from Microsoft's official page, then run Setup again:$\r$\nhttps://developer.microsoft.com/microsoft-edge/webview2/$\r$\n$\r$\nSetup has not installed the application or changed the runtime. Silent Setup returns exit code 2." /SD IDOK
  SetErrorLevel 2
  Quit
FunctionEnd

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This build requires 64-bit Windows."
    Abort
  ${EndIf}
  StrCpy $TestMode "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE" $1
  ${IfNot} ${Errors}
    StrCpy $TestMode "1"
  ${EndIf}
  Call RequireWebView2Runtime
FunctionEnd

Section "Spoon Manager" SEC_MAIN
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $TestMode != "1"
    CreateDirectory "$SMPROGRAMS\Spoon Manager"
    CreateShortcut "$SMPROGRAMS\Spoon Manager\Spoon Manager.lnk" "$INSTDIR\SpoonManager.exe" "" "$INSTDIR\SpoonManager.exe" 0
    CreateShortcut "$SMPROGRAMS\Spoon Manager\Uninstall.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "DisplayName" "Spoon Manager"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "DisplayVersion" "${PRODUCT_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "Publisher" "sasamina"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "DisplayIcon" '"$INSTDIR\SpoonManager.exe",0'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp" "NoRepair" 1
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $TestMode "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE" $1
  ${IfNot} ${Errors}
    StrCpy $TestMode "1"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  !include "${UNINSTALL_PAYLOAD}"
  Delete "$INSTDIR\Uninstall.exe"
  ${If} $TestMode != "1"
    Delete "$SMPROGRAMS\Spoon Manager\Spoon Manager.lnk"
    Delete "$SMPROGRAMS\Spoon Manager\Uninstall.lnk"
    RMDir "$SMPROGRAMS\Spoon Manager"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpoonManagerDesktopCpp"
  ${EndIf}
  ; Removes the directory only if empty. APPDATA and unknown files are preserved.
  RMDir "$INSTDIR"
SectionEnd
