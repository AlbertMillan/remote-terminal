' Restart the Claude Remote server without a visible console window.
'
' Runs restart-server.ps1 in its own process tree. That matters when the restart
' is triggered from inside a claude-remote terminal: the server's child PTYs --
' including that terminal -- die with the server, and a script running in one of
' them would die before it could start the server again. This launcher does not.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & _
    chr(34) & scriptDir & "\restart-server.ps1" & chr(34), 0
Set WshShell = Nothing
Set fso = Nothing
