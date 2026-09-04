# Jalankan sebagai Administrator agar auto-start terdaftar.
# Cara: klik kanan file ini -> Run with PowerShell, atau dari PowerShell admin:
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1

$folder = 'F:\AKARINDO\SCRAPPING TOOLS\lokerdetector'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $folder + '\start-server-hidden.vbs"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

try {
    Register-ScheduledTask -TaskName 'LokerDetectorAutoStart' -Description 'Menjalankan server LokerDetector otomatis saat Windows login' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host 'OK: Tugas auto-start terdaftar.' -ForegroundColor Green
    Get-ScheduledTask -TaskName 'LokerDetectorAutoStart' | Select-Object TaskName, State
} catch {
    Write-Host ('GAGAL: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Pastikan Anda menjalankan ini dari PowerShell sebagai Administrator.'
}