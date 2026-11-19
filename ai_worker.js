/**
 * OmniStream Dedicated Audio MP3 Web Worker (ai_worker.js)
 * Ejecuta la codificación MP3 (lamejs) en un hilo separado dentro del Offscreen Document
 * para que la interfaz y el Popup permanezcan 100% fluidos en todo momento.
 */

let abortedDownloadIds = new Set();

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || !msg.action) return;

  if (msg.action === 'abort_task') {
    if (msg.downloadId) {
      abortedDownloadIds.add(msg.downloadId);
    }
    return;
  }

  if (msg.action === 'encode_mp3') {
    await handleWorkerMp3Encoding(msg);
  }
};

async function handleWorkerMp3Encoding(msg) {
  const {
    downloadId,
    mediaId,
    leftFloat,
    rightFloat,
    rawChannels,
    sampleRate,
    kbps: requestedKbps,
    startPercent = 50,
    endPercent = 99,
    lameUrl
  } = msg;

  try {
    if (typeof lamejs === 'undefined') {
      importScripts(lameUrl);
    }

    const length = leftFloat.length;
    const kbps = parseInt(requestedKbps, 10) || 128;

    // Detección inteligente Dual-Mono (grabaciones de Zoom / clases online)
    let isMono = (rawChannels === 1 || !rightFloat);
    if (rawChannels > 1 && rightFloat) {
      let diffSum = 0;
      const testSamples = Math.min(length, 1000);
      const step = Math.max(1, Math.floor(length / testSamples));
      for (let k = 0; k < length && k < step * testSamples; k += step) {
        diffSum += Math.abs(leftFloat[k] - rightFloat[k]);
      }
      if ((diffSum / testSamples) < 0.001) {
        isMono = true;
      }
    }

    const channels = isMono ? 1 : 2;
    const mp3encoder = new self.lamejs.Mp3Encoder(channels, sampleRate, kbps);

    const sampleBlockSize = 1152 * 16;
    const leftBlock = new Int16Array(sampleBlockSize);
    const rightBlock = (!isMono && rightFloat) ? new Int16Array(sampleBlockSize) : null;

    const mp3Chunks = [];
    let lastProgressTime = 0;

    for (let i = 0; i < length; i += sampleBlockSize) {
      if (abortedDownloadIds.has(downloadId)) {
        abortedDownloadIds.delete(downloadId);
        throw new Error('Codificación cancelada por el usuario.');
      }

      const chunkLen = Math.min(sampleBlockSize, length - i);
      for (let j = 0; j < chunkLen; j++) {
        let sL = leftFloat[i + j];
        if (sL > 1) sL = 1;
        else if (sL < -1) sL = -1;
        leftBlock[j] = sL < 0 ? sL * 0x8000 : sL * 0x7FFF;
      }

      const leftSub = chunkLen === sampleBlockSize ? leftBlock : leftBlock.subarray(0, chunkLen);
      let mp3buf;

      if (!isMono && rightFloat && rightBlock) {
        for (let j = 0; j < chunkLen; j++) {
          let sR = rightFloat[i + j];
          if (sR > 1) sR = 1;
          else if (sR < -1) sR = -1;
          rightBlock[j] = sR < 0 ? sR * 0x8000 : sR * 0x7FFF;
        }
        const rightSub = chunkLen === sampleBlockSize ? rightBlock : rightBlock.subarray(0, chunkLen);
        mp3buf = mp3encoder.encodeBuffer(leftSub, rightSub);
      } else {
        mp3buf = mp3encoder.encodeBuffer(leftSub);
      }

      if (mp3buf && mp3buf.length > 0) {
        mp3Chunks.push(new Uint8Array(mp3buf));
      }

      const now = Date.now();
      if (now - lastProgressTime > 220 || i + sampleBlockSize >= length) {
        lastProgressTime = now;
        const progressFraction = Math.min(1, (i + sampleBlockSize) / length);
        const scaledPct = Math.round(startPercent + progressFraction * (endPercent - startPercent));
        const internalPct = Math.round(progressFraction * 100);

        self.postMessage({
          type: 'progress',
          downloadId,
          mediaId,
          phase: 'encoding',
          statusMessage: `Codificando a MP3: ${internalPct}%`,
          receivedBytes: Math.round(progressFraction * (length * 2 * channels * 0.1)),
          totalBytes: Math.round(length * 2 * channels * 0.1),
          percent: scaledPct
        });
      }
    }

    const flushBuf = mp3encoder.flush();
    if (flushBuf && flushBuf.length > 0) {
      mp3Chunks.push(new Uint8Array(flushBuf));
    }

    const mp3Blob = new Blob(mp3Chunks, { type: 'audio/mp3' });
    const mp3ArrayBuffer = await mp3Blob.arrayBuffer();

    self.postMessage(
      {
        type: 'mp3_complete',
        downloadId,
        mediaId,
        mp3Buffer: mp3ArrayBuffer
      },
      [mp3ArrayBuffer]
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      downloadId,
      mediaId,
      error: err.message || 'Error en worker MP3'
    });
  }
}
