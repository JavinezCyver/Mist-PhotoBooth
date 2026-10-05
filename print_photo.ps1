param([Parameter(Mandatory = $true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$image = $null
$document = $null
$dialog = $null
try {
    if ([System.Drawing.Printing.PrinterSettings]::InstalledPrinters.Count -eq 0) {
        throw 'No printers installed. Add a printer in Windows Settings first.'
    }
    $image = [System.Drawing.Image]::FromFile($ImagePath)
    $document = New-Object System.Drawing.Printing.PrintDocument
    $document.DocumentName = 'Photo Booth - 4 photos'
    $document.DefaultPageSettings.Landscape = $true
    $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(20, 20, 20, 20)
    $dialog = New-Object System.Windows.Forms.PrintDialog
    $dialog.Document = $document
    $dialog.UseEXDialog = $true
    $dialog.AllowSomePages = $false
    $dialog.AllowSelection = $false
    $dialog.AllowPrintToFile = $true
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
    if (-not $document.PrinterSettings.IsValid) { throw 'The selected printer is unavailable.' }
    $document.add_PrintPage({
        param($sender, $eventArgs)
        $bounds = $eventArgs.MarginBounds
        # Fit within both the margins and the device's printable region.
        $printable = $eventArgs.PageSettings.PrintableArea
        $left = [Math]::Max($bounds.Left, $printable.Left)
        $top = [Math]::Max($bounds.Top, $printable.Top)
        $right = [Math]::Min($bounds.Right, $printable.Right)
        $bottom = [Math]::Min($bounds.Bottom, $printable.Bottom)
        $scale = [Math]::Min(($right - $left) / $image.Width, ($bottom - $top) / $image.Height)
        $width = $image.Width * $scale
        $height = $image.Height * $scale
        $x = $left + (($right - $left) - $width) / 2
        $y = $top + (($bottom - $top) - $height) / 2
        $rect = New-Object System.Drawing.RectangleF([single]$x, [single]$y, [single]$width, [single]$height)
        $eventArgs.Graphics.DrawImage($image, $rect)
        $eventArgs.HasMorePages = $false
    })
    $document.Print()
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($dialog) { $dialog.Dispose() }
    if ($document) { $document.Dispose() }
    if ($image) { $image.Dispose() }
}
