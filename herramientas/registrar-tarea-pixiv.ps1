# Registra la tarea de Pixiv en automático: corre pixiv-auto.mjs a la hora de cada franja de
# Pixiv (config pixiv.horas, hora de Japón, pasada a la hora de esta PC) y reintenta cada 15 minutos (3 reintentos) si falla.
# Lo que no sale en esa ventana queda pendiente para la persona a cargo (no se sube solo después).
# Corre sin ventana (conhost --headless). Volver a correr este script si cambian los horarios de Pixiv.
# Si se ejecuta como administrador, la tarea corre también sin sesión de Windows iniciada (S4U, no guarda contraseña).
$ErrorActionPreference = 'Stop'
$raiz = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node).Source
$nombre = 'X-BS-Auto-Pixiv'
$conf = Get-Content "$raiz\config\x.json" -Raw -Encoding UTF8 | ConvertFrom-Json
# Las horas actuales y las de los cambios con fecha (pixiv.cambios_horas): un post viejo puede seguir en una hora anterior.
$horas = @(@($conf.pixiv.horas) + @($conf.pixiv.cambios_horas | ForEach-Object { $_.horas }) | Where-Object { $_ } | Sort-Object -Unique)
if (-not $horas.Count) { $horas = @('21:00') }
$zonaJapon = [TimeZoneInfo]::FindSystemTimeZoneById('Tokyo Standard Time')
$hoyJapon = [TimeZoneInfo]::ConvertTime([DateTime]::Now, $zonaJapon).Date
$disparadores = foreach ($h in $horas) {
  $p = $h.Split(':')
  $enJapon = [DateTime]::SpecifyKind($hoyJapon.AddHours([int]$p[0]).AddMinutes([int]$p[1]), 'Unspecified')
  $local = [TimeZoneInfo]::ConvertTime($enJapon, $zonaJapon, [TimeZoneInfo]::Local)
  $t = New-ScheduledTaskTrigger -Daily -At $local
  $t.Repetition = (New-ScheduledTaskTrigger -Once -At $local -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Minutes 46)).Repetition
  Write-Host ("Franja {0} de Japón = {1:HH:mm} de esta PC" -f $h, $local)
  $t
}
$accion = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless `"$node`" `"$raiz\herramientas\pixiv-auto.mjs`"" -WorkingDirectory $raiz
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 40) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$desc = 'la marca en Pixiv: a la hora de cada franja sube solo el post aprobado (3 reintentos cada 15 minutos; lo demás queda pendiente para la persona a cargo).'
$usuario = "$env:USERDOMAIN\$env:USERNAME"
try {
  $p = New-ScheduledTaskPrincipal -UserId $usuario -LogonType S4U
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparadores -Settings $ajustes -Principal $p -Description $desc -Force -ErrorAction Stop | Out-Null
  Write-Output 'Tarea registrada: corre aunque no haya sesión de Windows iniciada.'
} catch {
  $p = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparadores -Settings $ajustes -Principal $p -Description $desc -Force -ErrorAction Stop | Out-Null
  Write-Output 'Tarea registrada con la sesión de Windows iniciada (aunque esté bloqueada). Para que corra también sin sesión, ejecutar este script como administrador.'
}
