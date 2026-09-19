#Requires -Version 5.1
<#
.SYNOPSIS
    Build the Koodaamo Watchalong Windows executable(s) with PyInstaller.

.DESCRIPTION
    Installs the build dependencies into the active Python environment and runs
    PyInstaller against packaging/watchalong.spec.

    The "portable" variant produces a single-file, windowed executable at
    dist/KoodaamoWatchalong.exe.

    The "installer" variant bakes in a marker so the app performs a forced
    auto-update on launch, then compiles packaging/installer.iss with Inno Setup
    (ISCC) into dist/KoodaamoWatchalong-Setup.exe.

.PARAMETER Variant
    Which build(s) to produce: portable (default), installer, or both.

.PARAMETER Clean
    Remove the build/ and dist/ directories before building.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Variant both -Clean
#>
[CmdletBinding()]
param(
    [ValidateSet('portable', 'installer', 'both')]
    [string]$Variant = 'portable',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$markerFile = Join-Path $root 'src/watchalong/_build_variant.py'

function Read-AppVersion {
    $configPath = Join-Path $root 'src/watchalong/config.py'
    $line = Select-String -Path $configPath -Pattern '^APP_VERSION\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($line) { return $line.Matches[0].Groups[1].Value }
    return '0.0.0'
}

function Find-ISCC {
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if (-not $base) { continue }
        $candidate = Join-Path $base 'Inno Setup 6/ISCC.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'ISCC.exe (Inno Setup 6) was not found. Install it or add it to PATH.'
}

function Build-Portable {
    Write-Host 'Building portable executable ...' -ForegroundColor Cyan
    Remove-Item -Force -ErrorAction SilentlyContinue $markerFile
    $env:WATCHALONG_VARIANT = 'portable'
    pyinstaller packaging/watchalong.spec --noconfirm
    $exe = Join-Path $root 'dist/KoodaamoWatchalong.exe'
    if (-not (Test-Path $exe)) {
        throw 'Build finished but dist/KoodaamoWatchalong.exe was not found.'
    }
    Write-Host "Built: $exe" -ForegroundColor Green
}

function Build-Installer {
    Write-Host 'Building installer executable ...' -ForegroundColor Cyan
    $iscc = Find-ISCC
    Set-Content -Path $markerFile -Value 'APP_VARIANT = "installer"' -Encoding UTF8
    $env:WATCHALONG_VARIANT = 'installer'
    try {
        pyinstaller packaging/watchalong.spec --noconfirm
        $exe = Join-Path $root 'dist/KoodaamoWatchalong.exe'
        if (-not (Test-Path $exe)) {
            throw 'Build finished but dist/KoodaamoWatchalong.exe was not found.'
        }
        $version = Read-AppVersion
        Write-Host "Compiling installer (v$version) ..." -ForegroundColor Cyan
        & $iscc "/DAppVersion=$version" (Join-Path $root 'packaging/installer.iss')
        $setup = Join-Path $root 'dist/KoodaamoWatchalong-Setup.exe'
        if (-not (Test-Path $setup)) {
            throw 'ISCC finished but dist/KoodaamoWatchalong-Setup.exe was not found.'
        }
        Write-Host "Built: $setup" -ForegroundColor Green
    }
    finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $markerFile
    }
}

Push-Location $root
try {
    if ($Clean) {
        Write-Host 'Cleaning build/ and dist/ ...' -ForegroundColor Cyan
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue build, dist
    }

    Write-Host 'Installing build dependencies ...' -ForegroundColor Cyan
    python -m pip install --upgrade pip
    python -m pip install -e '.[build]'

    if ($Variant -eq 'portable' -or $Variant -eq 'both') {
        Build-Portable
    }
    if ($Variant -eq 'installer' -or $Variant -eq 'both') {
        Build-Installer
    }
}
finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $markerFile
    Remove-Item Env:\WATCHALONG_VARIANT -ErrorAction SilentlyContinue
    Pop-Location
}
