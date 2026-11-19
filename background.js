/**
 * OmniStream Video Downloader & AI Transcriber - Service Worker v2.3
 * Motor de captura por requestId, inyección DNR por URL exacta, descarga Offscreen Blob
 * y transcripción local Whisper en Español.
 */

const VIDEO_MIME_PATTERNS = [
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime',
  'video/ogg',
  'video/mp2t',
  'video/iso.segment',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/x-mpegurl',
  'application/dash+xml',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/wav'
];

const EXTENSION_REGEX = /\.(mp4|m3u8|webm|mov|mkv|mpd|m4a|mp3|aac|opus)(\?.*)?$/i;

// Mapa de itags de YouTube / GoogleVideo que corresponden a pistas exclusivas de Audio
const YOUTUBE_AUDIO_ITAGS = new Set(['139', '140', '141', '171', '172', '249', '250', '251', '256', '258', '325', '327', '338', '599', '600']);

function isAudioStreamByUrlOrMime(rawUrl, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  if (/[?&]mime=audio/i.test(rawUrl)) return true;
  if (/\.(m4a|aac|mp3|opus)(\?.*)?$/i.test(rawUrl)) return true;
  try {
    const u = new URL(rawUrl);
    const itag = u.searchParams.get('itag');
    if (itag && YOUTUBE_AUDIO_ITAGS.has(itag)) return true;
    // En rutas de manifest.googlevideo.com /hls_variant/.../itag/140/...
    const itagPathMatch = u.pathname.match(/\/itag\/(\d+)(\/|$)/);
    if (itagPathMatch && YOUTUBE_AUDIO_ITAGS.has(itagPathMatch[1])) return true;
  } catch (e) {}
  return false;
}

/**
 * Normaliza URLs de CDN sociales (Instagram, Facebook, TikTok, Google Drive)
 * que dividen un archivo MP4 maestro usando parámetros bytestart / byteend / range.
 * Al eliminar los parámetros de rango parcial, la URL apunta al archivo MP4 completo.
 */
function normalizeSocialAndRangeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const rangeParams = ['bytestart', 'byteend', 'range', 'rn', 'rbuf'];
    let modified = false;
    for (const p of rangeParams) {
      if (parsed.searchParams.has(p)) {
        parsed.searchParams.delete(p);
        modified = true;
      }
    }
    // En rutas tipo /range/123-456/ de algunos CDNs DASH/Social
    if (/\/range\/\d+-\d+\/?/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/range\/\d+-\d+\/?/i, '/');
      modified = true;
    }
    return modified ? parsed.toString() : rawUrl;
  } catch (e) {
    return rawUrl;
  }
}

// Cabeceras de transporte que NO deben forzarse en la regla DNR (lista negra Hm de VDH)
const HM_TRANSPORT_HEADERS = [
  /^range$/i,
  /^host$/i,
  /^connection$/i,
  /^content-length$/i,
  /^user-agent$/i,
  /^proxy-/i,
  /^keep-alive$/i,
  /^te$/i,
  /^trailer$/i,
  /^transfer-encoding$/i,
  /^upgrade$/i
];

// Mapas de cabeceras en memoria para indexar por requestId y URL
const requestHeadersById = new Map();
const requestHeadersByUrl = new Map();

// Estado de descargas/transcripciones activas y reglas DNR
const activeDownloadSessions = new Map();

// Mantener vivo el Service Worker mientras el Offscreen Document procesa audio o transcribe
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen_keepalive') {
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'ping') {
        try {
          port.postMessage({ type: 'pong', ts: Date.now() });
        } catch (e) {}
      }
    });
  }
});

// 1. Interceptar cabeceras reales de salida para todas las peticiones
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;

    const headersDict = {};
    for (const h of details.requestHeaders) {
      if (h.name && h.value) {
        headersDict[h.name] = h.value;
      }
    }

    const entry = {
      timestamp: details.timeStamp || Date.now(),
      headers: headersDict,
      url: details.url
    };

    if (details.requestId) {
      requestHeadersById.set(details.requestId, entry);
    }
    if (details.url) {
      requestHeadersByUrl.set(details.url, entry);
    }

    // Limpieza de memoria
    if (requestHeadersById.size > 600) {
      const oldestKey = requestHeadersById.keys().next().value;
      requestHeadersById.delete(oldestKey);
    }
    if (requestHeadersByUrl.size > 600) {
      const oldestUrl = requestHeadersByUrl.keys().next().value;
      requestHeadersByUrl.delete(oldestUrl);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

function extractFilename(url, contentDisposition, mediaType) {
  let filename = '';

  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i);
    if (filenameMatch && filenameMatch[1]) {
      filename = decodeURIComponent(filenameMatch[1].trim());
    }
  }

  if (!filename) {
    try {
      const parsed = new URL(url);
      const base = parsed.pathname.split('/').pop() || '';
      const cleanBase = base.split('?')[0];
      if (cleanBase && cleanBase.includes('.')) {
        filename = decodeURIComponent(cleanBase);
      }
    } catch (e) {}
  }

  if (!filename) {
    filename = 'video_' + Date.now();
  }

  filename = filename.replace(/\.(htm|html)$/i, '');

  if (!filename.includes('.')) {
    if (mediaType === 'm3u8') filename += '.m3u8';
    else if (mediaType === 'mpd') filename += '.mpd';
    else if (mediaType === 'webm') filename += '.webm';
    else filename += '.mp4';
  }

  return filename;
}

