param(
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $Output) { $Output = Join-Path $root 'app\public\icon.ico' }

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $radius = [float]($size * 0.20)
  $bgPath = New-RoundedPath 0 0 $size $size $radius
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 154, 104),
    [System.Drawing.Color]::FromArgb(255, 185, 52, 7),
    45.0
  )
  $g.FillPath($bgBrush, $bgPath)

  $cx = [float]($size / 2)
  $ink = [System.Drawing.Color]::FromArgb(240, 26, 12, 6)
  $outerPen = New-Object System.Drawing.Pen($ink, [float]([Math]::Max(1.0, $size * 0.032)))
  $outerPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $top = New-Object System.Drawing.PointF($cx, [float]($size * 0.18))
  $rt = New-Object System.Drawing.PointF([float]($size * 0.79), [float]($size * 0.35))
  $rb = New-Object System.Drawing.PointF([float]($size * 0.79), [float]($size * 0.67))
  $bt = New-Object System.Drawing.PointF($cx, [float]($size * 0.84))
  $lb = New-Object System.Drawing.PointF([float]($size * 0.21), [float]($size * 0.67))
  $lt = New-Object System.Drawing.PointF([float]($size * 0.21), [float]($size * 0.35))
  $outer = @($top, $rt, $rb, $bt, $lb, $lt)
  $g.DrawPolygon($outerPen, $outer)

  $midPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 26, 12, 6), [float]([Math]::Max(0.8, $size * 0.020)))
  $midPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $center = New-Object System.Drawing.PointF($cx, [float]($size * 0.53))
  $g.DrawLine($midPen, $top, $center)
  $g.DrawLine($midPen, $lt, $center)
  $g.DrawLine($midPen, $rt, $center)
  $g.DrawLine($midPen, $center, $bt)

  $face = @(
    (New-Object System.Drawing.PointF($cx, [float]($size * 0.42))),
    (New-Object System.Drawing.PointF([float]($size * 0.63), [float]($size * 0.49))),
    (New-Object System.Drawing.PointF([float]($size * 0.63), [float]($size * 0.67))),
    (New-Object System.Drawing.PointF($cx, [float]($size * 0.75))),
    (New-Object System.Drawing.PointF([float]($size * 0.37), [float]($size * 0.67))),
    (New-Object System.Drawing.PointF([float]($size * 0.37), [float]($size * 0.49)))
  )
  $faceBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(238, 40, 17, 7))
  $g.FillPolygon($faceBrush, $face)

  $fontSize = [float]([Math]::Max(6.0, $size * 0.19))
  $font = New-Object System.Drawing.Font('Consolas', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 215, 196))
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $textRect = New-Object System.Drawing.RectangleF(0, [float]($size * 0.38), $size, [float]($size * 0.32))
  $g.DrawString('A3', $font, $textBrush, $textRect, $format)

  $format.Dispose()
  $textBrush.Dispose()
  $font.Dispose()
  $faceBrush.Dispose()
  $midPen.Dispose()
  $outerPen.Dispose()
  $bgBrush.Dispose()
  $bgPath.Dispose()
  $g.Dispose()

  return $bmp
}

function New-IconDib([int]$size) {
  $bmp = New-IconBitmap $size
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $pixels = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  $maskStride = [int]([Math]::Floor(($size + 31) / 32) * 4)
  $mask = New-Object byte[] ($maskStride * $size)

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)

  # BITMAPINFOHEADER
  $writer.Write([UInt32]40)
  $writer.Write([Int32]$size)
  $writer.Write([Int32]($size * 2))
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]0)
  $writer.Write([UInt32]($size * $size * 4))
  $writer.Write([Int32]0)
  $writer.Write([Int32]0)
  $writer.Write([UInt32]0)
  $writer.Write([UInt32]0)

  # XOR pixels, bottom-up BGRA
  for ($y = $size - 1; $y -ge 0; $y--) {
    $writer.Write($pixels, $y * $stride, $size * 4)
  }
  # AND mask: all zero, because 32bpp alpha is used
  $writer.Write($mask)

  $writer.Flush()
  $bytes = $stream.ToArray()
  $writer.Dispose()
  $stream.Dispose()
  return ,$bytes
}

$sizes = @(16, 32, 48, 256)
$images = @()
foreach ($size in $sizes) {
  $images += ,(New-IconDib $size)
}

$outStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($outStream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$images.Count)

$offset = 6 + (16 * $images.Count)
for ($i = 0; $i -lt $images.Count; $i++) {
  $size = $sizes[$i]
  $dim = if ($size -ge 256) { 0 } else { $size }
  $writer.Write([Byte]$dim)
  $writer.Write([Byte]$dim)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$images[$i].Length)
  $writer.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($image in $images) {
  $writer.Write($image)
}
$writer.Flush()
[System.IO.File]::WriteAllBytes($Output, $outStream.ToArray())
$writer.Dispose()
$outStream.Dispose()

Write-Host "Icon written: $Output" -ForegroundColor Green
