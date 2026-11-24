' Abre el panel de la marca (X y Bluesky) sin ventana de consola. Si ya estaba abierto, solo abre el navegador.
' El panel se cierra con el boton Cerrar panel (o solo, despues de 4 horas sin uso).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta
sh.Run "node """ & carpeta & "\herramientas\panel\servidor.mjs""", 0, False
WScript.Sleep 1500
sh.Run "http://127.0.0.1:4392", 1, False
