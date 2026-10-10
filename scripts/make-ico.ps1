# Rebuild icon.ico from build/icon.png.
#
#   npm run icon
#
# System.Drawing can resize but cannot write a multi-size .ico, so this does the
# resizing and hands the per-size PNGs to scripts/make-ico.mjs, which assembles
# the container. Keeping the two steps separate means the PNG resize quality is
# controlled explicitly (HighQualityBicubic) instead of whatever default the
# icon writer would pick.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$master = Join-Path $root 'build\icon.png'
$tmp = Join-Path $root '.iconbuild'

if (-not (Test-Path $master)) { throw "master icon not found: $master" }

$sizes = @(16, 32, 48, 64, 128, 256)

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force $tmp | Out-Null

$src = [System.Drawing.Image]::FromFile($master)
try {
  if ($src.Width -ne $src.Height) { throw "master icon must be square (got $($src.Width)x$($src.Height))" }
  foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save((Join-Path $tmp "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  resized $size x $size"
  }
} finally {
  $src.Dispose()
}

Push-Location $root
try { & node 'scripts\make-ico.mjs' } finally { Pop-Location }

Write-Host "icon pipeline: OK"
