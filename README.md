# OmniStream

![Versión](https://img.shields.io/badge/version-v3.2.2-blue)
![Manifest](https://img.shields.io/badge/Chrome-Manifest%20V3-green)
![Plataforma](https://img.shields.io/badge/OS-Windows%2010%2F11-lightgrey)
![Licencia](https://img.shields.io/badge/license-MIT-brightgreen)

Extensión de código abierto para **Chrome, Edge y Brave** que descarga video `.MP4` (Video + Audio integrados), extrae audio `.MP3` y genera transcripciones literales con resumen en `.MD` usando `yt-dlp`, `FFmpeg` y **Gemini 3.5 Flash-Lite**.

---

## Características

| Función | Descripción |
| :--- | :--- |
| **Video `.MP4` (H.264 + AAC)** | Descarga y fusiona Video + Audio en todas las calidades disponibles (`2160p 4K` hasta `144p`) sin pistas mudas. |
| **Audio `.MP3`** | Extracción directa en `320`, `192`, `128` o `64 kbps`. |
| **Transcripción Literal `.MD`** | Genera un encabezado con resumen y la transcripción literal palabra por palabra con marcas `[MM:SS]`, interpretando términos técnicos según el ramo/tema indicado. |
| **Selector "Guardar como..."** | Pregunta la carpeta y nombre de destino antes de iniciar y abre esa carpeta con el archivo seleccionado al terminar. |
| **Interfaz Google Dark** | Tarjetas uniformes con miniatura del video, panel lateral (`sidePanel`) y progreso en tiempo real. |

---

## Descarga directa

Descarga el paquete listo desde la sección oficial de lanzamientos:

👉 **[Descargar OmniStream v3.2.2 (.ZIP)](https://github.com/luissegurasoto-cmyk/omnistream/releases/latest)**

---

## Requisitos (Windows)

1. **Python 3.10+** con la opción **Add Python to PATH** marcada ([descargar aquí](https://www.python.org/downloads/)).
2. **FFmpeg**:
   ```powershell
   winget install Gyan.FFmpeg
   ```
3. *(Opcional, recomendado para YouTube)* **Node.js LTS**:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
4. *(Opcional, solo para "Transcribir .MD")* Una **`GEMINI_API_KEY`** gratuita en [Google AI Studio](https://aistudio.google.com/apikey).

---

## Instalación paso a paso

1. Descomprime `OmniStream v3.2.2.zip` en una carpeta fija (ejemplo: `Documentos\OmniStream`).
2. Abre `chrome://extensions` en Chrome (`edge://extensions` en Edge o `brave://extensions` en Brave).
3. Activa **Modo de desarrollador** (esquina superior derecha).
4. Haz clic en **Cargar descomprimida** y selecciona la carpeta descomprimida.
5. Copia el **ID de la extensión** (32 letras minúsculas) que aparece en la tarjeta.
6. Haz doble clic en **`instalar.bat`**, pega el ID cuando te lo pida y sigue los pasos en pantalla.
7. Recarga la extensión en `chrome://extensions`.

---

## Privacidad y Seguridad

- Todo el procesamiento de descarga y conversión ocurre **100% en tu equipo**.
- Si activas la transcripción con Gemini, tu `GEMINI_API_KEY` se guarda únicamente en tus variables de entorno de usuario de Windows (`HKCU\Environment`) y nunca dentro del código de la extensión.
- Los logs locales (`omnistream_host.log`) nunca se suben al repositorio.

---

## Licencia

Distribuido bajo licencia [MIT](LICENSE).