function getMediaType(url, mimeType) {
  const lowerUrl = url.toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

  if (lowerUrl.includes('.m3u8') || lowerMime.includes('mpegurl')) return 'm3u8';
  if (lowerUrl.includes('.mpd') || lowerMime.includes('dash+xml')) return 'mpd';
  if (lowerUrl.includes('.webm') || lowerMime.includes('video/webm')) return 'webm';
  return 'mp4';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Flujo dinámico';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Generar ID único resistente a colisiones para cualquier URL
function generateMediaId(url) {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ c;
  }
  return 'med_' + Math.abs(h1).toString(36) + Math.abs(h2).toString(36);
}

// 2. Interceptar respuestas multimedia y vincular cabeceras capturadas
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId <= 0 || details.url.startsWith('chrome-extension://')) {
      return;
    }

    const urlLower = details.url.toLowerCase();
    if (urlLower.match(/\.(ts|m4s)(\?.*)?$/i) && !urlLower.includes('.m3u8')) {
      return;
    }

    let contentType = '';
    let contentLength = 0;
    let contentDisposition = '';

    if (details.responseHeaders) {
      for (const header of details.responseHeaders) {
        const name = header.name.toLowerCase();
        if (name === 'content-type') {
          contentType = header.value ? header.value.toLowerCase() : '';
        } else if (name === 'content-length') {
          contentLength = parseInt(header.value, 10) || 0;
        } else if (name === 'content-disposition') {
          contentDisposition = header.value || '';
        }
      }
    }

    const matchesMime = VIDEO_MIME_PATTERNS.some((pattern) => contentType.includes(pattern));
    const matchesExt = EXTENSION_REGEX.test(details.url);
    const isGoogleVideoPlayback = urlLower.includes('googlevideo.com/videoplayback');

    if (matchesMime || matchesExt || isGoogleVideoPlayback) {
      const normalizedUrl = normalizeSocialAndRangeUrl(details.url);
      const hadRangeStripped = normalizedUrl !== details.url;

      // Si es un fragmento pequeño pero NO es una petición Byte-Range normalizada ni un manifiesto, ignorar micro-anuncios < 120 KB
      if (!hadRangeStripped && !isGoogleVideoPlayback && contentType.includes('video/mp4') && contentLength > 0 && contentLength < 120 * 1024) {
        return;
      }

      let pageUrl = details.initiator || '';
      let pageTitle = '';
      let activeTabObj = null;
      try {
        const tab = await chrome.tabs.get(details.tabId);
        if (tab) {
          activeTabObj = tab;
          pageUrl = tab.url || pageUrl;
          pageTitle = tab.title || '';
        }
      } catch (e) {}

      // Si la pestaña es YouTube o llega tráfico de googlevideo.com, inyectar únicamente la tarjeta maestra unificada (Azul MP4 + MP3)
      // y bloquear la creación de tarjetas secundarias verdes (HLS STREAM) de manifest.googlevideo.com
      if (urlLower.includes('googlevideo.com') || /youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\//i.test(pageUrl)) {
        if (activeTabObj) {
          await injectActiveTabVideoIfApplicable(activeTabObj);
        }
        return;
      }

      const mediaType = getMediaType(normalizedUrl, contentType);
      let filename = extractFilename(normalizedUrl, contentDisposition, mediaType);

      // Nombres genéricos que deben reemplazarse siempre por el título real del video/página
      const isGenericName = /^(video_\d+|index|master|playlist|manifest|stream|chunklist|media|video|audio|playback)(\.[a-z0-9]+)?$/i.test(filename);
      if (pageTitle && isGenericName) {
        const cleanPageTitle = pageTitle
          .replace(/^\(\d+\)\s*/, '') // Quitar "(1) " de notificaciones en YouTube
          .replace(/\s*[-|–]\s*(YouTube|Vimeo|Zoom|Twitch|TikTok|Instagram|Facebook).*$/i, '')
          .replace(/[/\\?%*:|"<>]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleanPageTitle) {
          const ext = mediaType === 'm3u8' ? 'm3u8' : (mediaType === 'mpd' ? 'mpd' : 'mp4');
          filename = `${cleanPageTitle}.${ext}`;
        }
      }

      let capturedEntry = requestHeadersById.get(details.requestId) || requestHeadersByUrl.get(details.url);
      const rawHeaders = capturedEntry ? { ...capturedEntry.headers } : {};

      if (!rawHeaders['Referer'] && pageUrl) {
        rawHeaders['Referer'] = pageUrl;
      }

      const effectiveSize = hadRangeStripped ? 0 : contentLength;

      const mediaItem = {
        id: generateMediaId(normalizedUrl),
        url: normalizedUrl,
        type: mediaType,
        mime: contentType,
        sizeBytes: effectiveSize,
        sizeFormatted: formatBytes(effectiveSize),
        filename: filename,
        pageUrl: pageUrl,
        headers: rawHeaders,
        detectedAt: Date.now()
      };

      const storageKey = `tab_${details.tabId}`;
      try {
        const result = await chrome.storage.session.get(storageKey);
        let items = result[storageKey] || [];

        const isPureAudioTrack = isAudioStreamByUrlOrMime(normalizedUrl, contentType);

        if (isPureAudioTrack) {
          await chrome.storage.session.set({
            [`tab_audio_${details.tabId}`]: {
              url: normalizedUrl,
              headers: rawHeaders,
              mime: contentType,
              type: mediaType,
              detectedAt: Date.now()
            }
          });

          if (items.length > 0) {
            let updatedAny = false;
            for (const it of items) {
              if (it.url !== normalizedUrl) {
                it.companionAudioUrl = normalizedUrl;
                if (!Array.isArray(it.companionManifests)) it.companionManifests = [];
                if (!it.companionManifests.includes(normalizedUrl)) {
                  it.companionManifests.push(normalizedUrl);
                }
                updatedAny = true;
              }
            }
            if (updatedAny) {
              await chrome.storage.session.set({ [storageKey]: items });
            }
            return;
          }
        } else {
          // Si es un video y ya existía una pista de audio capturada en esta pestaña, adjuntarla
          const savedAudio = await chrome.storage.session.get(`tab_audio_${details.tabId}`);
          const tabAudio = savedAudio[`tab_audio_${details.tabId}`];
          if (tabAudio && tabAudio.url && tabAudio.url !== normalizedUrl) {
            mediaItem.companionAudioUrl = tabAudio.url;
            mediaItem.companionManifests = [tabAudio.url];
          }
        }

        // Agrupar manifiestos HLS (.m3u8) del mismo servidor en una sola tarjeta que contiene todos los sub-manifiestos (Video + Audio)
        let isDuplicateVariant = false;
        if (mediaType === 'm3u8') {
          let host = '';
          try { host = new URL(normalizedUrl).hostname; } catch (e) {}
          const existingSameHostM3u8 = items.findIndex((item) => {
            if (item.type !== 'm3u8') return false;
            try {
              return new URL(item.url).hostname === host && item.filename === mediaItem.filename;
            } catch (e) {
              return false;
            }
          });
          if (existingSameHostM3u8 >= 0) {
            const masterCard = items[existingSameHostM3u8];
            if (!Array.isArray(masterCard.companionManifests)) {
              masterCard.companionManifests = [];
            }
            if (masterCard.url !== normalizedUrl && !masterCard.companionManifests.includes(normalizedUrl)) {
              masterCard.companionManifests.push(normalizedUrl);
            }
            if (!masterCard.companionAudioUrl && masterCard.url !== normalizedUrl) {
              masterCard.companionAudioUrl = normalizedUrl;
            }
            await chrome.storage.session.set({ [storageKey]: items });
            isDuplicateVariant = true;
          }
        }

        const existsIndex = items.findIndex((item) => item.url === mediaItem.url);
        if (existsIndex >= 0) {
          items[existsIndex] = mediaItem;
        } else if (!isDuplicateVariant) {
          items.push(mediaItem);
        }

        await chrome.storage.session.set({ [storageKey]: items });
        chrome.action.setBadgeText({ text: String(items.length), tabId: details.tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#2563EB', tabId: details.tabId });
      } catch (err) {
        console.error('Error guardando en storage:', err);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const storageKey = `tab_${tabId}`;
  try {
    const data = await chrome.storage.session.get(storageKey);
    const items = data[storageKey] || [];
    const keysToRemove = [storageKey];
    for (const item of items) {
      if (item.id) keysToRemove.push(`active_dl_${item.id}`);
    }
    await chrome.storage.session.remove(keysToRemove);
  } catch (e) {
    chrome.storage.session.remove(storageKey);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const storageKey = `tab_${tabId}`;
    try {
      const data = await chrome.storage.session.get(storageKey);
      const items = data[storageKey] || [];
      const keysToRemove = [storageKey];
      for (const item of items) {
        if (item.id) keysToRemove.push(`active_dl_${item.id}`);
      }
      await chrome.storage.session.remove(keysToRemove);
    } catch (e) {
      chrome.storage.session.remove(storageKey);
    }
    chrome.action.setBadgeText({ text: '', tabId: tabId });
  }
});

// 3. Gestión de Offscreen Document (REUTILIZACIÓN SEGURA: nunca cerrar un offscreen con tareas activas)
let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (contexts && contexts.length > 0) {
        return; // Ya existe y está activo, reutilizarlo sin matarlo
      }
    }
  } catch (e) {}

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'WORKERS'],
    justification: 'Descarga en streaming, extracción de audio MP3 y transcripción local IA Whisper'
  }).catch((e) => {
    if (!e.message || !e.message.includes('Only a single offscreen document')) {
      console.error('Error creando offscreen document:', e);
      throw e;
    }
  }).finally(() => {
    creatingOffscreenPromise = null;
  });

  await creatingOffscreenPromise;
}

