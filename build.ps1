# Gera dist\Pingger.exe (portátil, arquivo único, sem console).
# Uso: .\build.ps1   (cria .venv com PyInstaller na primeira vez)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .venv\Scripts\pyinstaller.exe)) {
    python -m venv .venv
    .venv\Scripts\python -m pip install -q pyinstaller
}

.venv\Scripts\pyinstaller --noconfirm --clean --onefile --windowed `
    --name Pingger `
    --add-data "pingger\web;pingger\web" `
    Pingger.pyw

Write-Host "Pronto: $PSScriptRoot\dist\Pingger.exe"
