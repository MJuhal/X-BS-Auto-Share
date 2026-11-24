# Registra la tarea programada de la automatización de X: todos los días a las 8:00 corre auto.mjs,
# que programa en X lo aprobado y genera el lote siguiente cuando quedan pocos posts por salir.
# Corre solo con la sesión del usuario iniciada (la IA usa su sesión). Se pausa desde el panel.
$ErrorActionPreference = 'Stop'
$raiz = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node).Source
$accion = New-ScheduledTaskAction -Execute $node -Argument "`"$raiz\herramientas\auto.mjs`"" -WorkingDirectory $raiz
$disparador = New-ScheduledTaskTrigger -Daily -At 8am
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'X-BS-Auto-Automatizacion' -Action $accion -Trigger $disparador -Settings $ajustes -Description 'la marca en X: programa los posts aprobados y genera el lote siguiente.' -Force | Out-Null
Write-Output 'Tarea registrada.'