// 4. Mensajería de control entre Popup, Service Worker, Native Host (yt-dlp+FFmpeg) y Offscreen Document
const NATIVE_HOST_NAME = 'com.omnistream.downloader';
let nativePort = null;

function getNativeHostPort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'progress') {
        updateDownloadProgress({
          downloadId: msg.downloadId,
          mediaId: msg.mediaId,
          phase: 'native_downloading',
          statusMessage: msg.statusMessage || 'Procesando con yt-dlp + FFmpeg...',
          percent: msg.percent || 0,
          receivedBytes: 0,
          totalBytes: 0
        });
      } else if (msg.type === 'completed') {
        handleNativeDownloadCompleted(msg);
      } else if (msg.type === 'cancelled') {
        handleNativeDownloadCancelled(msg);
      } else if (msg.type === 'formats_result') {
        handleFormatsResult(msg);
      } else if (msg.type === 'error') {
        handleDownloadFailed({
          downloadId: msg.downloadId,
          mediaId: msg.mediaId,
          error: msg.error || 'Error en motor nativo yt-dlp'
        });
      }
    });
    nativePort.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        console.warn('Native Host desconectado:', lastErr.message);
      }
      nativePort = null;
    });
    return nativePort;
  } catch (e) {
    console.warn('No se pudo conectar con Native Host:', e);
    nativePort = null;
    return null;
  }
}

