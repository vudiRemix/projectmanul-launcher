'use strict';
/* global window, document */
(() => {
  const api = window.launcher;
  const $ = (id) => document.getElementById(id);
  const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
  const RESOLUTIONS = [
    [1280, 720],
    [1600, 900],
    [1920, 1080],
    [2560, 1440],
  ];

  const state = {
    info: null,
    settings: null,
    lang: 'ru',
    view: 'home',
    busy: false,
    running: false,
    remote: null,
    news: { items: [] },
    steps: {},
    buildVersion: null,
    logLines: [],
  };

  // ---------- Перевод ----------
  function t(key, params) {
    const dict = window.I18N[state.lang] || window.I18N.ru;
    let s = dict[key] != null ? dict[key] : window.I18N.ru[key] != null ? window.I18N.ru[key] : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  }
  // Поле новости/конфига может быть строкой или объектом {ru, en}.
  function pick(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return value[state.lang] || value.ru || value.en || '';
  }

  function applyI18n() {
    document.documentElement.lang = state.lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    for (const b of document.querySelectorAll('.lang-btn')) b.classList.toggle('active', b.dataset.lang === state.lang);
    for (const b of document.querySelectorAll('.seg-btn')) {
      b.classList.toggle('active', b.dataset.setLang === state.lang);
      b.setAttribute('aria-pressed', String(b.dataset.setLang === state.lang));
    }
    renderNews();
    renderServer(state.lastStatus);
    renderBuildState();
    renderSteps();
    renderRam();
    renderPlayButton();
  }

  async function setLang(lang) {
    state.lang = lang;
    state.settings = await api.setSettings({ language: lang });
    applyI18n();
  }

  // ---------- Мелочи ----------
  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function showModal(title, text) {
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    $('modal').classList.remove('hidden');
    $('modal-close').focus();
  }

  function mb(bytes) {
    return (bytes / 1048576).toFixed(bytes > 104857600 ? 0 : 1);
  }

  function formatEta(sec) {
    if (sec == null) return '';
    const v = sec >= 60 ? `${Math.ceil(sec / 60)} ${t('min')}` : `${sec} ${t('sec')}`;
    return t('eta', { eta: v });
  }

  function formatDate(s) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : null;
    if (!d || Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(state.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ---------- Экраны ----------
  function showScreen(name) {
    $('screen-login').classList.toggle('hidden', name !== 'login');
    $('screen-main').classList.toggle('hidden', name !== 'main');
    if (name === 'login') {
      $('nick').value = state.settings.nick || '';
      $('remember').checked = state.settings.rememberNick;
      validateNick();
      $('nick').focus();
    } else {
      $('player-nick').textContent = state.settings.nick;
    }
  }

  function showView(view) {
    state.view = view;
    const effective = state.busy && view === 'home' ? 'prepare' : view;
    for (const v of ['home', 'prepare', 'settings', 'logs']) $(`view-${v}`).classList.toggle('hidden', v !== effective);
    for (const b of document.querySelectorAll('.nav-item')) {
      const active = b.dataset.view === view;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    $('aside').classList.toggle('hidden', view === 'settings' || view === 'logs');
    if (view === 'logs') renderLog(true);
  }

  // ---------- Вход ----------
  let nickTimer;
  let nickSeq = 0;
  function validateNick() {
    const nick = $('nick').value.trim();
    const ok = NICK_RE.test(nick);
    const showError = nick.length > 0 && !ok;
    $('nick').classList.toggle('invalid', showError);
    $('nick').setAttribute('aria-invalid', String(showError));
    $('nick-hint').textContent = showError ? t('nickInvalid') : t('nickHint');
    $('nick-hint').classList.toggle('error', showError);
    $('btn-login').disabled = !ok;
    $('nick-warning').classList.add('hidden');
    clearTimeout(nickTimer);
    if (ok) {
      const seq = ++nickSeq;
      nickTimer = setTimeout(async () => {
        const res = await api.checkNick(nick);
        if (seq === nickSeq) $('nick-warning').classList.toggle('hidden', res.status !== 'registered');
      }, 450);
    }
    return ok;
  }

  async function submitLogin(e) {
    e.preventDefault();
    if (!validateNick()) return;
    state.settings = await api.setSettings({ nick: $('nick').value.trim(), rememberNick: $('remember').checked });
    showScreen('main');
  }

  // ---------- Новости и сервер ----------
  function renderNews() {
    const box = $('news');
    if (!box) return;
    box.textContent = '';
    const items = state.news.items || [];
    if (state.news.offline && items.length) {
      const p = document.createElement('p');
      p.className = 'news-empty';
      p.textContent = t('newsOffline');
      box.appendChild(p);
    }
    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'news-empty';
      p.textContent = t('newsEmpty');
      box.appendChild(p);
      return;
    }
    const card = (item, main) => {
      const el = document.createElement('article');
      el.className = main ? 'news-main' : 'news-small';
      if (main && item.image) {
        const img = document.createElement('img');
        img.src = item.image;
        img.alt = '';
        img.addEventListener('error', () => img.remove());
        el.appendChild(img);
      }
      const body = document.createElement('div');
      body.className = main ? 'news-body' : 'col';
      body.style.gap = main ? '' : '6px';
      const meta = document.createElement('span');
      meta.className = 'news-meta';
      meta.textContent = [formatDate(item.date), pick(item.tag)].filter(Boolean).join(' · ');
      const title = document.createElement('h2');
      title.className = 'news-title';
      title.textContent = pick(item.title);
      const text = document.createElement('p');
      text.className = 'news-text';
      text.textContent = pick(item.text);
      body.append(meta, title, text);
      if (item.link) {
        const a = document.createElement('a');
        a.href = item.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'link';
        a.textContent = item.link.replace(/^https:\/\//, '');
        body.appendChild(a);
      }
      el.appendChild(body);
      return el;
    };
    box.appendChild(card(items[0], true));
    const rest = items.slice(1);
    if (rest.length) {
      const grid = document.createElement('div');
      grid.className = 'news-grid';
      for (const item of rest) grid.appendChild(card(item, false));
      box.appendChild(grid);
    }
  }

  function renderServer(status) {
    state.lastStatus = status;
    const r = state.remote;
    const el = $('server-state');
    el.classList.remove('online', 'maint');
    let label = t('offline');
    if (r && r.maintenance.enabled) {
      el.classList.add('maint');
      label = t('maintenance');
    } else if (status && status.online) {
      el.classList.add('online');
      label = t('online');
    }
    $('server-state-text').textContent = label;
    if (status && status.online) {
      $('players-n').textContent = status.players;
      $('players-max').textContent = t('playersOf', { max: status.maxPlayers });
      $('players-bar').style.width = `${status.maxPlayers ? Math.min(100, (status.players / status.maxPlayers) * 100) : 0}%`;
    } else {
      $('players-n').textContent = '—';
      $('players-max').textContent = '';
      $('players-bar').style.width = '0';
    }
    $('server-address').textContent = r ? `${r.server.host}:${r.server.port}` : '';
    const maint = r && r.maintenance.enabled ? pick(r.maintenance.message) : '';
    $('maintenance').textContent = maint;
    $('maintenance').classList.toggle('hidden', !maint);
  }

  function renderBuildState() {
    if (state.buildVersion) {
      $('build-state').textContent = `✓ ${t('buildOk')}`;
      $('build-state-sub').textContent = t('buildOkSub', { version: state.buildVersion });
    } else {
      $('build-state').textContent = t('buildUnknown');
      $('build-state-sub').textContent = t('buildUnknownSub');
    }
  }

  async function refreshServer() {
    try {
      renderServer(await api.serverStatus());
    } catch {
      renderServer(null);
    }
  }

  async function loadRemote() {
    const res = await api.loadRemote();
    state.remote = res.remote;
    state.news = res.news || { items: [] };
    renderNews();
    renderServer(state.lastStatus);
    refreshServer();
  }

  // ---------- Подготовка и запуск ----------
  function renderSteps() {
    for (const li of document.querySelectorAll('#steps li')) {
      const s = state.steps[li.dataset.step] || 'pending';
      li.className = s === 'pending' ? '' : s;
      const key = { pending: 'stepPending', active: 'stepActive', done: 'stepDone', error: 'stepError' }[s];
      li.querySelector('.step-status').textContent = t(key);
    }
  }

  function renderPlayButton() {
    const btn = $('btn-play');
    btn.disabled = state.busy || state.running;
    $('btn-play-text').textContent = state.running ? t('inGame') : state.busy ? t('wait') : t('play');
    $('btn-cancel').classList.toggle('hidden', !state.busy);
    $('progress-block').classList.toggle('hidden', !state.busy);
    $('player-block').classList.toggle('hidden', state.busy);
    $('footer-space').classList.toggle('hidden', state.busy);
    $('footer-hint').classList.toggle('hidden', state.busy);
    for (const id of ['btn-verify', 'btn-dir', 'btn-change-nick']) $(id).disabled = state.busy || state.running;
  }

  function onProgress(p) {
    const [stage, sub] = p.stage.split(':');
    const checking = sub === 'check';
    $('progress-title').textContent = checking ? t('stage_check') : t(`stage_${stage}`);
    $('progress-pct').textContent = p.indeterminate ? '…' : `${Math.floor(p.percent)}%`;
    $('progress-fill').style.width = `${p.percent}%`;
    $('progress-bar').setAttribute('aria-valuenow', String(Math.floor(p.percent)));
    $('progress-detail').textContent = checking
      ? t('checking', { done: p.doneFiles, total: p.totalFiles })
      : p.totalBytes > 0
        ? t('progressDetail', { files: p.doneFiles, total: p.totalFiles, done: mb(p.doneBytes), size: mb(p.totalBytes), speed: (p.speed / 1048576).toFixed(1) }) + formatEta(p.eta)
        : '';
    if (p.current) $('current-file').textContent = p.current;
  }

  function setBusy(busy) {
    state.busy = busy;
    if (busy) {
      state.steps = {};
      renderSteps();
      $('prepare-error').classList.add('hidden');
      $('current-file').textContent = '—';
      onProgress({ stage: 'check:check', percent: 0, doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0 });
    }
    renderPlayButton();
    showView(state.view === 'home' || busy ? 'home' : state.view);
  }

  function showError(res) {
    $('prepare-error').textContent = res.error;
    $('prepare-error').classList.remove('hidden');
    showView('home');
    $('view-prepare').classList.remove('hidden');
    $('view-home').classList.add('hidden');
  }

  async function play() {
    if (state.busy || state.running) return;
    setBusy(true);
    const res = await api.play();
    setBusy(false);
    if (res.ok) {
      state.buildVersion = res.version;
      renderBuildState();
      if (res.removed && res.removed.length) toast(t('removedExtra', { list: res.removed.join(', ') }));
    } else if (!res.cancelled) {
      showError(res);
    }
  }

  async function verify() {
    if (state.busy || state.running) return;
    showView('home');
    setBusy(true);
    const res = await api.verify();
    setBusy(false);
    if (res.ok) {
      state.buildVersion = res.version;
      renderBuildState();
      toast(res.removed && res.removed.length ? t('removedExtra', { list: res.removed.join(', ') }) : t('verifyDone'));
    } else if (!res.cancelled) {
      showError(res);
    }
  }

  // ---------- Настройки ----------
  function renderRam() {
    if (!state.info || !state.settings) return;
    const mem = state.info.memory;
    const ram = state.settings.ramGb;
    $('ram').min = mem.min;
    $('ram').max = mem.max;
    $('ram').value = ram;
    $('ram-value').textContent = `${ram} ${t('gb')}`;
    $('ram-min').textContent = `${mem.min} ${t('gb')}`;
    $('ram-max').textContent = `${mem.max} ${t('gb')}`;
    let hint = t('ramRecommended');
    let color = 'var(--ok)';
    if (ram < 4) {
      hint = t('ramLow');
      color = 'var(--accent-text)';
    } else if (ram > Math.max(mem.recommended + 2, 10)) {
      hint = t('ramHigh');
      color = 'var(--accent-text)';
    } else if (ram !== mem.recommended) {
      hint = `${t('ramRecommended')}: ${mem.recommended} ${t('gb')}`;
      color = 'var(--muted)';
    }
    $('ram-hint').textContent = hint;
    $('ram-hint').style.color = color;
  }

  function renderSettings() {
    const s = state.settings;
    renderRam();
    $('jvm').value = s.jvmArgs;
    $('fullscreen').checked = s.fullscreen;
    const sel = $('resolution');
    sel.textContent = '';
    const list = RESOLUTIONS.slice();
    if (!list.some(([w, h]) => w === s.width && h === s.height)) list.unshift([s.width, s.height]);
    for (const [w, h] of list) {
      const o = document.createElement('option');
      o.value = `${w}x${h}`;
      o.textContent = `${w} × ${h}`;
      o.selected = w === s.width && h === s.height;
      sel.appendChild(o);
    }
    sel.disabled = s.fullscreen;
    $('game-dir').value = s.gameDir || state.info.defaultGameDir;
  }

  async function saveSettings(patch) {
    state.settings = await api.setSettings(patch);
    renderSettings();
  }

  // ---------- Логи ----------
  function renderLog(scroll) {
    const el = $('log');
    el.textContent = state.logLines.join('\n');
    if (scroll) el.scrollTop = el.scrollHeight;
  }

  let logPending = false;
  function onLogLine(line) {
    state.logLines.push(line);
    if (state.logLines.length > 500) state.logLines.splice(0, state.logLines.length - 500);
    if (state.view !== 'logs' || logPending) return;
    logPending = true;
    window.requestAnimationFrame(() => {
      logPending = false;
      const el = $('log');
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      renderLog(atBottom);
    });
  }

  // ---------- Запуск ----------
  function bind() {
    $('btn-min').addEventListener('click', () => api.minimize());
    $('btn-close').addEventListener('click', () => api.close());
    for (const b of document.querySelectorAll('.lang-btn')) b.addEventListener('click', () => setLang(b.dataset.lang));
    for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setLang(b.dataset.setLang));
    $('nick').addEventListener('input', validateNick);
    $('login-form').addEventListener('submit', submitLogin);
    for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => showView(b.dataset.view));
    $('btn-change-nick').addEventListener('click', () => showScreen('login'));
    $('btn-play').addEventListener('click', play);
    $('btn-cancel').addEventListener('click', () => api.cancel());
    $('btn-verify').addEventListener('click', verify);
    $('ram').addEventListener('input', () => {
      state.settings.ramGb = Number($('ram').value);
      renderRam();
    });
    $('ram').addEventListener('change', () => saveSettings({ ramGb: Number($('ram').value) }));
    let jvmTimer;
    $('jvm').addEventListener('input', () => {
      clearTimeout(jvmTimer);
      jvmTimer = setTimeout(() => saveSettings({ jvmArgs: $('jvm').value }), 600);
    });
    $('resolution').addEventListener('change', () => {
      const [w, h] = $('resolution').value.split('x').map(Number);
      saveSettings({ width: w, height: h });
    });
    $('fullscreen').addEventListener('change', () => saveSettings({ fullscreen: $('fullscreen').checked }));
    $('btn-dir').addEventListener('click', async () => {
      const s = await api.chooseGameDir();
      if (s) {
        state.settings = s;
        renderSettings();
      }
    });
    $('btn-open-dir').addEventListener('click', () => api.openGameDir());
    $('btn-copy-logs').addEventListener('click', async () => {
      await api.copyLogs();
      toast(t('copied'));
    });
    $('btn-open-logs').addEventListener('click', () => api.openLogs());
    $('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'));
    $('modal-copy').addEventListener('click', async () => {
      await api.copyLogs();
      toast(t('copied'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $('modal').classList.add('hidden');
    });

    api.onProgress(onProgress);
    api.onSteps((steps) => {
      state.steps = steps;
      renderSteps();
    });
    api.onLog(onLogLine);
    api.onUpdate((u) => toast(t('updating', { version: u.version })));
    api.onGameState((s) => {
      state.running = s.running;
      renderPlayButton();
      if (!s.running && s.crashed) {
        showModal(t('crashTitle'), t('crashText', { code: s.code }) + (s.crashFile ? t('crashFile', { file: s.crashFile }) : ''));
      }
      if (!s.running) refreshServer();
    });
  }

  async function init() {
    bind();
    state.info = await api.info();
    state.settings = await api.getSettings();
    state.lang = state.settings.language || (String(state.info.locale).toLowerCase().startsWith('ru') ? 'ru' : 'en');
    state.logLines = await api.getLogs();
    $('project-name').textContent = state.info.projectName;
    $('login-title').textContent = state.info.projectName;
    $('app-version').textContent = `v${state.info.version}`;
    document.title = state.info.projectName;
    if (!state.info.configured) {
      $('config-banner').textContent = t('notConfigured', { problems: state.info.problems.join('\n') });
      $('config-banner').classList.remove('hidden');
    }
    renderSettings();
    applyI18n();
    showView('home');
    showScreen(state.settings.nick && NICK_RE.test(state.settings.nick) ? 'main' : 'login');
    const gs = await api.gameState();
    state.running = gs.running;
    renderPlayButton();
    loadRemote().catch(() => {});
    window.setInterval(refreshServer, 30000);
    api.checkUpdate().catch(() => {});
  }

  init();
})();
