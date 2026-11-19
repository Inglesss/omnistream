/**
 * OmniStream Video Downloader & AI Transcriber - Offscreen Document v2.3
 * - Descargas en streaming y ensamblaje de Blobs locales (MP4, HLS .m3u8, DASH .mpd).
 * - Extracción de audio y codificación MP3 robusta (Demuxer MPEG-TS -> ADTS/AAC, pistas HLS dedicadas, timeout seguro).
 * - Motor de Transcripción y Traducción IA Local en Español con Whisper (Transformers.js WebGPU / WASM).
 */

const FORBIDDEN_JS_HEADERS = [
  /^sec-/i,
  /^cookie$/i,
  /^date$/i,
  /^origin$/i,
  /^referer$/i,
  /^host$/i,
  /^connection$/i,
  /^content-length$/i,
  /^user-agent$/i,
  /^range$/i
];

const activeControllers = new Map();
const createdBlobUrls = new Set();

// Canal Keep-Alive para impedir que Chrome suspenda el Service Worker durante codificación o transcripción
let keepAlivePort = null;
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'offscreen_keepalive' });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
    });
  } catch (e) {}

  keepAliveTimer = setInterval(() => {
    if (activeControllers.size === 0) {
      stopKeepAlive();
      return;
    }
    try {
      if (!keepAlivePort) {
        keepAlivePort = chrome.runtime.connect({ name: 'offscreen_keepalive' });
      }
      keepAlivePort.postMessage({ type: 'ping', activeTasks: activeControllers.size });
    } catch (e) {
      keepAlivePort = null;
    }
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (keepAlivePort) {
    try {
      keepAlivePort.disconnect();
    } catch (e) {}
    keepAlivePort = null;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'execute_stream_download') {
    startKeepAlive();
    handleStreamDownload(message.data);
    sendResponse({ status: 'started' });
    return true;
  }

  if (message.action === 'abort_stream_download') {
    const controller = activeControllers.get(message.downloadId);
    if (controller) {
      controller.abort();
      activeControllers.delete(message.downloadId);
    }
    if (aiWorker) {
      aiWorker.postMessage({ action: 'abort_task', downloadId: message.downloadId });
    }
    sendResponse({ status: 'aborted' });
    return true;
  }

  if (message.action === 'revoke_blob_url') {
    if (message.blobUrl) {
      URL.revokeObjectURL(message.blobUrl);
      createdBlobUrls.delete(message.blobUrl);
    }
    sendResponse({ status: 'revoked' });
    return true;
  }
});

// ==========================================
// 1. DECODIFICACIÓN DE AUDIO RESILIENTE Y DEMUXER MPEG-TS -> ADTS/AAC
// ==========================================

/**
 * Extrae paquetes de audio elemental (ADTS AAC o MPEG Audio) desde un contenedor MPEG-TS (.ts).
 * Esto resuelve el fallo donde AudioContext.decodeAudioData() se cuelga o rechaza contenedores .ts de video HLS.
 */
function extractElementaryAudioFromMpegTs(tsUint8) {
  const PACKET_SIZE = 188;
  const len = tsUint8.byteLength;

  // Buscar el primer byte de sincronización 0x47 válido
  let startOffset = -1;
  for (let i = 0; i < Math.min(len, 188 * 5); i++) {
    if (tsUint8[i] === 0x47 && (i + 188 >= len || tsUint8[i + 188] === 0x47)) {
      startOffset = i;
      break;
    }
  }
  if (startOffset < 0) return null;

  let pmtPid = -1;
  let audioPid = -1;
  const audioChunks = [];

  // Primera pasada rápida: descubrir PMT y PID de Audio (AAC 0x0F, LATM 0x11, MP3 0x03/0x04)
  const maxDiscoveryBytes = Math.min(len, startOffset + PACKET_SIZE * 3000);
  for (let pos = startOffset; pos + PACKET_SIZE <= maxDiscoveryBytes; pos += PACKET_SIZE) {
    if (tsUint8[pos] !== 0x47) continue;
    const pusi = !!(tsUint8[pos + 1] & 0x40);
    const pid = ((tsUint8[pos + 1] & 0x1F) << 8) | tsUint8[pos + 2];
    const afc = (tsUint8[pos + 3] >> 4) & 0x03;

    let payloadOffset = pos + 4;
    if (afc === 2 || afc === 0) continue;
    if (afc === 3) {
      const adaptLen = tsUint8[payloadOffset];
      payloadOffset += 1 + adaptLen;
    }
    if (payloadOffset >= pos + PACKET_SIZE) continue;

    // PAT (PID 0)
    if (pid === 0 && pmtPid < 0) {
      let ptr = payloadOffset;
      if (pusi) ptr += 1 + tsUint8[ptr];
      if (ptr + 12 <= pos + PACKET_SIZE && tsUint8[ptr] === 0x00) {
        const sectionLen = ((tsUint8[ptr + 1] & 0x0F) << 8) | tsUint8[ptr + 2];
        const tableEnd = Math.min(pos + PACKET_SIZE, ptr + 3 + sectionLen - 4);
        let progPos = ptr + 8;
        while (progPos + 4 <= tableEnd) {
          const progNum = (tsUint8[progPos] << 8) | tsUint8[progPos + 1];
          const progPid = ((tsUint8[progPos + 2] & 0x1F) << 8) | tsUint8[progPos + 3];
          if (progNum !== 0) {
            pmtPid = progPid;
            break;
          }
          progPos += 4;
        }
      }
    } else if (pid === pmtPid && pmtPid > 0 && audioPid < 0) {
      let ptr = payloadOffset;
      if (pusi) ptr += 1 + tsUint8[ptr];
      if (ptr + 12 <= pos + PACKET_SIZE && tsUint8[ptr] === 0x02) {
        const sectionLen = ((tsUint8[ptr + 1] & 0x0F) << 8) | tsUint8[ptr + 2];
        const progInfoLen = ((tsUint8[ptr + 10] & 0x0F) << 8) | tsUint8[ptr + 11];
        const tableEnd = Math.min(pos + PACKET_SIZE, ptr + 3 + sectionLen - 4);
        let esPos = ptr + 12 + progInfoLen;
        while (esPos + 5 <= tableEnd) {
          const streamType = tsUint8[esPos];
          const elemPid = ((tsUint8[esPos + 1] & 0x1F) << 8) | tsUint8[esPos + 2];
          const esInfoLen = ((tsUint8[esPos + 3] & 0x0F) << 8) | tsUint8[esPos + 4];
          // 0x0F = ADTS AAC, 0x11 = LATM AAC, 0x03/0x04 = MPEG Audio, 0x81 = AC3
          if (streamType === 0x0F || streamType === 0x11 || streamType === 0x03 || streamType === 0x04) {
            audioPid = elemPid;
            break;
          }
          esPos += 5 + esInfoLen;
        }
      }
    }
    if (audioPid > 0) break;
  }

  // Segunda pasada: extraer payload PES del audioPid (o cualquier paquete PES con stream_id de audio 0xC0..0xDF)
  for (let pos = startOffset; pos + PACKET_SIZE <= len; pos += PACKET_SIZE) {
    if (tsUint8[pos] !== 0x47) continue;
    const pusi = !!(tsUint8[pos + 1] & 0x40);
    const pid = ((tsUint8[pos + 1] & 0x1F) << 8) | tsUint8[pos + 2];
    const afc = (tsUint8[pos + 3] >> 4) & 0x03;

    if (audioPid > 0 && pid !== audioPid) continue;
    if (pid === 0 || pid === pmtPid || pid === 0x1FFF) continue;

    let payloadOffset = pos + 4;
    if (afc === 2 || afc === 0) continue;
    if (afc === 3) {
      const adaptLen = tsUint8[payloadOffset];
      payloadOffset += 1 + adaptLen;
    }
    if (payloadOffset >= pos + PACKET_SIZE) continue;

    if (pusi) {
      // Verificar cabecera PES: 0x00 0x00 0x01
      if (
        payloadOffset + 9 <= pos + PACKET_SIZE &&
        tsUint8[payloadOffset] === 0x00 &&
        tsUint8[payloadOffset + 1] === 0x00 &&
        tsUint8[payloadOffset + 2] === 0x01
      ) {
        const streamId = tsUint8[payloadOffset + 3];
        // Si aún no teníamos audioPid confirmado, validar que sea stream de audio MPEG/AAC (0xC0 - 0xDF)
        if (audioPid < 0) {
          if (streamId >= 0xC0 && streamId <= 0xDF) {
            audioPid = pid;
          } else {
            continue;
          }
        }
        const pesHeaderDataLen = tsUint8[payloadOffset + 8];
        payloadOffset += 9 + pesHeaderDataLen;
      } else if (audioPid < 0) {
        continue;
      }
    } else if (audioPid < 0) {
      continue;
    }

    if (payloadOffset < pos + PACKET_SIZE) {
      audioChunks.push(tsUint8.subarray(payloadOffset, pos + PACKET_SIZE));
    }
  }

  if (audioChunks.length === 0) return null;
  const rawPesPayload = concatUint8Arrays(audioChunks);
  const cleanAdts = extractCleanAdtsFrames(rawPesPayload);
  return (cleanAdts && cleanAdts.byteLength > 128) ? cleanAdts : rawPesPayload;
}

/**
 * Escanea un buffer y extrae únicamente tramas ADTS AAC válidas y contiguas (syncword 0xFFF).
 * Elimina cabeceras ID3, metadatos privados PES o bytes corruptos entre segmentos HLS de YouTube/Twitch.
 */
function extractCleanAdtsFrames(uint8) {
  const len = uint8.byteLength;
  const frames = [];
  let i = 0;
  let lastValidEnd = -1;

  while (i + 7 <= len) {
    // Syncword ADTS: 12 bits en 1 (0xFF y nibble superior 0xF0), layer === 00 ((byte1 & 0x06) === 0)
    if (uint8[i] === 0xFF && (uint8[i + 1] & 0xF6) === 0xF0) {
      const frameLength = ((uint8[i + 3] & 0x03) << 11) | (uint8[i + 4] << 3) | ((uint8[i + 5] & 0xE0) >> 5);
      if (frameLength >= 7 && frameLength <= 8192 && i + frameLength <= len) {
        const nextPos = i + frameLength;
        const hasNextSync = (nextPos + 2 <= len && uint8[nextPos] === 0xFF && (uint8[nextPos + 1] & 0xF6) === 0xF0);
        const isContiguousFromPrev = (i === lastValidEnd);
        if (hasNextSync || isContiguousFromPrev || nextPos === len) {
          frames.push(uint8.subarray(i, nextPos));
          lastValidEnd = nextPos;
          i = nextPos;
          continue;
        }
      }
    }
    i++;
  }

  if (frames.length < 2) return null;
  return concatUint8Arrays(frames);
}