async function handleFormatsResult(msg) {
  const { mediaId, tabId, heights, thumbnail, title } = msg;
  if (!tabId || !mediaId) return;
  const storageKey = `tab_${tabId}`;
  try {
    const data = await chrome.storage.session.get(storageKey);
    const items = data[storageKey] || [];
    const idx = items.findIndex((it) => it.id === mediaId);
    if (idx < 0) return;

    const updated = { ...items[idx] };
    if (Array.isArray(heights) && heights.length > 0) {
      updated.availableHeights = heights;
    }
    if (thumbnail && !updated.thumbnailUrl) {
      updated.thumbnailUrl = thumbnail;
    }
    if (title && (!updated.filename || updated.filename === 'Video.mp4')) {
      updated.filename = `${title}.mp4`;
    }
    items[idx] = updated;
    await chrome.storage.session.set({ [storageKey]: items });
  } catch (e) {}
}

function extractThumbnailFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (/youtube\.com$/i.test(u.hostname) || /www\.youtube\.com$/i.test(u.hostname) || /m\.youtube\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get('v');
      if (v) return `https://i.ytimg.com/vi/${v}/mqdefault.jpg`;
      const pathMatch = u.pathname.match(/\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{6,})/);
      if (pathMatch) return `https://i.ytimg.com/vi/${pathMatch[1]}/mqdefault.jpg`;
    } else if (/youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (id) return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    }
  } catch (e) {}
  return '';
}

async function handleNativeDownloadCancelled(msg) {
  const { downloadId, mediaId: msgMediaId } = msg;
  const session = await resolveSession(downloadId, msgMediaId);
  const mediaId = (session && session.mediaItem && session.mediaItem.id) || msgMediaId;
  if (mediaId) {
    await chrome.storage.session.set({
      [`active_dl_${mediaId}`]: { downloadId, status: 'cancelled' }
    });
    setTimeout(() => {
      chrome.storage.session.remove(`active_dl_${mediaId}`).catch(() => {});
    }, 1500);
  }
  activeDownloadSessions.delete(downloadId);
}

