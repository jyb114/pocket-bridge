Unicode true
!include "MUI2.nsh"

!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is required"
!endif
!ifndef NUMERIC_VERSION
  !error "NUMERIC_VERSION is required"
!endif
!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef UNINSTALL_INCLUDE
  !error "UNINSTALL_INCLUDE is required"
!endif

Name "Pocket Bridge"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Pocket Bridge"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetOverwrite on
BrandingText "Pocket Bridge"
Icon "${PAYLOAD_DIR}\desktop\icons\app.ico"
UninstallIcon "${PAYLOAD_DIR}\desktop\icons\app.ico"
VIProductVersion "${NUMERIC_VERSION}.0"
VIAddVersionKey "ProductName" "Pocket Bridge"
VIAddVersionKey "FileDescription" "Pocket Bridge installer"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Pocket Bridge contributors"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Pocket Bridge" SecMain
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall Pocket Bridge.exe"

  ; The build script installs into a temporary test directory marked with this
  ; file. Its smoke test must never replace the user's real desktop shortcuts.
  IfFileExists "$INSTDIR\installer-test.flag" LinksDone
  CreateShortCut "$DESKTOP\Pocket Bridge.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\desktop\open-desktop.vbs"' "$INSTDIR\desktop\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\Pocket Bridge.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\desktop\open-desktop.vbs"' "$INSTDIR\desktop\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\Uninstall Pocket Bridge.lnk" "$INSTDIR\Uninstall Pocket Bridge.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "DisplayName" "Pocket Bridge"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "DisplayIcon" "$INSTDIR\desktop\icons\app.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "UninstallString" '"$INSTDIR\Uninstall Pocket Bridge.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge" "NoRepair" 1
LinksDone:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\installer-test.flag" LinksRemoved
  Delete "$DESKTOP\Pocket Bridge.lnk"
  Delete "$SMPROGRAMS\Pocket Bridge.lnk"
  Delete "$SMPROGRAMS\Uninstall Pocket Bridge.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketBridge"
LinksRemoved:
  Delete "$INSTDIR\Uninstall Pocket Bridge.exe"
  !include "${UNINSTALL_INCLUDE}"
  ; Keep config.json, logs, uploads, tls and current-url.txt so reinstall can
  ; retain device identity, keys and user data. Only empty code dirs are removed.
  RMDir "$INSTDIR"
SectionEnd