/**
 * Decodifica una lista de segmentos (MPEG-TS o fMP4) lote por lote si el buffer concatenado
 * falla en decodeAudioData (típico de manifest.googlevideo.com en YouTube HLS).
 */
async function decodeSegmentsListToAudioBuffer(validBuffers, initMapBuffer = null) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decodedBuffers = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < validBuffers.length; i += BATCH_SIZE) {
      const slice = validBuffers.slice(i, i + BATCH_SIZE);
      const batchArrays = [];
      if (initMapBuffer) {
        batchArrays.push(new Uint8Array(initMapBuffer));
      }
      for (const buf of slice) {
        if (initMapBuffer && buf === initMapBuffer) continue;
        const u8 = new Uint8Array(buf);
        const isTs = u8.byteLength >= 376 && u8[0] === 0x47 && u8[188] === 0x47;
        if (isTs) {
          const demuxed = extractElementaryAudioFromMpegTs(u8);
          if (demuxed) batchArrays.push(demuxed);
        } else {
          batchArrays.push(u8);
        }
      }
      if (batchArrays.length === 0) continue;

      const combined = concatUint8Arrays(batchArrays);
      try {
        const ab = combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
        const decoded = await audioCtx.decodeAudioData(ab);
        decodedBuffers.push(decoded);
      } catch (batchErr) {
        // Si el lote falló, intentar con extractCleanAdtsFrames sobre el lote
        const cleanAdts = extractCleanAdtsFrames(combined);
        if (cleanAdts && cleanAdts.byteLength > 128) {
          try {
            const ab2 = cleanAdts.buffer.slice(cleanAdts.byteOffset, cleanAdts.byteOffset + cleanAdts.byteLength);
            const decoded2 = await audioCtx.decodeAudioData(ab2);
            decodedBuffers.push(decoded2);
          } catch (e2) {}
        }
      }
    }

    if (decodedBuffers.length === 0) {
      throw new Error('Este flujo HLS contiene solo video (sin pista de audio). Reproduce el video desde el inicio para capturar la pista con sonido.');
    }

    const totalLength = decodedBuffers.reduce((acc, b) => acc + b.length, 0);
    const channels = decodedBuffers[0].numberOfChannels;
    const sampleRate = decodedBuffers[0].sampleRate;
    const merged = audioCtx.createBuffer(channels, totalLength, sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      const targetData = merged.getChannelData(ch);
      let offset = 0;
      for (const b of decodedBuffers) {
        const srcCh = Math.min(ch, b.numberOfChannels - 1);
        targetData.set(b.getChannelData(srcCh), offset);
        offset += b.length;
      }
    }
    return merged;
  } finally {
    audioCtx.close().catch(() => {});
  }
}

/**
 * Decodifica cualquier ArrayBuffer multimedia a AudioBuffer con:
 * 1) Demux automático si es contenedor MPEG-TS (.ts) + filtro de tramas ADTS puras.
 * 2) Timeout de seguridad para que decodeAudioData nunca se quede pegado infinitamente en el 50%.
 */
async function decodeMediaBytesToAudioBuffer(rawArrayBuffer, mimeHint = '') {
  const uint8 = new Uint8Array(rawArrayBuffer);
  let targetBuffer = rawArrayBuffer;

  const isMpegTs =
    mimeHint.includes('mp2t') ||
    (uint8.byteLength >= 376 && uint8[0] === 0x47 && uint8[188] === 0x47);

  if (isMpegTs) {
    const extractedAac = extractElementaryAudioFromMpegTs(uint8);
    if (extractedAac && extractedAac.byteLength > 128) {
      targetBuffer = extractedAac.buffer.slice(
        extractedAac.byteOffset,
        extractedAac.byteOffset + extractedAac.byteLength
      );
    }
  }

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const bufferCopy = targetBuffer.slice(0);
    const decodePromise = audioCtx.decodeAudioData(bufferCopy);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_DECODE_AUDIO_DATA')), 45000)
    );
    return await Promise.race([decodePromise, timeoutPromise]);
  } catch (firstErr) {
    console.warn('Intento 1 decodeAudioData falló, probando extractor ADTS puro:', firstErr);
    const extractedAac = isMpegTs ? extractCleanAdtsFrames(new Uint8Array(targetBuffer)) : (extractElementaryAudioFromMpegTs(uint8) || extractCleanAdtsFrames(uint8));
    if (extractedAac && extractedAac.byteLength > 128) {
      const aacSlice = extractedAac.buffer.slice(
        extractedAac.byteOffset,
        extractedAac.byteOffset + extractedAac.byteLength
      );
      return await audioCtx.decodeAudioData(aacSlice);
    }
    throw new Error(
      `No se pudo decodificar la pista de audio (${firstErr.message || 'el flujo seleccionado no contiene pista de sonido'}).`
    );
  } finally {
    audioCtx.close().catch(() => {});
  }
}

// ==========================================
// 2. DEDICATED MP3 WEB WORKER MANAGER
// ==========================================

let aiWorker = null;
const pendingWorkerTasks = new Map();

function getAiWorker() {
  if (aiWorker) return aiWorker;
  aiWorker = new Worker(chrome.runtime.getURL('ai_worker.js'));
  aiWorker.onmessage = (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'progress') {
      chrome.runtime.sendMessage({
        action: 'download_progress',
        downloadId: msg.downloadId,
        mediaId: msg.mediaId,
        phase: msg.phase,
        statusMessage: msg.statusMessage,
        receivedBytes: msg.receivedBytes,
        totalBytes: msg.totalBytes,
        percent: msg.percent
      }).catch(() => {});
      return;
    }

    const pending = pendingWorkerTasks.get(msg.downloadId);
    if (!pending) return;

    if (msg.type === 'mp3_complete') {
      pendingWorkerTasks.delete(msg.downloadId);
      pending.resolve(new Blob([msg.mp3Buffer], { type: 'audio/mp3' }));
    } else if (msg.type === 'error') {
      pendingWorkerTasks.delete(msg.downloadId);
      pending.reject(new Error(msg.error || 'Error en Worker MP3'));
    }
  };

  aiWorker.onerror = (err) => {
    console.error('Error crítico en ai_worker:', err);
  };
  return aiWorker;
}

// ==========================================
// 3. GESTOR PRINCIPAL DE DESCARGA Y EXTRACCIÓN
// ==========================================