async function handleNativeDownloadCompleted(msg) {
  const { downloadId, mediaId: msgMediaId, audioOnly, filename, filepath, sizeBytes, statusMessage } = msg;
  const session = await resolveSession(downloadId, msgMediaId);
  const mediaId = (session && session.mediaItem && session.mediaItem.id) || msgMediaId;

  if (filepath) {
    try {
      const port = getNativeHostPort();
      if (port) {
        port.postMessage({ action: 'open_file_in_folder', filepath });
      }
    } catch (e) {}
  }

  if (mediaId) {
    await chrome.storage.session.set({
      [`active_dl_${mediaId}`]: {
        downloadId,
        audioOnly: !!audioOnly,
        status: 'completed',
        percent: 100,
        filepath: filepath || '',
        filename: filename || '',
        statusMessage: statusMessage || (audioOnly ? '¡Audio .MP3 guardado en Descargas!' : '¡Video .MP4 (con audio) guardado en Descargas!'),
        receivedBytes: sizeBytes || 0,
        totalBytes: sizeBytes || 0
      }
    });

    try {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#1e8e3e' });
    } catch (e) {}

    setTimeout(() => {
      chrome.storage.session.remove(`active_dl_${mediaId}`).catch(() => {});
    }, 6000);
  }
  activeDownloadSessions.delete(downloadId);
}

const YTDLP_SUPPORTED_HOSTS = /(youtube\.com|youtu\.be|googlevideo\.com|vimeo\.com|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|twitch\.tv|dailymotion\.com|reddit\.com|v\.redd\.it|streamable\.com|bilibili\.com|rumble\.com|kick\.com|linkedin\.com|pinterest\.com|soundcloud\.com|loom\.com|wistia\.com)/i;

function shouldUseNativeYtdlpEngine(mediaItem) {
  const url = (mediaItem.url || '').toLowerCase();
  const pageUrl = (mediaItem.pageUrl || '').toLowerCase();
  if (mediaItem.useNativeEngine) return true;
  if (YTDLP_SUPPORTED_HOSTS.test(url) || YTDLP_SUPPORTED_HOSTS.test(pageUrl)) return true;
  return false;
}

async function injectActiveTabVideoIfApplicable(tab) {
  if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome')) return;
  const u = tab.url;
  const isDirectVideoPage =
    /youtube\.com\/(watch\?v=|shorts\/|live\/)/i.test(u) ||
    /youtu\.be\/[a-zA-Z0-9_-]+/i.test(u) ||
    /vimeo\.com\/\d+/i.test(u) ||
    /tiktok\.com\/@[^/]+\/video\/\d+/i.test(u) ||
    /instagram\.com\/(reel|p|tv)\//i.test(u) ||
    /facebook\.com\/.*\/videos\//i.test(u) ||
    /fb\.watch\//i.test(u) ||
    /(twitter\.com|x\.com)\/[^/]+\/status\/\d+/i.test(u) ||
    /twitch\.tv\/videos\/\d+/i.test(u) ||
    /dailymotion\.com\/video\//i.test(u);

  if (!isDirectVideoPage) return;

  const storageKey = `tab_${tab.id}`;
  const result = await chrome.storage.session.get(storageKey);
  let items = result[storageKey] || [];

  const cleanTitle = (tab.title || 'Video')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*[-|–]\s*(YouTube|Vimeo|TikTok|Instagram|Facebook|X|Twitch|Dailymotion).*$/i, '')
    .replace(/[/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Video';

  const cardId = generateMediaId(u);
  const thumbUrl = extractThumbnailFromUrl(u);
  const directCard = {
    id: cardId,
    url: u,
    type: 'mp4',
    mime: 'video/mp4',
    sizeBytes: 0,
    sizeFormatted: 'Video + Audio (FFmpeg)',
    filename: `${cleanTitle}.mp4`,
    pageUrl: u,
    thumbnailUrl: thumbUrl,
    headers: { Referer: u },
    useNativeEngine: true,
    detectedAt: Date.now()
  };

  // En YouTube, reemplazar cualquier index.m3u8 o videoplayback suelto por la tarjeta maestra unificada
  if (/youtube\.com|youtu\.be/i.test(u)) {
    items = items.filter(it => !/googlevideo\.com|youtube\.com|youtu\.be/i.test(it.url) || it.id === cardId);
  }

  const existingIdx = items.findIndex(it => it.id === cardId || it.url === u);
  if (existingIdx >= 0) {
    items[existingIdx] = {
      ...items[existingIdx],
      filename: directCard.filename,
      thumbnailUrl: items[existingIdx].thumbnailUrl || thumbUrl,
      useNativeEngine: true
    };
  } else {
    items.unshift(directCard);
  }

  await chrome.storage.session.set({ [storageKey]: items });
  chrome.action.setBadgeText({ text: String(items.length), tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: '#1a73e8', tabId: tab.id });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sync_active_tab_video') {
    if (message.tab) {
      injectActiveTabVideoIfApplicable(message.tab).then(() => {
        sendResponse({ status: 'synced' });
      }).catch(() => {
        sendResponse({ status: 'ok' });
      });
      return true;
    }
    sendResponse({ status: 'noop' });
    return false;
  }

  if (message.action === 'open_downloaded_file') {
    const port = getNativeHostPort();
    if (port && message.filepath) {
      try {
        port.postMessage({ action: 'open_file_in_folder', filepath: message.filepath });
      } catch (e) {}
    }
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.action === 'probe_video_formats') {
    const item = message.mediaItem;
    const tabId = message.tabId;
    if (item && tabId && shouldUseNativeYtdlpEngine(item)) {
      const port = getNativeHostPort();
      if (port) {
        const targetUrl = (/googlevideo\.com/i.test(item.url) && item.pageUrl) ? item.pageUrl : item.url;
        chrome.cookies.getAll({ url: targetUrl }).then((cookiesList) => {
          port.postMessage({
            action: 'probe_formats',
            mediaId: item.id,
            tabId,
            url: targetUrl,
            cookies: cookiesList || []
          });
        }).catch(() => {
          port.postMessage({
            action: 'probe_formats',
            mediaId: item.id,
            tabId,
            url: targetUrl,
            cookies: []
          });
        });
      }
    }
    sendResponse({ status: 'probing' });
    return true;
  }

  if (message.action === 'start_stream_download') {
    handleStartDownload(
      message.mediaItem,
      !!message.audioOnly,
      message.qualityOptions || {},
      !!message.transcribeOnly,
      message.courseContext || ''
    );
    sendResponse({ status: 'initiated' });
    return true;
  }

  if (message.action === 'download_blob_ready') {
    handleBlobReady(message);
    sendResponse({ status: 'queued' });
    return true;
  }

  if (message.action === 'download_progress') {
    updateDownloadProgress(message);
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.action === 'download_failed') {
    handleDownloadFailed(message);
    sendResponse({ status: 'logged' });
    return false;
  }
});

