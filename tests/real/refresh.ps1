Add-Type @"
using System; using System.Runtime.InteropServices;
public class Disp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int a,b,c,d,e,f,g,h; }
  [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
}
"@
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | % {
  $dm = New-Object Disp+DEVMODE; $dm.dmSize = [int][Runtime.InteropServices.Marshal]::SizeOf($dm)
  [void][Disp]::EnumDisplaySettings($_.DeviceName, -1, [ref]$dm)
  [pscustomobject]@{name=$_.DeviceName;primary=$_.Primary;x=$dm.dmPositionX;y=$dm.dmPositionY;w=$dm.dmPelsWidth;h=$dm.dmPelsHeight;hz=$dm.dmDisplayFrequency}
} | ConvertTo-Json -Compress
