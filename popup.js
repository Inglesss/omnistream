/**
 * OmniStream Video & MP3 Downloader - Popup Script v2.7
 * UI Google Dark Material 3 con selectores de calidad de Video (.MP4) y Audio (.MP3).
 */

document.addEventListener('DOMContentLoaded', async () => {
  const mediaListContainer = document.getElementById('media-list');
  const emptyState = document.getElementById('empty-state');
  const detectedCount = document.getElementById('detected-count');
  const btnClear = document.getElementById('btn-clear');
  const btnRefreshTab = document.getElementById('btn-refresh-tab');
  const btnOpenSidepanel = document.getElementById('btn-open-sidepanel');
  const selectVideoQuality = document.getElementById('select-video-quality');
  const selectAudioQuality = document.getElementById('select-audio-quality');
  const inputCourseContext = document.getElementById('input-course-context');
  const toast = document.getElementById('toast');

  let activeTabId = null;

  // Restaurar preferencias de calidad y contexto guardadas
  try {
    const prefs = await chrome.storage.local.get(['pref_video_quality', 'pref_audio_kbps', 'pref_course_context']);
    if (prefs.pref_video_quality && selectVideoQuality) {
      selectVideoQuality.value = String(prefs.pref_video_quality);
    }
    if (prefs.pref_audio_kbps && selectAudioQuality) {
      selectAudioQuality.value = String(prefs.pref_audio_kbps);
    }
    if (prefs.pref_course_context && inputCourseContext) {
      inputCourseContext.value = String(prefs.pref_course_context);
    }
  } catch (e) {}

  if (inputCourseContext) {
    inputCourseContext.addEventListener('input', () => {
      chrome.storage.local.set({ pref_course_context: inputCourseContext.value }).catch(() => {});
    });
  }

  if (selectVideoQuality) {
    selectVideoQuality.addEventListener('change', () => {
      chrome.storage.local.set({ pref_video_quality: selectVideoQuality.value }).catch(() => {});
    });
  }

  if (selectAudioQuality) {
    selectAudioQuality.addEventListener('change', () => {
      chrome.storage.local.set({ pref_audio_kbps: selectAudioQuality.value }).catch(() => {});
    });
  }

  if (btnOpenSidepanel) {
    btnOpenSidepanel.addEventListener('click', async () => {
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          const win = await chrome.windows.getCurrent();
          await chrome.sidePanel.open({ windowId: win.id });
          window.close();
        } else {
          showToast('Panel lateral no disponible en esta versión de Chrome');
        }
      } catch (err) {
        showToast('Usa el menú lateral de Chrome para abrir OmniStream');
      }
    });
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      activeTabId = tabs[0].id;
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'sync_active_tab_video', tab: tabs[0] }, () => resolve());
      });
    }
  } catch (err) {
    console.error('Error obteniendo pestaña activa:', err);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return 'Flujo dinámico';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function getQualityOptions() {
    return {
      videoQuality: selectVideoQuality ? parseInt(selectVideoQuality.value, 10) || 9999 : 9999,
      audioKbps: selectAudioQuality ? parseInt(selectAudioQuality.value, 10) || 128 : 128
    };
  }

  const probedMediaIds = new Set();

  function formatResolutionLabel(h) {
    if (h >= 2160) return `${h}p (4K)`;
    if (h >= 1440) return `${h}p (2K)`;
    if (h >= 1080) return `${h}p (Full HD)`;
    if (h >= 720) return `${h}p (HD)`;
    if (h >= 480) return `${h}p (SD)`;
    return `${h}p`;
  }

  function syncVideoQualityOptions(items) {
    if (!selectVideoQuality || !items || items.length === 0) return;
    const withHeights = items.find((it) => Array.isArray(it.availableHeights) && it.availableHeights.length > 0);
    if (!withHeights) return;

    const currentVal = selectVideoQuality.value;
    const heights = [...new Set(withHeights.availableHeights)].sort((a, b) => b - a);

    selectVideoQuality.innerHTML = '';
    const maxOpt = document.createElement('option');
    maxOpt.value = '9999';
    maxOpt.textContent = `Máxima disponible (${heights[0]}p)`;
    selectVideoQuality.appendChild(maxOpt);

    heights.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = formatResolutionLabel(h);
      selectVideoQuality.appendChild(opt);
    });

    if ([...selectVideoQuality.options].some((o) => o.value === currentVal)) {
      selectVideoQuality.value = currentVal;
    } else {
      selectVideoQuality.value = '9999';
    }
  }

  async function renderMediaList() {
    if (!activeTabId) return;

    const storageKey = `tab_${activeTabId}`;
    const data = await chrome.storage.session.get(null);
    const items = data[storageKey] || [];

    mediaListContainer.innerHTML = '';
    detectedCount.textContent = `${items.length} ${items.length === 1 ? 'video detectado' : 'videos detectados'}`;

    if (items.length === 0) {
      mediaListContainer.style.display = 'none';
      emptyState.style.display = 'flex';
      return;
    }

    mediaListContainer.style.display = 'flex';
    emptyState.style.display = 'none';

    syncVideoQualityOptions(items);

    const nativeCandidate = items.find((it) => it.useNativeEngine && !Array.isArray(it.availableHeights));
    if (nativeCandidate && !probedMediaIds.has(nativeCandidate.id)) {
      probedMediaIds.add(nativeCandidate.id);
      chrome.runtime.sendMessage({
        action: 'probe_video_formats',
        mediaItem: nativeCandidate,
        tabId: activeTabId
      }, () => { void chrome.runtime.lastError; });
    }

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'media-card';
      card.id = `card-${item.id}`;

      let badgeClass = 'badge-other';
      let badgeText = item.type.toUpperCase();
      if (item.type === 'mp4') {
        badgeClass = 'badge-mp4';
      } else if (item.type === 'm3u8') {
        badgeClass = 'badge-m3u8';
        badgeText = 'HLS STREAM';
      } else if (item.type === 'mpd') {
        badgeClass = 'badge-mpd';
        badgeText = 'DASH STREAM';
      }

      // Mostrar título limpio sin la extensión técnica (.m3u8 / .mpd) en el encabezado de la tarjeta
      const displayTitle = (item.filename || 'Video detectado').replace(/\.(m3u8|mpd|ts)$/i, '');

      let videoBtnHtml = '';
      if (item.type === 'mp4' || item.type === 'webm') {
        videoBtnHtml = `
          <button class="btn btn-primary btn-download-stream" data-id="${item.id}" title="Descargar video en formato MP4">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Descargar .MP4</span>
          </button>`;
      } else if (item.type === 'm3u8') {
        videoBtnHtml = `
          <button class="btn btn-success btn-download-hls" data-id="${item.id}" title="Ensamblar y descargar video en la calidad seleccionada">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Descargar .MP4</span>
          </button>`;
      } else if (item.type === 'mpd') {
        videoBtnHtml = `
          <button class="btn btn-warning btn-download-dash" data-id="${item.id}" title="Ensamblar y descargar video DASH en MP4">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Descargar .MP4</span>
          </button>`;
      }

      const thumbHtml = item.thumbnailUrl
        ? `<img class="media-thumb-img" src="${escapeHtml(item.thumbnailUrl)}" alt="" />`
        : `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"></rect><polygon points="10 9 15 12 10 15 10 9" fill="currentColor"></polygon></svg>`;

      card.innerHTML = `
        <div class="media-card-header">
          <div class="media-thumb-box" id="thumb-${item.id}">
            ${thumbHtml}
          </div>
          <div class="media-title-box">
            <div class="media-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</div>
            <div class="media-meta">
              <span>${item.sizeFormatted}</span>
              <span>•</span>
              <span class="media-origin" title="${escapeHtml(item.url)}">${escapeHtml(getHostname(item.url))}</span>
            </div>
          </div>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>

        <div class="media-actions">
          <div class="actions-grid">
            ${videoBtnHtml}
            <button class="btn btn-audio btn-download-audio" data-id="${item.id}" title="Extraer solo pista de audio en formato MP3">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
              <span>Descargar .MP3</span>
            </button>
            <button class="btn btn-transcribe btn-transcribe-md" data-id="${item.id}" title="Extraer audio e interpretar/transcribir a Markdown con Gemini">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
              <span>Transcribir .MD</span>
            </button>
            <button class="btn btn-copy-url" data-url="${escapeHtml(item.url)}" title="Copiar enlace directo al portapapeles">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span>Copiar enlace</span>
            </button>
          </div>
        </div>

        <div class="progress-box" id="progress-${item.id}">
          <div class="progress-header">
            <span class="progress-status" id="prog-status-${item.id}">Iniciando...</span>
            <span class="progress-pct" id="prog-pct-${item.id}">0%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="prog-fill-${item.id}"></div>
          </div>
        </div>
      `;

      mediaListContainer.appendChild(card);

      const activeState = data[`active_dl_${item.id}`];
      if (activeState && (activeState.status === 'downloading' || activeState.status === 'completed' || activeState.status === 'error')) {
        updateCardProgress(item.id, activeState);
      }
    });

    attachCardEvents(items);
  }

  function updateCardProgress(itemId, state) {
    const progressBox = document.getElementById(`progress-${itemId}`);
    const statusText = document.getElementById(`prog-status-${itemId}`);
    const pctText = document.getElementById(`prog-pct-${itemId}`);
    const fillBar = document.getElementById(`prog-fill-${itemId}`);
    const actionBtns = document.querySelectorAll(`button[data-id="${itemId}"]`);

    if (!progressBox) return;

    progressBox.style.display = 'flex';

    if (state.status === 'downloading') {
      actionBtns.forEach((b) => (b.disabled = true));
      const pct = state.percent || 0;
      pctText.textContent = `${pct}%`;
      fillBar.style.width = `${pct}%`;
      fillBar.style.background = '';

      if (state.statusMessage) {
        statusText.textContent = state.statusMessage;
      } else if (state.totalBytes > 0) {
        statusText.textContent = `Descargando: ${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes)}`;
      } else {
        statusText.textContent = `Descargando: ${formatBytes(state.receivedBytes)}...`;
      }
    } else if (state.status === 'completed') {
      actionBtns.forEach((b) => (b.disabled = false));
      pctText.textContent = '100%';
      fillBar.style.width = '100%';
      fillBar.style.background = '#81c995';
      statusText.textContent = state.statusMessage || (state.audioOnly ? '¡Audio .MP3 guardado con éxito!' : '¡Video .MP4 guardado con éxito!');
      if (state.filepath) {
        statusText.style.cursor = 'pointer';
        statusText.title = 'Clic para mostrar en la carpeta Descargas';
        statusText.onclick = () => {
          chrome.runtime.sendMessage({ action: 'open_downloaded_file', filepath: state.filepath });
        };
      }
    } else if (state.status === 'cancelled') {
      actionBtns.forEach((b) => (b.disabled = false));
      progressBox.style.display = 'none';
    } else if (state.status === 'error') {
      actionBtns.forEach((b) => (b.disabled = false));
      fillBar.style.background = '#f28b82';
      statusText.textContent = `Error: ${state.error || 'Fallo en la descarga'}`;
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') return;

    for (const [key, val] of Object.entries(changes)) {
      if (key.startsWith('active_dl_')) {
        const itemId = key.replace('active_dl_', '');
        if (val.newValue) {
          updateCardProgress(itemId, val.newValue);
        }
      } else if (key === `tab_${activeTabId}`) {
        renderMediaList();
      }
    }
  });

  function attachCardEvents(items) {
    const itemsMap = new Map(items.map((i) => [i.id, i]));

    // Descarga de Solo Audio en MP3
    document.querySelectorAll('.btn-download-audio').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const item = itemsMap.get(id);
        if (!item) return;

        document.querySelectorAll(`button[data-id="${id}"]`).forEach((b) => (b.disabled = true));

        const progressBox = document.getElementById(`progress-${id}`);
        const statusText = document.getElementById(`prog-status-${id}`);
        const pctText = document.getElementById(`prog-pct-${id}`);
        const fillBar = document.getElementById(`prog-fill-${id}`);
        const qOpts = getQualityOptions();

        progressBox.style.display = 'flex';
        statusText.textContent = `Extrayendo audio y convirtiendo a .MP3 (${qOpts.audioKbps} kbps)...`;
        pctText.textContent = '0%';
        fillBar.style.width = '0%';
        fillBar.style.background = '';

        await chrome.storage.session.remove(`active_dl_${id}`).catch(() => {});

        chrome.runtime.sendMessage({
          action: 'start_stream_download',
          mediaItem: item,
          audioOnly: true,
          qualityOptions: qOpts
        }, () => {
          if (chrome.runtime.lastError) {
            statusText.textContent = `Error: ${chrome.runtime.lastError.message}`;
            fillBar.style.background = '#f28b82';
            document.querySelectorAll(`button[data-id="${id}"]`).forEach((b) => (b.disabled = false));
          }
        });

        showToast(`Descarga .MP3 (${qOpts.audioKbps} kbps) iniciada`);
      });
    });

    // Descargas de video (MP4, HLS y DASH)
    document.querySelectorAll('.btn-download-stream, .btn-download-hls, .btn-download-dash').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const item = itemsMap.get(id);
        if (!item) return;

        document.querySelectorAll(`button[data-id="${id}"]`).forEach((b) => (b.disabled = true));

        const progressBox = document.getElementById(`progress-${id}`);
        const statusText = document.getElementById(`prog-status-${id}`);
        const pctText = document.getElementById(`prog-pct-${id}`);
        const fillBar = document.getElementById(`prog-fill-${id}`);
        const qOpts = getQualityOptions();

        progressBox.style.display = 'flex';
        statusText.textContent = 'Replicando sesión e iniciando descarga .MP4...';
        pctText.textContent = '0%';
        fillBar.style.width = '0%';
        fillBar.style.background = '';

        await chrome.storage.session.remove(`active_dl_${id}`).catch(() => {});

        chrome.runtime.sendMessage({
          action: 'start_stream_download',
          mediaItem: item,
          audioOnly: false,
          qualityOptions: qOpts
        }, () => {
          if (chrome.runtime.lastError) {
            statusText.textContent = `Error: ${chrome.runtime.lastError.message}`;
            fillBar.style.background = '#f28b82';
            document.querySelectorAll(`button[data-id="${id}"]`).forEach((b) => (b.disabled = false));
          }
        });

        showToast('Descarga .MP4 iniciada en segundo plano');
      });
    });

    // Transcripción inteligente a .MD con Gemini
    document.querySelectorAll('.btn-transcribe-md').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const item = itemsMap.get(id);
        if (!item) return;

        document.querySelectorAll(`button[data-id="${id}"]`).forEach((b) => (b.disabled = true));

        const progressBox = document.getElementById(`progress-${id}`);
        const statusText = document.getElementById(`prog-status-${id}`);
        const pctText = document.getElementById(`prog-pct-${id}`);
        const fillBar = document.getElementById(`prog-fill-${id}`);
        const qOpts = getQualityOptions();
        const courseContext = inputCourseContext ? inputCourseContext.value.trim() : '';

        progressBox.style.display = 'flex';
        statusText.textContent = 'Extrayendo audio y enviando a Gemini...';
        pctText.textContent = '0%';
        fillBar.style.width = '0%';
        fillBar.style.background = '';

        await chrome.storage.session.remove(`active_dl_${id}`).catch(() => {});

        chrome.runtime.sendMessage({
          action: 'start_stream_download',
          mediaItem: item,
          audioOnly: true,
          transcribeOnly: true,
          courseContext,
          qualityOptions: qOpts
        }, () => {
          if (chrome.runtime.lastError) {
            statusText.textContent = `Error: ${chrome.runtime.lastError.message}`;
            fillBar.style.background = '#f28b82';
            document.querySelectorAll(`button[data-id="${id}"]`).forEach((b) => (b.disabled = false));
          }
        });

        showToast('Transcripción con Gemini iniciada');
      });
    });

    document.querySelectorAll('.btn-copy-url').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const url = e.currentTarget.getAttribute('data-url');
        navigator.clipboard.writeText(url).then(() => {
          showToast('Enlace copiado al portapapeles');
        });
      });
    });
  }

  btnClear.addEventListener('click', async () => {
    if (!activeTabId) return;
    const storageKey = `tab_${activeTabId}`;
    try {
      const data = await chrome.storage.session.get(storageKey);
      const items = data[storageKey] || [];
      const keysToRemove = [storageKey];
      for (const item of items) {
        if (item.id) keysToRemove.push(`active_dl_${item.id}`);
      }
      await chrome.storage.session.remove(keysToRemove);
    } catch (e) {
      await chrome.storage.session.remove(storageKey);
    }
    await chrome.action.setBadgeText({ text: '', tabId: activeTabId });
    await renderMediaList();
    showToast('Lista limpiada');
  });

  btnRefreshTab.addEventListener('click', async () => {
    if (!activeTabId) return;
    await chrome.tabs.reload(activeTabId);
    window.close();
  });

  function getHostname(urlStr) {
    try {
      return new URL(urlStr).hostname;
    } catch (e) {
      return 'remoto';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  await renderMediaList();
});