function getDnrUrlFilter(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes('instructuremedia.com')) {
      return '*://*.instructuremedia.com/*';
    }
    const lastSlash = u.pathname.lastIndexOf('/');
    const basePath = lastSlash >= 0 ? u.pathname.substring(0, lastSlash + 1) : u.pathname;
    return `${u.origin}${basePath}*`;
  } catch (e) {
    return rawUrl.split('?')[0];
  }
}

function getDownloadDateStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function resolveSession(downloadId, mediaIdHint) {
  if (activeDownloadSessions.has(downloadId)) {
    return activeDownloadSessions.get(downloadId);
  }
  // Recuperación resiliente si el Service Worker se reinició durante una tarea larga
  const allSession = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(allSession)) {
    if (k.startsWith('active_dl_') && v && v.downloadId === downloadId) {
      const recovered = {
        mediaItem: v.mediaItem || { id: k.replace('active_dl_', ''), filename: v.filename || 'audio' },
        audioOnly: !!v.audioOnly,
        transcribeOnly: !!v.transcribeOnly,
        ruleId: v.ruleId || null
      };
      activeDownloadSessions.set(downloadId, recovered);
      return recovered;
    }
  }
  if (mediaIdHint) {
    return {
      mediaItem: { id: mediaIdHint, filename: 'media' },
      audioOnly: false,
      transcribeOnly: false,
      ruleId: null
    };
  }
  return null;
}

