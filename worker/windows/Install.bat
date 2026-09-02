@echo off
setlocal
title Install AI Song Engine Worker
set "TARGET=%LOCALAPPDATA%\AISongEngine"
echo.
echo   Installing AI Song Engine Worker
echo   ---------------------------------------------
echo   To: %TARGET%
echo.
if not exist "%TARGET%" mkdir "%TARGET%"
robocopy "%~dp0." "%TARGET%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
powershell -NoProfile -Command ^
  "$W=New-Object -ComObject WScript.Shell;" ^
  "$s=$W.CreateShortcut([Environment]::GetFolderPath(Desktop)+\AI Song Engine.lnk);" ^
  "$s.TargetPath=%TARGET%\AI Song Engine.bat;$s.WorkingDirectory=%TARGET%;" ^
  "$s.Description=AI Song Engine worker;$s.Save();" ^
  "$m=[Environment]::GetFolderPath(StartMenu)+\Programs\AI Song Engine.lnk;" ^
  "$s2=$W.CreateShortcut($m);$s2.TargetPath=%TARGET%\AI Song Engine.bat;" ^
  "$s2.WorkingDirectory=%TARGET%;$s2.Save()"
echo   Created a Desktop shortcut and a Start Menu entry.
echo.
set /p AUTO=  Start automatically when Windows starts? (y/n): 
if /i "%AUTO%"=="y" (
  powershell -NoProfile -Command ^
    "$W=New-Object -ComObject WScript.Shell;" ^
    "$p=[Environment]::GetFolderPath(Startup)+\AI Song Engine.lnk;" ^
    "$s=$W.CreateShortcut($p);$s.TargetPath=%TARGET%\AI Song Engine.bat;" ^
    "$s.WorkingDirectory=%TARGET%;$s.Save()"
  echo   Auto-start enabled.
)
echo.
echo   Done. Starting the worker now...
echo.
start "" "%TARGET%\AI Song Engine.bat"
timeout /t 3 >nul
