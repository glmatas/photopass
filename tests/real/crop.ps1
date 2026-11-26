param([string]$In,[string]$Out,[int]$X,[int]$Y,[int]$W,[int]$H)
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Bitmap]::FromFile($In)
$r=New-Object System.Drawing.Rectangle $X,$Y,$W,$H
$c=$src.Clone($r,$src.PixelFormat); $c.Save($Out,[System.Drawing.Imaging.ImageFormat]::Png); $c.Dispose(); $src.Dispose()