async function handleStartDownload(mediaItem, audioOnly = false, qualityOptions = {}, transcribeOnly = false, courseContext = '') {
  const downloadId = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const ruleId = Math.floor(Math.random() * 800000) + 1000;

  const dateStamp = getDownloadDateStamp();
  let baseName = (mediaItem.filename || 'video').replace(/\.(mp4|m3u8|mpd|webm|ts|mov|mkv|mp3|htm|html)$/i, '');
  if (!baseName.endsWith(`_${dateStamp}`)) {
    baseName = `${baseName}_${dateStamp}`;
  }
  const targetFilename = transcribeOnly ? `${baseName}.md` : (audioOnly ? `${baseName}.mp3` : `${baseName}.mp4`);

  // Vía 1: Si es YouTube/plataforma soportada o transcripción con Gemini, ejecutar por Native Messaging
  if (transcribeOnly || shouldUseNativeYtdlpEngine(mediaItem)) {
    const port = getNativeHostPort();
    if (port) {
      try {
        activeDownloadSessions.set(downloadId, {
          mediaItem,
          audioOnly: audioOnly || transcribeOnly,
          transcribeOnly,
          ruleId: null,
          startTime: Date.now()
        });

        await chrome.storage.session.set({
          [`active_dl_${mediaItem.id}`]: {
            downloadId,
            mediaItem,
            audioOnly: audioOnly || transcribeOnly,
            transcribeOnly,
            status: 'downloading',
            statusMessage: transcribeOnly ? 'Iniciando extracción y transcripción con Gemini...' : 'Iniciando motor local yt-dlp + FFmpeg 9.0...',
            percent: 2,
            receivedBytes: 0,
            totalBytes: 0
          }
        });

        // Recolectar cookies reales de sesión (YouTube, Vimeo, Instagram, etc.) para acceso autenticado
        const targetPageUrl = (mediaItem.pageUrl && /^https?:\/\//i.test(mediaItem.pageUrl)) ? mediaItem.pageUrl : mediaItem.url;
        let cookiesList = [];
        try {
          const primaryCookies = await chrome.cookies.getAll({ url: targetPageUrl });
          cookiesList = primaryCookies || [];
          if (/youtube\.com|youtu\.be|googlevideo\.com/i.test(targetPageUrl)) {
            const ytCookies = await chrome.cookies.getAll({ domain: '.youtube.com' });
            if (ytCookies && ytCookies.length > 0) {
              cookiesList = ytCookies;
            }
          }
        } catch (cookieErr) {}

        // En YouTube usar siempre la URL de la página watch?v=... en vez del index.m3u8 mudo
        const effectiveUrl = (/googlevideo\.com/i.test(mediaItem.url) && mediaItem.pageUrl) ? mediaItem.pageUrl : mediaItem.url;

        port.postMessage({
          action: 'start_native_download',
          downloadId,
          mediaId: mediaItem.id,
          url: effectiveUrl,
          pageUrl: mediaItem.pageUrl || effectiveUrl,
          title: baseName,
          filename: targetFilename,
          audioOnly,
          transcribeOnly,
          courseContext,
          qualityOptions,
          headers: mediaItem.headers || {},
          cookies: cookiesList
        });
        return;
      } catch (nativeErr) {
        console.warn('Fallo envío a Native Host, usando motor Offscreen como respaldo:', nativeErr);
      }
    }
  }

  try {
    if (!chrome.declarativeNetRequest) {
      throw new Error('Falta permiso declarativeNetRequest. Quita y vuelve a cargar la extensión.');
    }
    if (!chrome.offscreen) {
      throw new Error('Falta permiso offscreen. Quita y vuelve a cargar la extensión.');
    }

    const dnrHeaders = [];
    if (mediaItem.headers) {
      for (const [name, val] of Object.entries(mediaItem.headers)) {
        const isTransport = HM_TRANSPORT_HEADERS.some(rx => rx.test(name));
        if (!isTransport && val) {
          dnrHeaders.push({
            header: name,
            operation: 'set',
            value: val
          });
        }
      }
    }

    if (!dnrHeaders.some(h => h.header.toLowerCase() === 'referer') && mediaItem.pageUrl) {
      dnrHeaders.push({
        header: 'Referer',
        operation: 'set',
        value: mediaItem.pageUrl
      });
    }

    if (mediaItem.pageUrl) {
      try {
        const pageOrigin = new URL(mediaItem.pageUrl).origin;
        if (!dnrHeaders.some(h => h.header.toLowerCase() === 'origin') && pageOrigin) {
          dnrHeaders.push({
            header: 'Origin',
            operation: 'set',
            value: pageOrigin
          });
        }
      } catch (e) {}
    }

    const filterPattern = getDnrUrlFilter(mediaItem.url);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: dnrHeaders
          },
          condition: {
            urlFilter: filterPattern,
            resourceTypes: ['xmlhttprequest']
          }
        }
      ]
    });

    activeDownloadSessions.set(downloadId, {
      mediaItem,
      audioOnly,
      ruleId,
      startTime: Date.now()
    });

    await chrome.storage.session.set({
      [`active_dl_${mediaItem.id}`]: {
        downloadId,
        mediaItem,
        ruleId,
        audioOnly,
        status: 'downloading',
        percent: 0,
        receivedBytes: 0,
        totalBytes: mediaItem.sizeBytes || 0
      }
    });

    await ensureOffscreenDocument();

    async function sendWithRetry(payload, maxRetries = 8) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const resp = await chrome.runtime.sendMessage(payload);
          if (resp && resp.status === 'started') return true;
        } catch (err) {}
        await new Promise(resolve => setTimeout(resolve, 90));
      }
      return false;
    }

    const sentOk = await sendWithRetry({
      action: 'execute_stream_download',
      data: {
        downloadId,
        mediaId: mediaItem.id,
        url: mediaItem.url,
        companionAudioUrl: mediaItem.companionAudioUrl || null,
        companionManifests: Array.isArray(mediaItem.companionManifests) ? mediaItem.companionManifests : [],
        type: mediaItem.type,
        filename: targetFilename,
        rawHeaders: mediaItem.headers,
        sizeBytes: mediaItem.sizeBytes,
        audioOnly: audioOnly,
        qualityOptions: qualityOptions
      }
    });

    if (!sentOk) {
      throw new Error('El documento offscreen no respondió al comando de inicio.');
    }

  } catch (err) {
    console.error('Error en handleStartDownload:', err);
    activeDownloadSessions.delete(downloadId);
    chrome.declarativeNetRequest?.updateSessionRules?.({
      removeRuleIds: [ruleId]
    }).catch?.(() => {});

    await chrome.storage.session.set({
      [`active_dl_${mediaItem.id}`]: {
        downloadId,
        status: 'error',
        error: err.message || 'Error inicializando tarea'
      }
    });
  }
}

