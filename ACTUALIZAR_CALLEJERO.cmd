@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==============================================
echo   Ruta Envios - Callejero oficial Georef
 echo ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js y vuelve a ejecutar este archivo.
  exit /b 1
)
node scripts\update-street-catalog.mjs
if errorlevel 1 (
  echo.
  echo ERROR: no se pudo actualizar el callejero.
  exit /b 1
)
echo.
echo Callejero actualizado correctamente.
echo Archivos modificados:
echo   data\street-catalog.json
echo   data\street-catalog.meta.json
echo.
echo Para subirlo a GitHub:
echo   git add data\street-catalog.json data\street-catalog.meta.json
echo   git commit -m "data: refresh official Georef street catalog"
echo   git push origin main
endlocal