async function handleStreamDownload(data) {
  const { downloadId, mediaId, url, filename, rawHeaders, type, audioOnly, transcribeOnly } = data;
  const abortController = new AbortController();
  activeControllers.set(downloadId, abortController);

  const needsAudioExtraction = !!(audioOnly || transcribeOnly);

  const safeHeaders = new Headers();
  if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [name, val] of Object.entries(rawHeaders)) {
      const isForbidden = FORBIDDEN_JS_HEADERS.some(rx => rx.test(name));
      if (!isForbidden && val) {
        try {
          safeHeaders.append(name, val);
        } catch (e) {}
      }
    }
  }

  const isManifest = (type === 'mpd' || type === 'm3u8' || url.includes('.mpd') || url.includes('.m3u8'));
  if (isManifest) {
    try {
      await handleManifestDownload(data, abortController, safeHeaders);
    } catch (err) {
      activeControllers.delete(downloadId);
      if (err.name === 'AbortError') {
        chrome.runtime.sendMessage({
          action: 'download_aborted',
          downloadId,
          mediaId
        }).catch(() => {});
      } else {
        chrome.runtime.sendMessage({
          action: 'download_failed',
          downloadId,
          mediaId,
          error: err.message || 'Error procesando fragmentos de streaming'
        }).catch(() => {});
      }
    }
    return;
  }

  // Flujo directo continuo (MP4 / WebM / Zoom)
  try {
    const response = await fetch(url, {
      headers: safeHeaders,
      signal: abortController.signal,
      cache: 'default'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error del servidor remoto'}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : (data.sizeBytes || 0);

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    let lastProgressTime = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedBytes += value.length;

      const now = Date.now();
      if (now - lastProgressTime > 280 || (totalBytes > 0 && receivedBytes === totalBytes)) {
        lastProgressTime = now;
        const netFraction = totalBytes > 0 ? (receivedBytes / totalBytes) : 0;
        const maxDownloadPct = transcribeOnly ? 40 : (audioOnly ? 50 : 100);
        const scaledPct = Math.floor(netFraction * maxDownloadPct);
        const statusMsg = needsAudioExtraction
          ? `Descargando flujo multimedia: ${formatBytes(receivedBytes)}${totalBytes ? ' / ' + formatBytes(totalBytes) : ''}`
          : `Descargando: ${formatBytes(receivedBytes)}${totalBytes ? ' / ' + formatBytes(totalBytes) : ''}`;

        chrome.runtime.sendMessage({
          action: 'download_progress',
          downloadId,
          mediaId,
          transcribeOnly,
          phase: 'downloading',
          statusMessage: statusMsg,
          receivedBytes,
          totalBytes,
          percent: scaledPct
        }).catch(() => {});
      }
    }

    const contentType = response.headers.get('content-type') || 'video/mp4';

    if (audioOnly) {
      chrome.runtime.sendMessage({
        action: 'download_progress',
        downloadId,
        mediaId,
        phase: 'decoding',
        statusMessage: 'Extrayendo y decodificando pista de audio...',
        receivedBytes,
        totalBytes: receivedBytes,
        percent: 50
      }).catch(() => {});

      const rawBlob = new Blob(chunks, { type: contentType });
      chunks.length = 0;
      const rawBuf = await rawBlob.arrayBuffer();

      let audioBuf;
      try {
        audioBuf = await decodeMediaBytesToAudioBuffer(rawBuf, contentType);
      } catch (primaryDecodeErr) {
        // Si el stream MP4 principal era solo de video (mudo) y tenemos companionAudioUrl capturado en la pestaña, descargar y decodificar el companion
        if (data.companionAudioUrl) {
          chrome.runtime.sendMessage({
            action: 'download_progress',
            downloadId,
            mediaId,
            phase: 'downloading',
            statusMessage: 'Descargando pista de audio asociada...',
            receivedBytes,
            totalBytes: receivedBytes,
            percent: 45
          }).catch(() => {});
          const compResp = await fetch(data.companionAudioUrl, { headers: safeHeaders, signal: abortController.signal });
          if (!compResp.ok) throw primaryDecodeErr;
          const compBuf = await compResp.arrayBuffer();
          audioBuf = await decodeMediaBytesToAudioBuffer(compBuf, compResp.headers.get('content-type') || 'audio/mp4');
        } else {
          throw primaryDecodeErr;
        }
      }

      const audioKbps = parseInt(data.qualityOptions?.audioKbps, 10) || 128;
      const mp3Blob = await encodeAudioBufferToMp3(audioBuf, downloadId, mediaId, abortController, 50, 99, audioKbps);
      const blobUrl = URL.createObjectURL(mp3Blob);
      createdBlobUrls.add(blobUrl);

      activeControllers.delete(downloadId);
      let cleanName = filename.replace(/\.(mp4|m3u8|mpd|webm|ts|mp3|htm|html)$/i, '') + '.mp3';

      chrome.runtime.sendMessage({
        action: 'download_blob_ready',
        downloadId,
        mediaId,
        blobUrl,
        filename: cleanName,
        sizeBytes: mp3Blob.size
      });
      return;
    }

    // Verificar si el MP4 descargado es un fMP4 de solo video (sin pista 'soun') y existe un companionAudioUrl para fusionar
    let finalVideoParts = chunks;
    let finalByteSize = receivedBytes;
    if (data.companionAudioUrl && !data.companionAudioUrl.includes('.m3u8')) {
      try {
        const videoFullArr = concatUint8Arrays(chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c)));
        // Detectar si falta el handler 'soun' (0x73 0x6f 0x75 0x6e) en el encabezado moov
        const moovBox = findBoxInUint8(videoFullArr, 'moov');
        let hasSoundTrack = false;
        if (moovBox) {
          const moovEnd = Math.min(videoFullArr.byteLength, moovBox.offset + moovBox.size);
          for (let k = moovBox.offset; k <= moovEnd - 4; k++) {
            if (videoFullArr[k] === 0x73 && videoFullArr[k + 1] === 0x6f && videoFullArr[k + 2] === 0x75 && videoFullArr[k + 3] === 0x6e) {
              hasSoundTrack = true;
              break;
            }
          }
        }
        if (moovBox && !hasSoundTrack) {
          chrome.runtime.sendMessage({
            action: 'download_progress',
            downloadId,
            mediaId,
            phase: 'downloading',
            statusMessage: 'Descargando y fusionando pista de audio al MP4...',
            receivedBytes,
            totalBytes: receivedBytes,
            percent: 92
          }).catch(() => {});

          const compResp = await fetch(data.companionAudioUrl, { headers: safeHeaders, signal: abortController.signal });
          if (compResp.ok) {
            const audioFullArr = new Uint8Array(await compResp.arrayBuffer());
            const aMoov = findBoxInUint8(audioFullArr, 'moov');
            if (aMoov) {
              const vInitEnd = moovBox.offset + moovBox.size;
              const aInitEnd = aMoov.offset + aMoov.size;
              const combinedInit = createCombinedInit(
                videoFullArr.subarray(0, vInitEnd),
                audioFullArr.subarray(0, aInitEnd)
              );
              const vMediaBody = videoFullArr.subarray(vInitEnd);
              const aMediaBody = new Uint8Array(audioFullArr.subarray(aInitEnd));
              changeTrackIdInBytes(aMediaBody, 1, 2);
              finalVideoParts = [combinedInit, vMediaBody, aMediaBody];
              finalByteSize = combinedInit.byteLength + vMediaBody.byteLength + aMediaBody.byteLength;
            }
          }
        }
      } catch (muxErr) {
        console.warn('No se requirió muxing adicional fMP4:', muxErr);
      }
    }

    // Ensamblar Blob local de video MP4/WebM (con Video + Audio)
    const blob = new Blob(finalVideoParts, { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    createdBlobUrls.add(blobUrl);

    activeControllers.delete(downloadId);

    chrome.runtime.sendMessage({
      action: 'download_blob_ready',
      downloadId,
      mediaId,
      blobUrl,
      filename,
      sizeBytes: finalByteSize
    });

  } catch (err) {
    activeControllers.delete(downloadId);
    if (err.name === 'AbortError') {
      chrome.runtime.sendMessage({
        action: 'download_aborted',
        downloadId,
        mediaId
      }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({
        action: 'download_failed',
        downloadId,
        mediaId,
        error: err.message || 'Error de lectura del stream'
      }).catch(() => {});
    }
  }
}

async function handleManifestDownload(data, abortController, safeHeaders) {
  const { url, type } = data;
  if (type === 'mpd' || url.includes('.mpd')) {
    await downloadDashStreamOffscreen(data, abortController, safeHeaders);
    return;
  }
  await downloadHlsStreamOffscreen(data, abortController, safeHeaders);
}

/**
 * Calcula el CRC-32/MPEG-2 oficial (polinomio 0x04C11DB7, init 0xFFFFFFFF, sin XOR final)
 * indispensable para que VLC, Windows Media Player y QuickTime acepten una tabla PMT modificada.
 */
function crc32Mpeg2(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc ^= (bytes[i] << 24);
    for (let b = 0; b < 8; b++) {
      if ((crc & 0x80000000) !== 0) {
        crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
  }
  return crc >>> 0;
}

/**
 * Analiza un segmento MPEG-TS (.ts):
 * - Detecta el PID de la tabla PMT, el PID de video y si ya existe un descriptor de audio en la PMT.
 * - Si falta la entrada de audio en la PMT, reescribe todos los paquetes PMT del segmento añadiendo
 *   el stream_type de audio (0x0F ADTS AAC o 0x03 MP3) en audioPid (0x0101) con CRC-32/MPEG-2 exacto.
 */
function ensureAudioInMpegTsPmt(tsUint8, targetAudioPid = 0x0101, audioStreamType = 0x0F) {
  const PACKET_SIZE = 188;
  const len = tsUint8.byteLength;
  let pmtPid = -1;

  for (let pos = 0; pos + PACKET_SIZE <= len; pos += PACKET_SIZE) {
    if (tsUint8[pos] !== 0x47) continue;
    const pusi = !!(tsUint8[pos + 1] & 0x40);
    const pid = ((tsUint8[pos + 1] & 0x1F) << 8) | tsUint8[pos + 2];
    const afc = (tsUint8[pos + 3] >> 4) & 0x03;
    if (afc === 2 || afc === 0) continue;

    let payloadOffset = pos + 4;
    if (afc === 3) {
      payloadOffset += 1 + tsUint8[payloadOffset];
    }
    if (payloadOffset >= pos + PACKET_SIZE) continue;

    // PAT (PID 0)
    if (pid === 0 && pmtPid < 0) {
      let ptr = payloadOffset;
      if (pusi) ptr += 1 + tsUint8[ptr];
      if (ptr + 12 <= pos + PACKET_SIZE && tsUint8[ptr] === 0x00) {
        const sectionLen = ((tsUint8[ptr + 1] & 0x0F) << 8) | tsUint8[ptr + 2];
        const tableEnd = Math.min(pos + PACKET_SIZE, ptr + 3 + sectionLen - 4);
        let progPos = ptr + 8;
        while (progPos + 4 <= tableEnd) {
          const progNum = (tsUint8[progPos] << 8) | tsUint8[progPos + 1];
          const progPid = ((tsUint8[progPos + 2] & 0x1F) << 8) | tsUint8[progPos + 3];
          if (progNum !== 0) {
            pmtPid = progPid;
            break;
          }
          progPos += 4;
        }
      }
    } else if (pid === pmtPid && pmtPid > 0) {
      let ptr = payloadOffset;
      if (pusi) ptr += 1 + tsUint8[ptr];
      if (ptr + 12 <= pos + PACKET_SIZE && tsUint8[ptr] === 0x02) {
        const oldSectionLen = ((tsUint8[ptr + 1] & 0x0F) << 8) | tsUint8[ptr + 2];
        const progInfoLen = ((tsUint8[ptr + 10] & 0x0F) << 8) | tsUint8[ptr + 11];
        const esStart = ptr + 12 + progInfoLen;
        const crcOffset = ptr + 3 + oldSectionLen - 4;
        if (crcOffset + 4 > pos + PACKET_SIZE) continue;

        // Verificar si ya tiene registrado un stream de audio
        let hasAudioEntry = false;
        let esPos = esStart;
        while (esPos + 5 <= crcOffset) {
          const st = tsUint8[esPos];
          const esInfoLen = ((tsUint8[esPos + 3] & 0x0F) << 8) | tsUint8[esPos + 4];
          if (st === 0x0F || st === 0x11 || st === 0x03 || st === 0x04 || st === 0x81) {
            hasAudioEntry = true;
            break;
          }
          esPos += 5 + esInfoLen;
        }

        // Si no tiene audio y quedan al menos 5 bytes de relleno 0xFF en el paquete TS, insertar descriptor de audio + nuevo CRC32
        if (!hasAudioEntry && crcOffset + 9 <= pos + PACKET_SIZE) {
          const newSectionLen = oldSectionLen + 5;
          tsUint8[ptr + 1] = (tsUint8[ptr + 1] & 0xF0) | ((newSectionLen >> 8) & 0x0F);
          tsUint8[ptr + 2] = newSectionLen & 0xFF;

          // Incrementar version_number de la PMT para forzar al decodificador a leer ambos tracks
          const verByte = tsUint8[ptr + 5];
          const newVer = (((verByte >> 1) & 0x1F) + 1) & 0x1F;
          tsUint8[ptr + 5] = (verByte & 0xC1) | (newVer << 1) | 0x01;

          // Añadir entrada elemental de 5 bytes al final de la lista de streams
          tsUint8[crcOffset] = audioStreamType;
          tsUint8[crcOffset + 1] = 0xE0 | ((targetAudioPid >> 8) & 0x1F);
          tsUint8[crcOffset + 2] = targetAudioPid & 0xFF;
          tsUint8[crcOffset + 3] = 0xF0;
          tsUint8[crcOffset + 4] = 0x00;

          const newCrcOffset = crcOffset + 5;
          const sectionWithoutCrc = tsUint8.subarray(ptr, newCrcOffset);
          const crc = crc32Mpeg2(sectionWithoutCrc);
          tsUint8[newCrcOffset] = (crc >>> 24) & 0xFF;
          tsUint8[newCrcOffset + 1] = (crc >>> 16) & 0xFF;
          tsUint8[newCrcOffset + 2] = (crc >>> 8) & 0xFF;
          tsUint8[newCrcOffset + 3] = crc & 0xFF;
        }
      }
    }
  }
  return tsUint8;
}

/**
 * Remapea todos los paquetes de audio de un segmento MPEG-TS de solo audio al PID estándar targetAudioPid (0x0101)
 * y elimina sus paquetes PAT/PMT propios para que no sobrescriban la PMT combinada de Video+Audio.
 */
function extractAudioTsPacketsRemapped(audioTsUint8, targetAudioPid = 0x0101) {
  const PACKET_SIZE = 188;
  const len = audioTsUint8.byteLength;
  let pmtPid = -1;
  const outPackets = [];

  for (let pos = 0; pos + PACKET_SIZE <= len; pos += PACKET_SIZE) {
    if (audioTsUint8[pos] !== 0x47) continue;
    const pusi = !!(audioTsUint8[pos + 1] & 0x40);
    const pid = ((audioTsUint8[pos + 1] & 0x1F) << 8) | audioTsUint8[pos + 2];
    const afc = (audioTsUint8[pos + 3] >> 4) & 0x03;

    if (pid === 0) {
      let payloadOffset = pos + 4;
      if (afc === 3) payloadOffset += 1 + audioTsUint8[payloadOffset];
      let ptr = payloadOffset;
      if (pusi && ptr < pos + PACKET_SIZE) ptr += 1 + audioTsUint8[ptr];
      if (ptr + 12 <= pos + PACKET_SIZE && audioTsUint8[ptr] === 0x00) {
        const progNum = (audioTsUint8[ptr + 8] << 8) | audioTsUint8[ptr + 9];
        const progPid = ((audioTsUint8[ptr + 10] & 0x1F) << 8) | audioTsUint8[ptr + 11];
        if (progNum !== 0) pmtPid = progPid;
      }
      continue; // Omitir PAT del stream secundario
    }
    if (pid === pmtPid || pid === 0x1FFF || pid === 0x0011) {
      continue; // Omitir PMT, SDT y Null packets del stream secundario
    }

    const pktCopy = new Uint8Array(audioTsUint8.subarray(pos, pos + PACKET_SIZE));
    pktCopy[1] = (pktCopy[1] & 0xE0) | ((targetAudioPid >> 8) & 0x1F);
    pktCopy[2] = targetAudioPid & 0xFF;
    outPackets.push(pktCopy);
  }
  return outPackets.length > 0 ? concatUint8Arrays(outPackets) : null;
}

/**
 * Multiplexor ligero de paquetes MPEG-TS: si tenemos segmentos .ts de solo video y segmentos .ts/.aac/.mp3 de solo audio,
 * empaqueta el audio elemental en paquetes TS (PID 0x0101) y actualiza la PMT para que el archivo final tenga Video + Audio.
 */
function createAudioTsPacketsFromAdts(adtsBytes, continuityStart = 0, pts90k = 90000) {
  const PACKET_SIZE = 188;
  const AUDIO_PID = 0x0101;
  // Construir cabecera PES para el bloque de audio ADTS
  const pesHeader = new Uint8Array(14);
  pesHeader[0] = 0x00;
  pesHeader[1] = 0x00;
  pesHeader[2] = 0x01;
  pesHeader[3] = 0xC0; // Audio stream 0
  const pesPayloadLen = adtsBytes.byteLength + 8;
  pesHeader[4] = pesPayloadLen <= 0xFFFF ? (pesPayloadLen >> 8) & 0xFF : 0;
  pesHeader[5] = pesPayloadLen <= 0xFFFF ? pesPayloadLen & 0xFF : 0;
  pesHeader[6] = 0x80;
  pesHeader[7] = 0x80; // PTS only
  pesHeader[8] = 0x05;
  // Codificar PTS de 33 bits
  const pts = Math.max(0, Math.floor(pts90k));
  pesHeader[9] = 0x21 | (((pts / Math.pow(2, 30)) & 0x07) << 1);
  pesHeader[10] = (pts >> 22) & 0xFF;
  pesHeader[11] = 0x01 | (((pts >> 15) & 0x7F) << 1);
  pesHeader[12] = (pts >> 7) & 0xFF;
  pesHeader[13] = 0x01 | ((pts & 0x7F) << 1);

  const fullPes = concatUint8Arrays([pesHeader, adtsBytes]);
  const packets = [];
  let offset = 0;
  let cc = continuityStart & 0x0F;
  let isFirst = true;

  while (offset < fullPes.byteLength) {
    const pkt = new Uint8Array(PACKET_SIZE);
    pkt.fill(0xFF);
    pkt[0] = 0x47;
    pkt[1] = (isFirst ? 0x40 : 0x00) | ((AUDIO_PID >> 8) & 0x1F);
    pkt[2] = AUDIO_PID & 0xFF;

    const remaining = fullPes.byteLength - offset;
    if (remaining >= 184) {
      pkt[3] = 0x10 | cc;
      pkt.set(fullPes.subarray(offset, offset + 184), 4);
      offset += 184;
    } else {
      const stuffLen = 184 - remaining;
      pkt[3] = 0x30 | cc; // Adaptation field + payload
      pkt[4] = stuffLen - 1;
      if (stuffLen > 1) {
        pkt[5] = 0x00;
      }
      pkt.set(fullPes.subarray(offset, offset + remaining), 4 + stuffLen);
      offset += remaining;
    }
    cc = (cc + 1) & 0x0F;
    isFirst = false;
    packets.push(pkt);
  }
  return { packets: concatUint8Arrays(packets), nextCc: cc };
}

/**
 * Descarga y ensamblaje de fragmentos HLS (.m3u8).
 * Mejora v2.8:
 * - Garantiza que al descargar .MP4 SIEMPRE incluya Video + Audio:
 *   Si la variante de la calidad elegida tiene el audio separado en #EXT-X-MEDIA:TYPE=AUDIO (o companionAudioUrl),
 *   descarga simultáneamente la pista de video y la pista de audio y las multiplexa en memoria (fMP4 o MPEG-TS).
 */
async function downloadHlsStreamOffscreen(data, abortController, safeHeaders) {
  const { downloadId, mediaId, url: m3u8Url, filename: baseFilename, audioOnly, transcribeOnly } = data;
  const needsAudioExtraction = !!(audioOnly || transcribeOnly);

  const response = await fetch(m3u8Url, { headers: safeHeaders, signal: abortController.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} al leer el manifiesto HLS.`);
  const manifestText = await response.text();

  let targetPlaylistUrl = m3u8Url;
  let mediaPlaylistText = manifestText;
  let separateAudioPlaylistUrl = '';

  if (manifestText.includes('#EXT-X-STREAM-INF')) {
    const lines = manifestText.split(/\r?\n/);

    // Mapear todas las pistas #EXT-X-MEDIA:TYPE=AUDIO por GROUP-ID y la por defecto
    const audioGroups = new Map();
    let defaultAudioUri = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        const groupMatch = line.match(/GROUP-ID="([^"]+)"/);
        if (uriMatch && uriMatch[1]) {
          const absAudioUri = new URL(uriMatch[1], m3u8Url).href;
          if (groupMatch && groupMatch[1]) {
            if (!audioGroups.has(groupMatch[1]) || line.includes('DEFAULT=YES')) {
              audioGroups.set(groupMatch[1], absAudioUri);
            }
          }
          if (!defaultAudioUri || line.includes('DEFAULT=YES')) {
            defaultAudioUri = absAudioUri;
          }
        }
      }
    }

    // 1. Si solo necesitamos audio MP3 y existe pista dedicada #EXT-X-MEDIA:TYPE=AUDIO, usarla directo
    let dedicatedAudioUri = '';
    if (needsAudioExtraction && defaultAudioUri) {
      dedicatedAudioUri = defaultAudioUri;
      targetPlaylistUrl = dedicatedAudioUri;
      const audioVarResp = await fetch(targetPlaylistUrl, { headers: safeHeaders, signal: abortController.signal });
      if (audioVarResp.ok) {
        mediaPlaylistText = await audioVarResp.text();
      } else {
        dedicatedAudioUri = '';
      }
    }

    // 2. Selección de variante para Video MP4 (o fallback de audio si no hay pista dedicada)
    if (!dedicatedAudioUri) {
      const targetHeight = parseInt(data.qualityOptions?.videoQuality, 10) || 9999;
      const variants = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
          const codecsMatch = line.match(/CODECS="([^"]+)"/i);
          const audioGroupMatch = line.match(/AUDIO="([^"]+)"/i);

          const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const height = resMatch ? parseInt(resMatch[2], 10) : 0;
          const codecs = codecsMatch ? codecsMatch[1].toLowerCase() : '';
          const audioGroupId = audioGroupMatch ? audioGroupMatch[1] : '';

          const isExplicitVideoOnly =
            codecs.length > 0 &&
            /(avc1|vp0?9|hev1|hvc1|av01)/.test(codecs) &&
            !/(mp4a|opus|vorbis|ac-3|ec-3|aac)/.test(codecs);

          let nextIndex = i + 1;
          while (nextIndex < lines.length && (!lines[nextIndex].trim() || lines[nextIndex].startsWith('#'))) {
            nextIndex++;
          }
          if (nextIndex < lines.length) {
            variants.push({
              uri: lines[nextIndex].trim(),
              bandwidth,
              height,
              codecs,
              audioGroupId,
              isExplicitVideoOnly
            });
          }
        }
      }

      if (variants.length > 0) {
        let pool = variants;
        if (needsAudioExtraction) {
          const withAudio = variants.filter(v => !v.isExplicitVideoOnly);
          if (withAudio.length > 0) pool = withAudio;
          pool.sort((a, b) => (a.bandwidth || Number.MAX_SAFE_INTEGER) - (b.bandwidth || Number.MAX_SAFE_INTEGER));
        } else {
          // Para descarga de video .MP4: Preferir variantes con Video+Audio integrados a menos que exista pista de audio externa para multiplexar
          const hasExternalAudioTrack = (defaultAudioUri.length > 0 || !!(data.companionAudioUrl));
          if (!hasExternalAudioTrack) {
            const muxedVariants = pool.filter(v => !v.isExplicitVideoOnly);
            if (muxedVariants.length > 0) {
              pool = muxedVariants;
            }
          }
          const withinCap = pool.filter(v => v.height > 0 && v.height <= targetHeight);
          if (withinCap.length > 0) {
            withinCap.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
            pool = withinCap;
          } else {
            pool.sort((a, b) => b.bandwidth - a.bandwidth);
          }
        }

        const chosenVariant = pool[0];
        if (chosenVariant && chosenVariant.uri) {
          targetPlaylistUrl = new URL(chosenVariant.uri, m3u8Url).href;
          const varResp = await fetch(targetPlaylistUrl, { headers: safeHeaders, signal: abortController.signal });
          if (!varResp.ok) throw new Error(`HTTP ${varResp.status} al leer variante HLS.`);
          mediaPlaylistText = await varResp.text();

          // Si estamos descargando Video .MP4 y la variante elegida tiene pista de audio externa (AUDIO="group" o es Video-Only),
          // activar la descarga dual de la playlist de audio para fusionar Video + Audio en el MP4 final
          if (!needsAudioExtraction) {
            if (chosenVariant.audioGroupId && audioGroups.has(chosenVariant.audioGroupId)) {
              separateAudioPlaylistUrl = audioGroups.get(chosenVariant.audioGroupId);
            } else if (chosenVariant.isExplicitVideoOnly && defaultAudioUri) {
              separateAudioPlaylistUrl = defaultAudioUri;
            }
          }
        }
      }
    }
  } else if (!needsAudioExtraction && data.companionAudioUrl && data.companionAudioUrl.includes('.m3u8') && data.companionAudioUrl !== m3u8Url) {
    // Si el usuario pinchó directamente un sub-manifiesto HLS y background.js capturó el sub-manifiesto hermano
    separateAudioPlaylistUrl = data.companionAudioUrl;
  }

  function parseMediaPlaylist(playlistStr, baseUrl) {
    const pLines = playlistStr.split(/\r?\n/);
    const entries = [];
    let mapUrl = null;
    let encKey = null;
    let seqBase = 0;

    for (let i = 0; i < pLines.length; i++) {
      const line = pLines[i].trim();
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seqBase = parseInt(line.split(':')[1] || '0', 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([^,\s]+)/);
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);
        const method = methodMatch ? methodMatch[1] : 'NONE';
        if (method === 'AES-128' && uriMatch && uriMatch[1]) {
          encKey = {
            method: 'AES-128',
            uri: new URL(uriMatch[1], baseUrl).href,
            ivHex: ivMatch ? ivMatch[1] : null
          };
        } else if (method === 'NONE') {
          encKey = null;
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const mapMatch = line.match(/URI="([^"]+)"/);
        if (mapMatch && mapMatch[1]) {
          mapUrl = new URL(mapMatch[1], baseUrl).href;
        }
      } else if (line && !line.startsWith('#')) {
        entries.push({
          url: new URL(line, baseUrl).href,
          seq: seqBase + entries.length,
          keyInfo: encKey ? { ...encKey } : null
        });
      }
    }
    return { entries, initMapUrl: mapUrl };
  }

  const primaryParsed = parseMediaPlaylist(mediaPlaylistText, targetPlaylistUrl);
  const segmentEntries = primaryParsed.entries;
  const initMapUrl = primaryParsed.initMapUrl;

  if (segmentEntries.length === 0) {
    throw new Error('No se encontraron fragmentos multimedia en la lista HLS.');
  }

  // Si hay una playlist de audio separada para fusionar con el video, parsearla también
  let audioPlaylistParsed = null;
  if (separateAudioPlaylistUrl && separateAudioPlaylistUrl !== targetPlaylistUrl) {
    try {
      const aPlResp = await fetch(separateAudioPlaylistUrl, { headers: safeHeaders, signal: abortController.signal });
      if (aPlResp.ok) {
        const aPlText = await aPlResp.text();
        const parsedA = parseMediaPlaylist(aPlText, separateAudioPlaylistUrl);
        if (parsedA.entries.length > 0) {
          audioPlaylistParsed = parsedA;
        }
      }
    } catch (e) {
      console.warn('No se pudo cargar la playlist de audio secundaria HLS:', e);
    }
  }

  // Caché de llaves CryptoKey AES-128 para desencriptar al vuelo (Hotmart, Kajabi, Teachable, Cloudflare, BunnyCDN)
  const aesKeyCache = new Map();
  async function getAesCryptoKey(keyUri) {
    if (aesKeyCache.has(keyUri)) return aesKeyCache.get(keyUri);
    const keyResp = await fetch(keyUri, { headers: safeHeaders, signal: abortController.signal });
    if (!keyResp.ok) throw new Error(`No se pudo obtener llave HLS AES-128 (HTTP ${keyResp.status})`);
    const keyBuf = await keyResp.arrayBuffer();
    const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
    aesKeyCache.set(keyUri, cryptoKey);
    return cryptoKey;
  }

  async function decryptAes128Segment(encryptedBuffer, keyInfo, seqNum) {
    if (!keyInfo || keyInfo.method !== 'AES-128') return encryptedBuffer;
    const cryptoKey = await getAesCryptoKey(keyInfo.uri);
    const iv = new Uint8Array(16);
    if (keyInfo.ivHex) {
      const cleanHex = keyInfo.ivHex.padStart(32, '0');
      for (let b = 0; b < 16; b++) {
        iv[b] = parseInt(cleanHex.substring(b * 2, b * 2 + 2), 16);
      }
    } else {
      const view = new DataView(iv.buffer);
      view.setUint32(12, seqNum, false);
    }
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encryptedBuffer);
  }

  let initMapBuffer = null;
  if (initMapUrl) {
    try {
      const mapResp = await fetch(initMapUrl, { headers: safeHeaders, signal: abortController.signal });
      if (mapResp.ok) {
        initMapBuffer = await mapResp.arrayBuffer();
      }
    } catch (e) {}
  }

  const totalSegments = segmentEntries.length;
  let downloadedCount = 0;
  let totalReceivedBytes = initMapBuffer ? initMapBuffer.byteLength : 0;
  const segmentBuffers = new Array(totalSegments);
  const CONCURRENCY_LIMIT = 4;
  let currentIndex = 0;
  let lastProgressTime = 0;

  async function worker() {
    while (currentIndex < totalSegments) {
      if (abortController.signal.aborted) break;
      const idx = currentIndex++;
      const entry = segmentEntries[idx];
      const segUrl = entry.url;
      try {
        const segResp = await fetch(segUrl, { headers: safeHeaders, signal: abortController.signal });
        if (!segResp.ok) throw new Error(`HTTP ${segResp.status}`);
        let buffer = await segResp.arrayBuffer();
        if (entry.keyInfo) {
          buffer = await decryptAes128Segment(buffer, entry.keyInfo, entry.seq);
        }
        segmentBuffers[idx] = buffer;
        downloadedCount++;
        totalReceivedBytes += buffer.byteLength;
      } catch (e) {
        if (abortController.signal.aborted) break;
        try {
          const retryResp = await fetch(segUrl, { headers: safeHeaders, signal: abortController.signal });
          if (retryResp.ok) {
            let buffer = await retryResp.arrayBuffer();
            if (entry.keyInfo) {
              buffer = await decryptAes128Segment(buffer, entry.keyInfo, entry.seq);
            }
            segmentBuffers[idx] = buffer;
            downloadedCount++;
            totalReceivedBytes += buffer.byteLength;
          }
        } catch (err2) {}
      }

      const now = Date.now();
      if (now - lastProgressTime > 300 || downloadedCount === totalSegments) {
        lastProgressTime = now;
        const estTotal = downloadedCount > 0 ? (totalReceivedBytes / downloadedCount) * totalSegments : 0;
        const maxPct = transcribeOnly ? 40 : (audioOnly ? 50 : 100);
        const scaledPct = Math.floor((downloadedCount / totalSegments) * maxPct);
        chrome.runtime.sendMessage({
          action: 'download_progress',
          downloadId,
          mediaId,
          transcribeOnly,
          phase: 'downloading',
          statusMessage: `Descargando fragmentos HLS: ${downloadedCount}/${totalSegments}`,
          receivedBytes: totalReceivedBytes,
          totalBytes: Math.round(estTotal),
          percent: scaledPct
        }).catch(() => {});
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY_LIMIT, totalSegments); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (abortController.signal.aborted) return;

  const validBuffers = [];
  if (initMapBuffer) validBuffers.push(initMapBuffer);
  for (const b of segmentBuffers) {
    if (b != null) validBuffers.push(b);
  }

  if (validBuffers.length === 0) {
    throw new Error('No se pudieron descargar los fragmentos del flujo HLS.');
  }

  // Si existe una playlist de audio separada (ej. #EXT-X-MEDIA:TYPE=AUDIO en 1080p/720p), descargar sus fragmentos y multiplexar con el video
  let audioSegmentBuffers = null;
  let audioInitMapBuffer = null;
  if (!audioOnly && audioPlaylistParsed && audioPlaylistParsed.entries.length > 0) {
    const aEntries = audioPlaylistParsed.entries;
    if (audioPlaylistParsed.initMapUrl) {
      try {
        const aMapResp = await fetch(audioPlaylistParsed.initMapUrl, { headers: safeHeaders, signal: abortController.signal });
        if (aMapResp.ok) {
          audioInitMapBuffer = await aMapResp.arrayBuffer();
        }
      } catch (e) {}
    }

    const totalASegs = aEntries.length;
    audioSegmentBuffers = new Array(totalASegs);
    let aDownloaded = 0;
    let aIndex = 0;

    async function audioHlsWorker() {
      while (aIndex < totalASegs) {
        if (abortController.signal.aborted) break;
        const idx = aIndex++;
        const entry = aEntries[idx];
        try {
          const resp = await fetch(entry.url, { headers: safeHeaders, signal: abortController.signal });
          if (resp.ok) {
            let buf = await resp.arrayBuffer();
            if (entry.keyInfo) {
              buf = await decryptAes128Segment(buf, entry.keyInfo, entry.seq);
            }
            audioSegmentBuffers[idx] = buf;
            aDownloaded++;
            totalReceivedBytes += buf.byteLength;
          }
        } catch (e) {}

        const now = Date.now();
        if (now - lastProgressTime > 300 || aDownloaded === totalASegs) {
          lastProgressTime = now;
          chrome.runtime.sendMessage({
            action: 'download_progress',
            downloadId,
            mediaId,
            phase: 'downloading',
            statusMessage: `Integrando pista de audio HLS: ${aDownloaded}/${totalASegs}`,
            receivedBytes: totalReceivedBytes,
            totalBytes: totalReceivedBytes,
            percent: Math.min(98, 85 + Math.floor((aDownloaded / totalASegs) * 13))
          }).catch(() => {});
        }
      }
    }

    const aWorkers = [];
    for (let w = 0; w < Math.min(CONCURRENCY_LIMIT, totalASegs); w++) {
      aWorkers.push(audioHlsWorker());
    }
    await Promise.all(aWorkers);
  }

  let finalBlob;
  if (!audioOnly && audioSegmentBuffers) {
    const validAudioSegs = audioSegmentBuffers.filter(b => b != null);
    if (initMapBuffer && audioInitMapBuffer && validAudioSegs.length > 0) {
      // Caso 1: HLS fMP4 (CMAF) -> Combinar moov de video y audio (track 1 + track 2) e intercalar fragmentos .m4s
      const combinedInit = createCombinedInit(new Uint8Array(initMapBuffer), new Uint8Array(audioInitMapBuffer));
      const muxedParts = [combinedInit];
      const vOnlySegs = segmentBuffers.filter(b => b != null);
      const maxLen = Math.max(vOnlySegs.length, validAudioSegs.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < vOnlySegs.length) muxedParts.push(new Uint8Array(vOnlySegs[i]));
        if (i < validAudioSegs.length) {
          const aArr = new Uint8Array(validAudioSegs[i]);
          changeTrackIdInBytes(aArr, 1, 2);
          muxedParts.push(aArr);
        }
      }
      finalBlob = new Blob(muxedParts, { type: 'video/mp4' });
    } else if (validAudioSegs.length > 0) {
      // Caso 2: HLS MPEG-TS o Audio AAC separado -> Reescribir PMT con CRC-32/MPEG-2 (PID 0x0101) e intercalar paquetes
      const vOnlySegs = segmentBuffers.filter(b => b != null);
      const muxedTsParts = [];
      let cc = 0;
      const maxLen = Math.max(vOnlySegs.length, validAudioSegs.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < vOnlySegs.length) {
          const vSegCopy = new Uint8Array(vOnlySegs[i].slice(0));
          ensureAudioInMpegTsPmt(vSegCopy, 0x0101, 0x0F);
          muxedTsParts.push(vSegCopy);
        }
        if (i < validAudioSegs.length) {
          const aSegU8 = new Uint8Array(validAudioSegs[i]);
          const isAlreadyTs = aSegU8.byteLength >= 188 && aSegU8[0] === 0x47;
          if (isAlreadyTs) {
            const remapped = extractAudioTsPacketsRemapped(aSegU8, 0x0101);
            if (remapped) muxedTsParts.push(remapped);
          } else {
            const wrapped = createAudioTsPacketsFromAdts(aSegU8, cc, (i + 1) * 90000 * 4);
            cc = wrapped.nextCc;
            muxedTsParts.push(wrapped.packets);
          }
        }
      }
      finalBlob = new Blob(muxedTsParts, { type: 'video/mp2t' });
    } else {
      finalBlob = new Blob(validBuffers, { type: initMapBuffer ? 'video/mp4' : 'video/mp2t' });
    }
  } else if (!audioOnly && data.companionAudioUrl && !data.companionAudioUrl.includes('.m3u8')) {
    // Caso 3: El video vino por HLS MPEG-TS de solo video, pero el audio en la pestaña vino por un stream directo (ej. audio/webm o audio/mp4 en YouTube)
    const vOnlySegs = segmentBuffers.filter(b => b != null);
    const firstSegU8 = vOnlySegs.length > 0 ? new Uint8Array(vOnlySegs[0]) : null;
    const hasEmbeddedAudio = firstSegU8 ? !!(extractElementaryAudioFromMpegTs(firstSegU8)) : true;

    if (!hasEmbeddedAudio && vOnlySegs.length > 0) {
      try {
        chrome.runtime.sendMessage({
          action: 'download_progress',
          downloadId,
          mediaId,
          phase: 'downloading',
          statusMessage: 'Descargando y sincronizando pista de audio al video...',
          receivedBytes: totalReceivedBytes,
          totalBytes: totalReceivedBytes,
          percent: 90
        }).catch(() => {});

        const compResp = await fetch(data.companionAudioUrl, { headers: safeHeaders, signal: abortController.signal });
        if (compResp.ok) {
          const compBuf = await compResp.arrayBuffer();
          const decodedAudio = await decodeMediaBytesToAudioBuffer(compBuf, compResp.headers.get('content-type') || 'audio/mp4');
          const mp3AudioBlob = await encodeAudioBufferToMp3(decodedAudio, downloadId, mediaId, abortController, 91, 98, 128);
          const mp3AudioU8 = new Uint8Array(await mp3AudioBlob.arrayBuffer());

          // Dividir el MP3 en tantos trozos como segmentos de video e inyectarlo en PID 0x0101 con stream_type 0x03 (MPEG Audio) en la PMT
          const muxedTsParts = [];
          const chunkSize = Math.max(1024, Math.ceil(mp3AudioU8.byteLength / vOnlySegs.length));
          let cc = 0;
          for (let i = 0; i < vOnlySegs.length; i++) {
            const vSegCopy = new Uint8Array(vOnlySegs[i].slice(0));
            ensureAudioInMpegTsPmt(vSegCopy, 0x0101, 0x03);
            muxedTsParts.push(vSegCopy);

            const aStart = i * chunkSize;
            if (aStart < mp3AudioU8.byteLength) {
              const aSlice = mp3AudioU8.subarray(aStart, Math.min(mp3AudioU8.byteLength, aStart + chunkSize));
              const wrapped = createAudioTsPacketsFromAdts(aSlice, cc, (i + 1) * 90000 * 4);
              cc = wrapped.nextCc;
              muxedTsParts.push(wrapped.packets);
            }
          }
          finalBlob = new Blob(muxedTsParts, { type: 'video/mp2t' });
        } else {
          finalBlob = new Blob(validBuffers, { type: initMapBuffer ? 'video/mp4' : 'video/mp2t' });
        }
      } catch (compMuxErr) {
        console.warn('Error en muxing de companionAudioUrl sobre HLS TS:', compMuxErr);
        finalBlob = new Blob(validBuffers, { type: initMapBuffer ? 'video/mp4' : 'video/mp2t' });
      }
    } else {
      finalBlob = new Blob(validBuffers, { type: initMapBuffer ? 'video/mp4' : 'video/mp2t' });
    }
  } else {
    finalBlob = new Blob(validBuffers, { type: initMapBuffer ? 'video/mp4' : 'video/mp2t' });
  }
  segmentBuffers.length = 0;

  if (audioOnly) {
    chrome.runtime.sendMessage({
      action: 'download_progress',
      downloadId,
      mediaId,
      phase: 'decoding',
      statusMessage: 'Demultiplexando y decodificando audio HLS...',
      receivedBytes: totalReceivedBytes,
      totalBytes: totalReceivedBytes,
      percent: 50
    }).catch(() => {});

    let audioBuf;
    try {
      const tsBuf = await finalBlob.arrayBuffer();
      audioBuf = await decodeMediaBytesToAudioBuffer(tsBuf, initMapBuffer ? 'video/mp4' : 'video/mp2t');
    } catch (bulkErr) {
      console.warn('Fallo decodeAudioData global en HLS, aplicando decodificación por lotes de segmentos:', bulkErr);
      try {
        audioBuf = await decodeSegmentsListToAudioBuffer(validBuffers, initMapBuffer);
      } catch (segErr) {
        // Si el usuario pinchó un sub-manifiesto que era 100% Video-Only y tenemos companionAudioUrl en la pestaña, descargar y decodificar el companion
        if (data.companionAudioUrl && data.companionAudioUrl !== m3u8Url) {
          const compData = { ...data, url: data.companionAudioUrl, companionAudioUrl: null };
          return await handleStreamDownload(compData);
        }
        throw segErr;
      }
    }

    const audioKbps = parseInt(data.qualityOptions?.audioKbps, 10) || 128;
    const mp3Blob = await encodeAudioBufferToMp3(audioBuf, downloadId, mediaId, abortController, 50, 99, audioKbps);
    const blobUrl = URL.createObjectURL(mp3Blob);
    createdBlobUrls.add(blobUrl);

    let cleanName = baseFilename.replace(/\.(m3u8|mpd|ts|mp4|webm|mp3|htm|html)$/i, '') + '.mp3';
    activeControllers.delete(downloadId);

    chrome.runtime.sendMessage({
      action: 'download_blob_ready',
      downloadId,
      mediaId,
      blobUrl,
      filename: cleanName,
      sizeBytes: mp3Blob.size
    });
    return;
  }

  const blobUrl = URL.createObjectURL(finalBlob);
  createdBlobUrls.add(blobUrl);

  let cleanName = baseFilename.replace(/\.(m3u8|mpd|ts|htm|html)$/i, '');
  if (!cleanName.endsWith('.mp4') && !cleanName.endsWith('.ts')) {
    cleanName += '.mp4';
  }

  activeControllers.delete(downloadId);

  chrome.runtime.sendMessage({
    action: 'download_blob_ready',
    downloadId,
    mediaId,
    blobUrl,
    filename: cleanName,
    sizeBytes: totalReceivedBytes
  });
}

// ==========================================
// 4. MP3 Audio Encoder (lamejs optimizado sin picos de memoria)
// ==========================================

async function encodeAudioBufferToMp3(audioBuffer, downloadId, mediaId, abortController, startPercent = 50, endPercent = 99, kbps = 128) {
  const rawChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const leftCopy = new Float32Array(audioBuffer.getChannelData(0));
  const rightCopy = rawChannels > 1 ? new Float32Array(audioBuffer.getChannelData(1)) : null;

  if (abortController?.signal?.aborted) {
    throw new Error('Codificación abortada');
  }

  const worker = getAiWorker();
  const transferList = [leftCopy.buffer];
  if (rightCopy) transferList.push(rightCopy.buffer);

  return await new Promise((resolve, reject) => {
    pendingWorkerTasks.set(downloadId, { resolve, reject });
    worker.postMessage(
      {
        action: 'encode_mp3',
        downloadId,
        mediaId,
        leftFloat: leftCopy,
        rightFloat: rightCopy,
        rawChannels,
        sampleRate,
        kbps,
        startPercent,
        endPercent,
        lameUrl: chrome.runtime.getURL('lame.min.js')
      },
      transferList
    );
  });
}

// ==========================================
// 5. fMP4 (ISO BMFF) Box Parser & DASH Multiplexer
// ==========================================

function findBoxInUint8(arr, boxTypeStr, start = 0, end = arr.byteLength) {
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(arr[offset + 4], arr[offset + 5], arr[offset + 6], arr[offset + 7]);
    if (type === boxTypeStr) {
      return { offset, size };
    }
    if (size <= 0) break;
    offset += size;
  }
  return null;
}

function concatUint8Arrays(arrays) {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.byteLength;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
}

function changeTrackIdInBytes(uint8Arr, oldId, newId) {
  const view = new DataView(uint8Arr.buffer, uint8Arr.byteOffset, uint8Arr.byteLength);
  const len = uint8Arr.byteLength;
  for (let i = 0; i <= len - 8; i++) {
    if (uint8Arr[i] === 0x74 && uint8Arr[i + 1] === 0x6b && uint8Arr[i + 2] === 0x68 && uint8Arr[i + 3] === 0x64) {
      const ver = uint8Arr[i + 4];
      const idOffset = (ver === 0) ? i + 4 + 4 + 8 : i + 4 + 4 + 16;
      if (idOffset + 4 <= len && view.getUint32(idOffset) === oldId) {
        view.setUint32(idOffset, newId);
      }
    } else if (uint8Arr[i] === 0x74 && uint8Arr[i + 1] === 0x72 && uint8Arr[i + 2] === 0x65 && uint8Arr[i + 3] === 0x78) {
      const idOffset = i + 4 + 4;
      if (idOffset + 4 <= len && view.getUint32(idOffset) === oldId) {
        view.setUint32(idOffset, newId);
      }
    } else if (uint8Arr[i] === 0x74 && uint8Arr[i + 1] === 0x66 && uint8Arr[i + 2] === 0x68 && uint8Arr[i + 3] === 0x64) {
      const idOffset = i + 4 + 4;
      if (idOffset + 4 <= len && view.getUint32(idOffset) === oldId) {
        view.setUint32(idOffset, newId);
      }
    }
  }
}

function createCombinedInit(vInitArr, aInitArr) {
  try {
    const aInitCopy = new Uint8Array(aInitArr);
    changeTrackIdInBytes(aInitCopy, 1, 2);

    const aMoovInfo = findBoxInUint8(aInitCopy, 'moov');
    if (!aMoovInfo) return vInitArr;

    const aTrakInfo = findBoxInUint8(aInitCopy, 'trak', aMoovInfo.offset + 8, aMoovInfo.offset + aMoovInfo.size);
    if (!aTrakInfo) return vInitArr;
    const aTrakBytes = aInitCopy.subarray(aTrakInfo.offset, aTrakInfo.offset + aTrakInfo.size);

    const aMvexInfo = findBoxInUint8(aInitCopy, 'mvex', aMoovInfo.offset + 8, aMoovInfo.offset + aMoovInfo.size);
    if (!aMvexInfo) return vInitArr;
    const aTrexInfo = findBoxInUint8(aInitCopy, 'trex', aMvexInfo.offset + 8, aMvexInfo.offset + aMvexInfo.size);
    if (!aTrexInfo) return vInitArr;
    const aTrexBytes = aInitCopy.subarray(aTrexInfo.offset, aTrexInfo.offset + aTrexInfo.size);

    const vFtypInfo = findBoxInUint8(vInitArr, 'ftyp');
    if (!vFtypInfo) return vInitArr;
    const vFtypBytes = vInitArr.subarray(vFtypInfo.offset, vFtypInfo.offset + vFtypInfo.size);

    const vMoovInfo = findBoxInUint8(vInitArr, 'moov');
    if (!vMoovInfo) return vInitArr;
    const vMvexInfo = findBoxInUint8(vInitArr, 'mvex', vMoovInfo.offset + 8, vMoovInfo.offset + vMoovInfo.size);
    if (!vMvexInfo) return vInitArr;

    const newMvexSize = vMvexInfo.size + aTrexBytes.byteLength;
    const newMvex = new Uint8Array(newMvexSize);
    newMvex.set(vInitArr.subarray(vMvexInfo.offset, vMvexInfo.offset + vMvexInfo.size), 0);
    new DataView(newMvex.buffer, newMvex.byteOffset, newMvex.byteLength).setUint32(0, newMvexSize);
    newMvex.set(aTrexBytes, vMvexInfo.size);

    const vMoovPart1 = vInitArr.subarray(vMoovInfo.offset + 8, vMvexInfo.offset);
    const vMoovPart4 = vInitArr.subarray(vMvexInfo.offset + vMvexInfo.size, vMoovInfo.offset + vMoovInfo.size);

    const newMoovContent = concatUint8Arrays([vMoovPart1, aTrakBytes, newMvex, vMoovPart4]);
    const newMoovSize = 8 + newMoovContent.byteLength;
    const newMoovHeader = new Uint8Array(8);
    const headerView = new DataView(newMoovHeader.buffer);
    headerView.setUint32(0, newMoovSize);
    newMoovHeader[4] = 0x6d;
    newMoovHeader[5] = 0x6f;
    newMoovHeader[6] = 0x6f;
    newMoovHeader[7] = 0x76;

    return concatUint8Arrays([vFtypBytes, newMoovHeader, newMoovContent]);
  } catch (err) {
    console.warn('Error combinando moov de video y audio, usando video original:', err);
    return vInitArr;
  }
}

async function downloadDashStreamOffscreen(data, abortController, safeHeaders) {
  const { downloadId, mediaId, url: mpdUrl, filename: baseFilename, audioOnly, transcribeOnly } = data;
  const needsAudioExtraction = !!(audioOnly || transcribeOnly);

  const mpdResp = await fetch(mpdUrl, { headers: safeHeaders, signal: abortController.signal });
  if (!mpdResp.ok) throw new Error(`HTTP ${mpdResp.status} al leer manifest.mpd`);
  const mpdXml = await mpdResp.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(mpdXml, 'application/xml');

  const adaptationSets = Array.from(doc.querySelectorAll('AdaptationSet'));
  let videoSet = adaptationSets.find(as => {
    const ct = (as.getAttribute('contentType') || as.getAttribute('mimeType') || '').toLowerCase();
    return ct.includes('video');
  }) || adaptationSets[0];

  if (!videoSet) throw new Error('No se encontraron pistas de video en el manifiesto DASH.');

  let audioSet = adaptationSets.find(as => {
    const ct = (as.getAttribute('contentType') || as.getAttribute('mimeType') || '').toLowerCase();
    return ct.includes('audio');
  });

  function getBestRep(setElem, maxHeight = 9999) {
    if (!setElem) return null;
    const reps = Array.from(setElem.querySelectorAll('Representation'));
    if (reps.length === 0) return setElem;
    const filtered = reps.filter(r => {
      const h = parseInt(r.getAttribute('height') || '0', 10);
      return h === 0 || h <= maxHeight;
    });
    const pool = filtered.length > 0 ? filtered : reps;
    pool.sort((a, b) => {
      const bwA = parseInt(a.getAttribute('bandwidth') || '0', 10);
      const bwB = parseInt(b.getAttribute('bandwidth') || '0', 10);
      return bwB - bwA;
    });
    return pool[0];
  }

  const targetVideoHeight = parseInt(data.qualityOptions?.videoQuality, 10) || 9999;
  const vRep = getBestRep(videoSet, targetVideoHeight);
  const aRep = audioSet ? getBestRep(audioSet, 9999) : null;

  function getBaseUrl(setElem, repElem) {
    const repBase = repElem?.querySelector('BaseURL')?.textContent?.trim();
    const setBase = setElem?.querySelector('BaseURL')?.textContent?.trim();
    const docBase = doc.querySelector('BaseURL')?.textContent?.trim();
    const chosen = repBase || setBase || docBase;
    if (chosen) {
      if (chosen.startsWith('http://') || chosen.startsWith('https://')) {
        return chosen;
      }
      return new URL(chosen, mpdUrl).href;
    }
    return mpdUrl;
  }

  const vBase = getBaseUrl(videoSet, vRep);
  const aBase = audioSet ? getBaseUrl(audioSet, aRep) : '';

  if (vBase && vBase.split('?')[0].toLowerCase().endsWith('.mp4')) {
    const directUrl = (needsAudioExtraction && aBase && aBase.split('?')[0].toLowerCase().endsWith('.mp4')) ? aBase : vBase;
    const directResp = await fetch(directUrl, { headers: safeHeaders, signal: abortController.signal });
    if (!directResp.ok) throw new Error(`HTTP ${directResp.status} al descargar video MP4 directo`);
    const blob = await directResp.blob();

    if (needsAudioExtraction) {
      const rawBuf = await blob.arrayBuffer();
      const audioBuf = await decodeMediaBytesToAudioBuffer(rawBuf, 'video/mp4');

      const audioKbps = parseInt(data.qualityOptions?.audioKbps, 10) || 128;
      const mp3Blob = await encodeAudioBufferToMp3(audioBuf, downloadId, mediaId, abortController, 50, 99, audioKbps);
      const blobUrl = URL.createObjectURL(mp3Blob);
      createdBlobUrls.add(blobUrl);

      activeControllers.delete(downloadId);
      let cleanName = baseFilename.replace(/\.(mpd|m3u8|mp4|ts|webm|mp3|htm|html)$/i, '') + '.mp3';

      chrome.runtime.sendMessage({
        action: 'download_blob_ready',
        downloadId,
        mediaId,
        blobUrl,
        filename: cleanName,
        sizeBytes: mp3Blob.size
      });
      return;
    }

    const blobUrl = URL.createObjectURL(blob);
    createdBlobUrls.add(blobUrl);

    activeControllers.delete(downloadId);
    let cleanName = baseFilename.replace(/\.(mpd|m3u8|ts|htm|html)$/i, '');
    if (!cleanName.endsWith('.mp4')) cleanName += '.mp4';

    chrome.runtime.sendMessage({
      action: 'download_blob_ready',
      downloadId,
      mediaId,
      blobUrl,
      filename: cleanName,
      sizeBytes: blob.size
    });
    return;
  }

  const vSegTemplate = vRep?.querySelector('SegmentTemplate') || videoSet?.querySelector('SegmentTemplate') || doc.querySelector('SegmentTemplate');
  const aSegTemplate = audioSet ? (aRep?.querySelector('SegmentTemplate') || audioSet?.querySelector('SegmentTemplate')) : null;
  const vSegList = vRep?.querySelector('SegmentList') || videoSet?.querySelector('SegmentList');
  const aSegList = audioSet ? (aRep?.querySelector('SegmentList') || audioSet?.querySelector('SegmentList')) : null;

  if (!vSegTemplate && !vSegList) throw new Error('Formato DASH sin SegmentTemplate ni SegmentList compatible.');

  function generateTrackUrls(segTemplate, segList, repElem, setElem, baseUrl) {
    if (segList && !segTemplate) {
      const initNode = segList.querySelector('Initialization');
      const initSource = initNode?.getAttribute('sourceURL');
      const initUrl = initSource ? new URL(initSource, baseUrl).href : null;
      const segNodes = Array.from(segList.querySelectorAll('SegmentURL'));
      const chunkUrls = segNodes
        .map(n => n.getAttribute('media'))
        .filter(Boolean)
        .map(m => new URL(m, baseUrl).href);
      return { initUrl, chunkUrls };
    }
    if (!segTemplate) return { initUrl: null, chunkUrls: [] };
    const repId = repElem?.getAttribute('id') || setElem?.getAttribute('id') || '0';
    const initAttr = segTemplate.getAttribute('initialization');
    const mediaAttr = segTemplate.getAttribute('media');
    const startNumber = parseInt(segTemplate.getAttribute('startNumber') || '1', 10);

    const cleanInit = initAttr ? initAttr.replace(/&amp;/g, '&').replace('$RepresentationID$', repId) : null;
    const initUrl = cleanInit ? new URL(cleanInit, baseUrl).href : null;

    if (!mediaAttr) return { initUrl, chunkUrls: [] };
    const cleanMedia = mediaAttr.replace(/&amp;/g, '&');

    function formatUrl(num, time) {
      const numPadded = String(num).padStart(5, '0');
      const rel = cleanMedia
        .replace('$RepresentationID$', repId)
        .replace('$Number%05d$', numPadded)
        .replace('$Number%04d$', String(num).padStart(4, '0'))
        .replace('$Number%02d$', String(num).padStart(2, '0'))
        .replace('$Number$', String(num))
        .replace('$Time$', String(time));
      return new URL(rel, baseUrl).href;
    }

    const chunkUrls = [];
    const timelineNode = segTemplate.querySelector('SegmentTimeline');
    if (timelineNode) {
      const sNodes = Array.from(timelineNode.querySelectorAll('S'));
      let currentTime = 0;
      let segIndex = startNumber;

      for (const s of sNodes) {
        if (s.getAttribute('t')) {
          currentTime = parseInt(s.getAttribute('t'), 10);
        }
        const d = parseInt(s.getAttribute('d'), 10);
        const r = parseInt(s.getAttribute('r') || '0', 10);

        for (let rep = 0; rep <= r; rep++) {
          chunkUrls.push(formatUrl(segIndex, currentTime));
          currentTime += d;
          segIndex++;
        }
      }
    } else {
      const duration = parseInt(segTemplate.getAttribute('duration') || '0', 10);
      const timescale = parseInt(segTemplate.getAttribute('timescale') || '1', 10);
      const mediaDurationAttr = doc.querySelector('MPD')?.getAttribute('mediaPresentationDuration');
      let totalSecs = 60;
      if (mediaDurationAttr) {
        const match = mediaDurationAttr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
        if (match) {
          totalSecs = (parseInt(match[1] || '0', 10) * 3600) +
                      (parseInt(match[2] || '0', 10) * 60) +
                      parseFloat(match[3] || '0');
        }
      }
      const segCount = duration > 0 ? Math.ceil((totalSecs * timescale) / duration) : 30;
      for (let i = 0; i < segCount; i++) {
        chunkUrls.push(formatUrl(startNumber + i, i * duration));
      }
    }
    return { initUrl, chunkUrls };
  }

  const vTrack = generateTrackUrls(vSegTemplate, vSegList, vRep, videoSet, vBase);
  const aTrack = (aSegTemplate || aSegList) ? generateTrackUrls(aSegTemplate, aSegList, aRep, audioSet, aBase) : { initUrl: null, chunkUrls: [] };

  if (needsAudioExtraction) {
    // Si existe pista de audio independiente en DASH, descargar únicamente el audio
    const targetTrack = (aTrack.initUrl && aTrack.chunkUrls.length > 0) ? aTrack : vTrack;
    if (!targetTrack.initUrl || targetTrack.chunkUrls.length === 0) {
      throw new Error('No se encontraron fragmentos de audio en este flujo DASH.');
    }

    const aInitResp = await fetch(targetTrack.initUrl, { headers: safeHeaders, signal: abortController.signal });
    if (!aInitResp.ok) throw new Error(`HTTP ${aInitResp.status} al descargar encabezado inicial de audio.`);
    const aInitBuf = new Uint8Array(await aInitResp.arrayBuffer());

    const totalSegments = targetTrack.chunkUrls.length;
    const audioChunks = new Array(totalSegments);
    let downloadedCount = 0;
    let totalReceivedBytes = aInitBuf.byteLength;
    let lastProgressTime = 0;
    let currentIndex = 0;
    const CONCURRENCY_LIMIT = 4;

    async function audioWorker() {
      while (currentIndex < totalSegments) {
        if (abortController.signal.aborted) break;
        const idx = currentIndex++;
        const aUrl = targetTrack.chunkUrls[idx];
        try {
          const resp = await fetch(aUrl, { headers: safeHeaders, signal: abortController.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = new Uint8Array(await resp.arrayBuffer());
          audioChunks[idx] = buf;
          downloadedCount++;
          totalReceivedBytes += buf.byteLength;
        } catch (e) {
          if (abortController.signal.aborted) break;
          try {
            const resp = await fetch(aUrl, { headers: safeHeaders, signal: abortController.signal });
            if (resp.ok) {
              const buf = new Uint8Array(await resp.arrayBuffer());
              audioChunks[idx] = buf;
              downloadedCount++;
              totalReceivedBytes += buf.byteLength;
            }
          } catch (retryE) {}
        }

        const now = Date.now();
        if (now - lastProgressTime > 250 || downloadedCount === totalSegments) {
          lastProgressTime = now;
          const estTotal = downloadedCount > 0 ? Math.round((totalReceivedBytes / downloadedCount) * totalSegments) : 0;
          const maxPct = transcribeOnly ? 40 : 50;
          const scaledPct = Math.floor((downloadedCount / totalSegments) * maxPct);
          chrome.runtime.sendMessage({
            action: 'download_progress',
            downloadId,
            mediaId,
            transcribeOnly,
            phase: 'downloading',
            statusMessage: `Descargando fragmentos de audio DASH: ${downloadedCount}/${totalSegments}`,
            receivedBytes: totalReceivedBytes,
            totalBytes: estTotal,
            percent: scaledPct
          }).catch(() => {});
        }
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY_LIMIT, totalSegments); w++) {
      workers.push(audioWorker());
    }
    await Promise.all(workers);

    if (abortController.signal.aborted) return;

    chrome.runtime.sendMessage({
      action: 'download_progress',
      downloadId,
      mediaId,
      transcribeOnly,
      phase: 'decoding',
      statusMessage: 'Decodificando pista de audio AAC...',
      receivedBytes: totalReceivedBytes,
      totalBytes: totalReceivedBytes,
      percent: transcribeOnly ? 42 : 50
    }).catch(() => {});

    const validChunks = audioChunks.filter(b => b != null);
    const combinedAudio = concatUint8Arrays([aInitBuf, ...validChunks]);
    audioChunks.length = 0;

    let audioBuf;
    try {
      audioBuf = await decodeMediaBytesToAudioBuffer(
        combinedAudio.buffer.slice(combinedAudio.byteOffset, combinedAudio.byteOffset + combinedAudio.byteLength),
        'audio/mp4'
      );
    } catch (dashErr) {
      audioBuf = await decodeSegmentsListToAudioBuffer(
        validChunks.map(c => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength)),
        aInitBuf.buffer.slice(aInitBuf.byteOffset, aInitBuf.byteOffset + aInitBuf.byteLength)
      );
    }

    const audioKbps = parseInt(data.qualityOptions?.audioKbps, 10) || 128;
    const mp3Blob = await encodeAudioBufferToMp3(audioBuf, downloadId, mediaId, abortController, 50, 99, audioKbps);
    const blobUrl = URL.createObjectURL(mp3Blob);
    createdBlobUrls.add(blobUrl);

    let cleanName = baseFilename.replace(/\.(mpd|m3u8|mp4|ts|webm|mp3|htm|html)$/i, '') + '.mp3';
    activeControllers.delete(downloadId);

    chrome.runtime.sendMessage({
      action: 'download_blob_ready',
      downloadId,
      mediaId,
      blobUrl,
      filename: cleanName,
      sizeBytes: mp3Blob.size
    });
    return;
  }

  if (vTrack.chunkUrls.length === 0) {
    throw new Error('No se generaron URLs de fragmentos de video DASH.');
  }

  let vInitBuf = null;
  if (vTrack.initUrl) {
    const vInitResp = await fetch(vTrack.initUrl, { headers: safeHeaders, signal: abortController.signal });
    if (!vInitResp.ok) throw new Error(`HTTP ${vInitResp.status} al descargar encabezado inicial de video.`);
    vInitBuf = new Uint8Array(await vInitResp.arrayBuffer());
  }

  let aInitBuf = null;
  if (aTrack.initUrl) {
    try {
      const aInitResp = await fetch(aTrack.initUrl, { headers: safeHeaders, signal: abortController.signal });
      if (aInitResp.ok) {
        aInitBuf = new Uint8Array(await aInitResp.arrayBuffer());
      }
    } catch (e) {}
  }

  const hasAudio = !!(aInitBuf && aTrack.chunkUrls.length > 0);
  let combinedInit = null;
  if (vInitBuf && hasAudio) {
    combinedInit = createCombinedInit(vInitBuf, aInitBuf);
  } else if (vInitBuf) {
    combinedInit = vInitBuf;
  }

  const totalSegments = vTrack.chunkUrls.length;
  const interleavedPairs = new Array(totalSegments);
  let downloadedCount = 0;
  let totalReceivedBytes = combinedInit ? combinedInit.byteLength : 0;
  let lastProgressTime = 0;
  let currentIndex = 0;
  const CONCURRENCY_LIMIT = 4;

  async function worker() {
    while (currentIndex < totalSegments) {
      if (abortController.signal.aborted) break;
      const idx = currentIndex++;
      const vUrl = vTrack.chunkUrls[idx];
      const aUrl = hasAudio && idx < aTrack.chunkUrls.length ? aTrack.chunkUrls[idx] : null;

      try {
        const promises = [
          fetch(vUrl, { headers: safeHeaders, signal: abortController.signal })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
            .then(b => new Uint8Array(b))
        ];
        if (aUrl) {
          promises.push(
            fetch(aUrl, { headers: safeHeaders, signal: abortController.signal })
              .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
              .then(b => {
                const uint8 = new Uint8Array(b);
                changeTrackIdInBytes(uint8, 1, 2);
                return uint8;
              })
          );
        }

        const [vChunk, aChunk] = await Promise.all(promises);
        interleavedPairs[idx] = { video: vChunk, audio: aChunk || null };
        downloadedCount++;
        totalReceivedBytes += vChunk.byteLength + (aChunk ? aChunk.byteLength : 0);
      } catch (err) {
        if (abortController.signal.aborted) break;
        try {
          const vResp = await fetch(vUrl, { headers: safeHeaders, signal: abortController.signal });
          if (!vResp.ok) throw new Error(`HTTP ${vResp.status}`);
          const vChunk = new Uint8Array(await vResp.arrayBuffer());
          let aChunk = null;
          if (aUrl) {
            const aResp = await fetch(aUrl, { headers: safeHeaders, signal: abortController.signal });
            if (aResp.ok) {
              aChunk = new Uint8Array(await aResp.arrayBuffer());
              changeTrackIdInBytes(aChunk, 1, 2);
            }
          }
          interleavedPairs[idx] = { video: vChunk, audio: aChunk };
          downloadedCount++;
          totalReceivedBytes += vChunk.byteLength + (aChunk ? aChunk.byteLength : 0);
        } catch (retryErr) {
          console.error(`Error en fragmento DASH ${idx}:`, retryErr);
        }
      }

      const now = Date.now();
      if (now - lastProgressTime > 350 || downloadedCount === totalSegments) {
        lastProgressTime = now;
        const estTotal = downloadedCount > 0 ? Math.round((totalReceivedBytes / downloadedCount) * totalSegments) : 0;
        chrome.runtime.sendMessage({
          action: 'download_progress',
          downloadId,
          mediaId,
          receivedBytes: totalReceivedBytes,
          totalBytes: estTotal,
          percent: Math.floor((downloadedCount / totalSegments) * 100)
        }).catch(() => {});
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY_LIMIT, totalSegments); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (abortController.signal.aborted) return;

  const finalBlobs = [];
  if (combinedInit) finalBlobs.push(combinedInit);

  for (let i = 0; i < totalSegments; i++) {
    const pair = interleavedPairs[i];
    if (pair && pair.video) {
      finalBlobs.push(pair.video);
      if (pair.audio) finalBlobs.push(pair.audio);
    }
  }

  const finalBlob = new Blob(finalBlobs, { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(finalBlob);
  createdBlobUrls.add(blobUrl);

  let cleanName = baseFilename.replace(/\.(mpd|m3u8|ts|htm|html)$/i, '');
  if (!cleanName.endsWith('.mp4')) cleanName += '.mp4';

  activeControllers.delete(downloadId);

  chrome.runtime.sendMessage({
    action: 'download_blob_ready',
    downloadId,
    mediaId,
    blobUrl,
    filename: cleanName,
    sizeBytes: finalBlob.size
  });
}