async function handleBlobReady(message) {
  const { downloadId, mediaId: msgMediaId, blobUrl, filename, sizeBytes } = message;
  const session = await resolveSession(downloadId, msgMediaId);

  if (session && session.ruleId) {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [session.ruleId]
    }).catch(() => {});
  }

  try {
    const chromeDownloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: filename,
      saveAs: true
    });

    if (session && session.mediaItem) {
      const mediaId = session.mediaItem.id;
      await chrome.storage.session.set({
        [`active_dl_${mediaId}`]: {
          downloadId,
          audioOnly: !!session.audioOnly,
          status: 'completed',
          percent: 100,
          receivedBytes: sizeBytes,
          totalBytes: sizeBytes
        }
      });

      try {
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#1e8e3e' });
      } catch (e) {}

      setTimeout(() => {
        chrome.storage.session.remove(`active_dl_${mediaId}`).catch(() => {});
      }, 4500);
    }

    const checkCompletion = (delta) => {
      if (delta.id === chromeDownloadId && delta.state) {
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          if (delta.state.current === 'complete') {
            try { chrome.downloads.show(chromeDownloadId); } catch (e) {}
          }
          chrome.downloads.onChanged.removeListener(checkCompletion);
          chrome.runtime.sendMessage({
            action: 'revoke_blob_url',
            blobUrl: blobUrl
          }).catch(() => {});
          activeDownloadSessions.delete(downloadId);
        }
      }
    };
    chrome.downloads.onChanged.addListener(checkCompletion);

    setTimeout(() => {
      chrome.runtime.sendMessage({
        action: 'revoke_blob_url',
        blobUrl: blobUrl
      }).catch(() => {});
      activeDownloadSessions.delete(downloadId);
    }, 300000);

  } catch (dlErr) {
    console.error('Error en chrome.downloads.download de Blob:', dlErr);
    if (session && session.mediaItem) {
      await chrome.storage.session.set({
        [`active_dl_${session.mediaItem.id}`]: {
          downloadId,
          status: 'error',
          error: dlErr.message
        }
      });
    }
  }
}

async function updateDownloadProgress(progressData) {
  const session = await resolveSession(progressData.downloadId, progressData.mediaId);
  const mediaId = (session && session.mediaItem && session.mediaItem.id) || progressData.mediaId;
  if (!mediaId) return;

  const pct = Math.max(0, Math.min(99, Math.round(progressData.percent || 0)));
  try {
    chrome.action.setBadgeText({ text: `${pct}%` });
    chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  } catch (e) {}

  await chrome.storage.session.set({
    [`active_dl_${mediaId}`]: {
      downloadId: progressData.downloadId,
      mediaItem: session ? session.mediaItem : undefined,
      ruleId: session ? session.ruleId : undefined,
      audioOnly: !!(session && session.audioOnly),
      phase: progressData.phase || 'downloading',
      statusMessage: progressData.statusMessage || '',
      status: 'downloading',
      percent: progressData.percent,
      receivedBytes: progressData.receivedBytes,
      totalBytes: progressData.totalBytes
    }
  });
}

async function handleDownloadFailed(failData) {
  const session = await resolveSession(failData.downloadId, failData.mediaId);
  if (session && session.ruleId) {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [session.ruleId]
    }).catch(() => {});
  }
  const mediaId = (session && session.mediaItem && session.mediaItem.id) || failData.mediaId;
  if (mediaId) {
    await chrome.storage.session.set({
      [`active_dl_${mediaId}`]: {
        downloadId: failData.downloadId,
        status: 'error',
        error: failData.error
      }
    });

    setTimeout(() => {
      chrome.storage.session.remove(`active_dl_${mediaId}`).catch(() => {});
    }, 8000);
  }
  activeDownloadSessions.delete(failData.downloadId);
}
