; Inno Setup script for the auto-updating Koodaamo Watchalong installer build.
;
; Compile from the repository root after PyInstaller has produced
; dist/KoodaamoWatchalong.exe:
;   ISCC.exe /DAppVersion=0.1.0 packaging\installer.iss
;
; Produces dist/KoodaamoWatchalong-Setup.exe. Supports silent upgrades used by
; the in-app forced updater: KoodaamoWatchalong-Setup.exe /VERYSILENT

#define AppName "Koodaamo Watchalong"
#define AppExeName "KoodaamoWatchalong.exe"
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
; Stable AppId so future installs upgrade in place instead of duplicating.
AppId={{B8E7D2A1-4C3F-4E5A-9B6D-1234567890AB}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Koodaamo
DefaultDirName={localappdata}\KoodaamoWatchalong
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=KoodaamoWatchalong-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Close a running instance (via Restart Manager) so files can be replaced.
CloseApplications=yes
RestartApplications=no
#if FileExists("app.ico")
SetupIconFile=app.ico
#endif

[Files]
Source: "..\dist\KoodaamoWatchalong.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Koodaamo Watchalong"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\Koodaamo Watchalong"; Filename: "{app}\{#AppExeName}"

[Run]
; Relaunch after install. Runs on both interactive and silent (update) installs.
Filename: "{app}\{#AppExeName}"; Description: "Launch Koodaamo Watchalong"; Flags: nowait
