' Morph-Fourier launcher (Windows): starts the server with no visible window
' and opens your browser. To stop it, run "Stop Morph-Fourier.bat".
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
repoDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(repoDir & "\backend\.venv\Scripts\python.exe") Or Not fso.FileExists(repoDir & "\frontend\dist\index.html") Then
    MsgBox "Morph-Fourier needs a one-time setup first (a few minutes)." & vbCrLf & "Please run setup.bat, then use this launcher.", vbInformation, "Morph-Fourier"
    WScript.Quit
End If
sh.CurrentDirectory = repoDir
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & repoDir & "\run.ps1""", 0, False
