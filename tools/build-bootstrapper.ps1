# Собирает загрузчик bootstrapper\ProjectManul-Install.exe встроенным в Windows компилятором C#.
#   npm run bootstrapper
# Ссылка на установщик берётся из launcher.config.json (manifestUrl). Пересобирать нужно только
# при смене репозитория: Windows копит «репутацию» конкретного файла, а новая сборка начинает с нуля.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'bootstrapper'
$obj = Join-Path $src 'obj'
$out = Join-Path $src 'ProjectManul-Install.exe'
New-Item -ItemType Directory -Force $obj | Out-Null

$cfg = Get-Content (Join-Path $root 'launcher.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$asset = 'ProjectManul-Setup.exe'
$pub = Join-Path $root 'publish.config.json'
if (Test-Path $pub) {
    $p = Get-Content $pub -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($p.launcher -and $p.launcher.assetName) { $asset = $p.launcher.assetName }
}
if ($cfg.manifestUrl -notmatch '^https://github\.com/[^/]+/[^/]+/releases/latest/download/[^/]+$') {
    throw "manifestUrl в launcher.config.json должен быть вида https://github.com/<владелец>/<репозиторий>/releases/latest/download/manifest.json"
}
$installerUrl = $cfg.manifestUrl -replace '[^/]+$', $asset
$releasesUrl = $cfg.manifestUrl -replace '/download/[^/]+$', ''

function Quote([string]$s) { '@"' + $s.Replace('"', '""') + '"' }
$config = @"
// Создаётся tools/build-bootstrapper.ps1 — не редактируйте.
static class BuildConfig
{
    public const string ProjectName = $(Quote $cfg.projectName);
    public const string InstallerUrl = $(Quote $installerUrl);
    public const string ReleasesUrl = $(Quote $releasesUrl);
}
"@
$utf8 = New-Object System.Text.UTF8Encoding $true
[IO.File]::WriteAllText((Join-Path $obj 'BuildConfig.cs'), $config, $utf8)

# Иконка .ico из build\icon.png: несколько размеров, каждый — PNG внутри ICO.
$iconPng = Join-Path $root 'build\icon.png'
$ico = Join-Path $obj 'icon.ico'
$srcImg = [Drawing.Image]::FromFile($iconPng)
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
    $bmp = New-Object Drawing.Bitmap $s, $s
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    $g.DrawImage($srcImg, 0, 0, $s, $s)
    $g.Dispose()
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    , $ms.ToArray()
}
$srcImg.Dispose()
$fs = [IO.File]::Create($ico)
$w = New-Object IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$pngs[$i].Length); $w.Write([UInt32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($bytes in $pngs) { $w.Write($bytes) }
$w.Close()

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Не найден компилятор C# из .NET Framework 4 (csc.exe).' }

& $csc /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 `
    "/win32icon:$ico" "/resource:$iconPng,logo.png" `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    "/out:$out" (Join-Path $src 'Program.cs') (Join-Path $obj 'BuildConfig.cs')
if ($LASTEXITCODE -ne 0) { throw "csc.exe завершился с кодом $LASTEXITCODE" }

$size = [math]::Round((Get-Item $out).Length / 1KB)
Write-Host "Готово: $out ($size КБ)"
Write-Host "Скачивает: $installerUrl"
