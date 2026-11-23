Add-Type -AssemblyName System.Drawing
foreach ($t in 192, 512) {
  $bmp = New-Object System.Drawing.Bitmap $t, $t
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#128c7e'))
  $branco = [System.Drawing.Brushes]::White
  $m = $t * 0.2
  $g.FillEllipse($branco, $m, $m, $t - 2 * $m, $t - 2 * $m)
  $f = New-Object System.Drawing.Font 'Segoe UI', ($t * 0.3), 'Bold', 'Pixel'
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $verde = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#128c7e'))
  $g.DrawString('M', $f, $verde, (New-Object System.Drawing.RectangleF 0, 0, $t, $t), $sf)
  $bmp.Save("$PSScriptRoot\icon-$t.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
