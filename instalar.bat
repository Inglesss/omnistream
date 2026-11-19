@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Instalador OmniStream v3.2.3

echo ==================================================
echo   OmniStream v3.2.3 - Instalador Puente Nativo
echo ==================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] No se encontro Python en el PATH.
    echo Instala Python 3.10+ desde https://www.python.org/downloads/ marcando "Add Python to PATH".
    pause
    exit /b 1
)

echo [1/4] Instalando/actualizando dependencias (yt-dlp, FFmpeg y Gemini)...
python -m pip install -U yt-dlp google-genai imageio-ffmpeg
if errorlevel 1 (
    echo [ADVERTENCIA] Revisa si pip tuvo algun problema. Puedes reintentar manualmente.
)
echo.

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo [OK] FFmpeg listo via paquete integrado imageio-ffmpeg.
) else (
    echo [OK] FFmpeg del sistema detectado correctamente.
)

echo [2/4] Configuracion del ID de Extension de Chrome/Edge/Brave
echo Abre chrome://extensions en tu navegador, activa "Modo de desarrollador",
echo carga esta carpeta con "Cargar descomprimida" y copia el ID (32 letras).
echo.
set /p EXT_ID="Pega aqui el ID de la extension: "
if "%EXT_ID%"=="" (
    echo [ERROR] El ID no puede estar vacio.
    pause
    exit /b 1
)

set "BAT_PATH=%~dp0native_host\omnistream_host.bat"
set "BAT_JSON=%BAT_PATH:\=\\%"
set "MANIFEST_JSON=%~dp0native_host\com.omnistream.downloader.json"

echo [3/4] Generando manifiesto Native Messaging...
(
echo {
echo   "name": "com.omnistream.downloader",
echo   "description": "OmniStream Native Messaging Host (yt-dlp + FFmpeg + Gemini)",
echo   "path": "%BAT_JSON%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://%EXT_ID%/"
echo   ]
echo }
) > "%MANIFEST_JSON%"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.omnistream.downloader" /ve /t REG_SZ /d "%MANIFEST_JSON%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.omnistream.downloader" /ve /t REG_SZ /d "%MANIFEST_JSON%" /f >nul
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.omnistream.downloader" /ve /t REG_SZ /d "%MANIFEST_JSON%" /f >nul
echo [OK] Host nativo registrado en Chrome, Edge y Brave.
echo.

echo [4/4] Configuracion opcional de Transcripcion con Gemini (.MD)
echo Si quieres usar el boton "Transcribir .MD", pega tu GEMINI_API_KEY gratuita
echo de https://aistudio.google.com/apikey (o presiona Enter para omitir):
set /p G_KEY="GEMINI_API_KEY (opcional): "
if not "%G_KEY%"=="" (
    setx GEMINI_API_KEY "%G_KEY%" >nul
    echo [OK] GEMINI_API_KEY guardada en tu usuario de Windows.
)

echo.
echo ==================================================
echo   Instalacion completada. Recarga la extension en
echo   chrome://extensions y ya puedes usar OmniStream!
echo ==================================================
pause
