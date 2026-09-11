@echo off
REM clear-office-cache.bat
REM Closes Word and clears the Office Add-in (Wef) cache that keeps old
REM taskpane.js/taskpane.html versions "stuck" after you redeploy new files.
REM Safe to run any time Word is giving you stale add-in behavior.

echo Closing Word (if it's open)...
taskkill /f /im WINWORD.EXE >nul 2>&1
timeout /t 2 >nul

echo Clearing Office Add-in cache...
if exist "%LOCALAPPDATA%\Microsoft\Office\16.0\Wef" (
    rmdir /s /q "%LOCALAPPDATA%\Microsoft\Office\16.0\Wef"
    echo Done - cache cleared.
) else (
    echo No cache folder found ^(nothing to clear^).
)

echo.
echo You can now reopen Word and the add-in.
pause
