#Requires -Version 5.1
<#
.SYNOPSIS
    Build the standalone Koodaamo Watchalong Windows executable with PyInstaller.

.DESCRIPTION
    Installs the build dependencies into the active Python environment and runs
    PyInstaller against packaging/watchalong.spec. The resulting single-file,
    windowed executable is written to dist/KoodaamoWatchalong.exe.

.PARAMETER Clean
    Remove the build/ and dist/ directories before building.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Clean
#>
[CmdletBinding()]
param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if ($Clean) {
        Write-Host 'Cleaning build/ and dist/ ...' -ForegroundColor Cyan
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue build, dist
    }

    Write-Host 'Installing build dependencies ...' -ForegroundColor Cyan
    python -m pip install --upgrade pip
    python -m pip install -e '.[build]'

    Write-Host 'Building executable ...' -ForegroundColor Cyan
    pyinstaller packaging/watchalong.spec --noconfirm

    $exe = Join-Path $root 'dist/KoodaamoWatchalong.exe'
    if (Test-Path $exe) {
        Write-Host "Built: $exe" -ForegroundColor Green
    }
    else {
        throw 'Build finished but dist/KoodaamoWatchalong.exe was not found.'
    }
}
finally {
    Pop-Location
}
