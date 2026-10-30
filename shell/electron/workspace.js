const { WebContentsView, session, dialog, shell, nativeTheme } = require('electron');
const { lookup } = require('node:dns/promises');
const { BlockList, isIP } = require('node:net');
const browser = require('./usage-browser');
const ROUTES = Object.freeze({ work: '/work', skills: '/skills', knowledge: '/knowledge', connectors: '/connections', libraries: '/libraries', instructions: '/work', scheduled: '/tasks', docs: 'https://docs.mistral.ai/', admin: 'https://admin.mistral.ai/' });
const ORIGIN = 'https://chat.mistral.ai';
const EMBEDDED = new Set([ORIGIN, 'https://docs.mistral.ai', 'https://admin.mistral.ai']);
const AUTH = new Set(['https://auth.mistral.ai', 'https://v2.auth.mistral.ai']);
const privateIPs = new BlockList();
const privateIPv6 = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',4],['240.0.0.0',4]]) privateIPs.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['::',128],['::1',128],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8]]) privateIPv6.addSubnet(ip, bits, 'ipv6');
async function publicRequest(value, resolve = lookup) {
  try {
    const url = new URL(value);
    if (['data:', 'blob:'].includes(url.protocol)) return true;
    if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address, family }) => !(family === 6 ? privateIPv6.check(address, 'ipv6') : privateIPs.check(address, 'ipv4')));
  } catch { return false; }
}
function cookieDetails(cookie, section = 'work') {
  const domain = cookie.domain?.replace(/^\./, '');
  if (!['mistral.ai', section === 'admin' ? 'admin.mistral.ai' : 'chat.mistral.ai', 'auth.mistral.ai', 'v2.auth.mistral.ai'].includes(domain) || !cookie.secure || cookie.partitionKey) return null;
  const detail = { url: 'https://' + domain + (cookie.path || '/'), name: cookie.name, value: cookie.value,
    path: cookie.path || '/', secure: true, httpOnly: !!cookie.httpOnly,
    sameSite: { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[cookie.sameSite] || 'unspecified' };
  if (cookie.domain.startsWith('.')) detail.domain = cookie.domain;
  if (cookie.expires > 0) detail.expirationDate = cookie.expires;
  return detail;
}
// Read-only Vibe Code Web queries the desktop may run with the web sign-in.
const CODE_READS = Object.freeze({
  'projects.list': () => ({ direction: 'forward' }),
  'sessions.list': params => ({ projectId: codeId(params.projectId), includePinned: true, direction: 'forward' }),
  'sessions.messages': params => ({ sessionId: codeId(params.sessionId), direction: 'forward' }),
});
function codeId(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('Invalid Vibe Code id');
  return value;
}
function codeReadPath(procedure, params) {
  if (!Object.hasOwn(CODE_READS, procedure)) throw new Error('Unknown Vibe Code read');
  params = params && typeof params === 'object' ? params : {};
  const input = CODE_READS[procedure](params);
  if (params.cursor != null) {
    if (typeof params.cursor !== 'string' || !params.cursor || params.cursor.length > 512) throw new Error('Invalid Vibe Code cursor');
    input.cursor = params.cursor;
  }
  return `/api/code-trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`;
}
const READER_IDLE = 5 * 60 * 1000;
function bounds(value, size, zoom = 1) {
  if (!value || !['x','y','width','height'].every(k => Number.isFinite(value[k]))) throw new Error('Invalid workspace bounds');
  value = Object.fromEntries(Object.entries(value).map(([key, number]) => [key, number * zoom]));
  const x = Math.max(0, Math.min(size[0], Math.round(value.x)));
  const y = Math.max(40 * zoom, Math.min(size[1], Math.round(value.y)));
  return { x, y, width: Math.max(0, Math.min(size[0] - x, Math.round(value.width))), height: Math.max(0, Math.min(size[1] - y, Math.round(value.height))) };
}
function createWorkspace(getWindow) {
  const partitions = new Map();
  let view, generation = 0, section = 'work', lastRectangle, lastTheme = 'dark';
  let importing = Promise.resolve(), resetting = Promise.resolve();
  const permissions = new Set(['clipboard-sanitized-write']);
  const notify = (state, detail = '') => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('workspace:state', { status: state, detail, section });
  };
  const getSession = (name = section === 'docs' ? 'persist:mistral-docs' : section === 'admin' ? 'persist:mistral-admin' : 'persist:mistral-workspace') => {
    if (partitions.has(name)) return partitions.get(name);
    const partition = session.fromPartition(name);
    partitions.set(name, partition);
    partition.on('will-download', (event, item, contents) => {
      if (contents !== view?.webContents) { event.preventDefault(); return; }
      const version = generation;
      // Keep Chromium's Save As dialog so a web page never chooses a local path.
      item.once('done', (_event, state) => {
        if (version !== generation) return;
        if (state === 'completed') notify('ready', 'Download saved.');
        else if (state === 'interrupted') notify('error', 'Download failed. Try downloading the file again.');
      });
    });
    const cache = new Map();
    partition.webRequest.onBeforeRequest((details, callback) => {
      let key;
      try { const url = new URL(details.url); if (url.username || url.password) { callback({ cancel: true }); return; } if (!['https:', 'wss:'].includes(url.protocol)) { void publicRequest(details.url).then(allowed => callback({ cancel: !allowed })); return; } key = url.origin; } catch { callback({ cancel: true }); return; }
      const previous = cache.get(key);
      if (previous && previous.until > Date.now()) { callback({ cancel: !previous.allowed }); return; }
      publicRequest(details.url).then(allowed => {
        if (cache.size > 256) cache.clear();
        cache.set(key, { allowed, until: Date.now() + 30000 });
        callback({ cancel: !allowed });
      }).catch(() => callback({ cancel: true }));
    });
    partition.setPermissionCheckHandler((_contents, permission, origin) => {
      try { return EMBEDDED.has(new URL(origin).origin) && (permission === 'clipboard-sanitized-write' || new URL(origin).origin === ORIGIN && permissions.has(permission)); } catch { return false; }
    });
    partition.setPermissionRequestHandler(async (contents, permission, callback, details = {}) => {
      let origin;
      try { origin = new URL(details.requestingUrl || contents?.getURL()).origin; } catch { callback(false); return; }
      if (contents !== view?.webContents || origin !== ORIGIN) { callback(false); return; }
      if (permissions.has(permission)) { callback(true); return; }
      if (!['media', 'notifications', 'fullscreen', 'clipboard-read'].includes(permission)) { callback(false); return; }
      const version = generation;
      try {
        const result = await dialog.showMessageBox(getWindow(), { type: 'question', title: 'Mistral workspace permission',
          message: 'Allow Mistral to use ' + (permission === 'media' ? 'your microphone or camera' : permission === 'clipboard-read' ? 'your clipboard' : permission) + '?',
          buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0 });
        const allowed = result.response === 1 && version === generation && contents === view?.webContents;
        if (allowed) permissions.add(permission);
        callback(allowed);
      } catch { callback(false); }
    });
    return partition;
  };
  const close = () => {
    generation++;
    if (view) {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      view = null;
      if (win && !win.isDestroyed()) win.webContents.focus();
    }
  };
  async function importSignIn(current, destination = section === 'admin' ? 'admin' : 'work') {
    const ses = getSession(destination === 'admin' ? 'persist:mistral-admin' : 'persist:mistral-workspace');
    const existing = await ses.cookies.get({ url: destination === 'admin' ? ROUTES.admin : ORIGIN });
    if (existing.some(cookie => cookie.httpOnly && cookie.secure && cookie.name.startsWith('ory_session_'))) return;
    const cookies = await browser.workspaceCookies(undefined, destination);
    if (!current()) return;
    try {
      for (const cookie of cookies || []) {
        if (!current()) return;
        const detail = cookieDetails(cookie, destination === 'admin' ? 'admin' : 'work');
        if (detail) await ses.cookies.set(detail);
      }
      await ses.cookies.flushStore();
    } catch { throw new Error('Mistral session could not be connected. Sign in again.'); }
  }
  async function focusSection(target, version) {
    if (section !== 'instructions') return;
    const label = 'Instructions';
    // shortcut: Work has no verified panel deep link; use its visible navigation until one is documented.
    const opened = await target.executeJavaScript(`(async () => {
      if (location.origin !== ${JSON.stringify(ORIGIN)}) return false;
      let expanded = false;
      for (let i = 0; i < 40; i++) {
        const links = [...document.querySelectorAll('a,button,[role="button"]')].filter(e => e.getClientRects().length);
        const item = links.find(e => e.textContent.trim().replace(/\\s+/g, ' ') === ${JSON.stringify(label)});
        if (item) { item.click(); return true; }
        const context = links.find(e => e.textContent.trim() === 'Context');
        if (context && !expanded) { context.click(); expanded = true; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return false;
    })()`);
    if (!opened && version === generation) notify('ready', 'Choose Context → ' + label + ' in your Mistral workspace.');
  }
  async function open(next, rectangle, theme = 'dark', address = undefined) {
    if (!['dark', 'light'].includes(theme)) throw new Error('Invalid workspace theme');
    if (!Object.hasOwn(ROUTES, next)) throw new Error('Unknown workspace section');
    close();
    nativeTheme.themeSource = theme;
    section = next;
    lastRectangle = rectangle; lastTheme = theme;
    const version = generation;
    const win = getWindow();
    const position = bounds(rectangle, win.getContentSize(), win.webContents.getZoomFactor());
    notify('loading');
    try {
      await resetting;
      if (version !== generation) return;
      importing = importing.catch(() => {}).then(() => version === generation && next !== 'docs' && importSignIn(() => version === generation));
      await importing;
      if (version !== generation || win.isDestroyed()) return;
      const current = new WebContentsView({ webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      current.setBackgroundColor(theme === 'light' ? '#faf8f3' : '#19191b');
      current.setVisible(false);
      view = current;
      const contents = current.webContents;
      const updatePage = url => {
        if (version !== generation) return;
        const { origin, pathname } = new URL(url);
        if (origin === 'https://docs.mistral.ai') section = 'docs';
        else if (origin === 'https://admin.mistral.ai') section = 'admin';
        else if (origin === ORIGIN) {
          const match = Object.entries(ROUTES).find(([name, route]) => name !== 'instructions' && route.startsWith('/') && (pathname === route || pathname.startsWith(route + '/')));
          // Instructions is a panel inside Work, so its URL cannot identify it.
          if (match && !(section === 'instructions' && match[0] === 'work')) section = match[0];
        }
        contents.setZoomFactor(win.webContents.getZoomFactor());
        if (EMBEDDED.has(origin)) notify('ready');
      };
      contents.on('did-finish-load', () => updatePage(contents.getURL()));
      contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) updatePage(url); });
      const connectorPage = () => {
        try { return new URL(contents.getURL()).pathname.startsWith('/connections'); } catch { return false; }
      };
      const authNotice = () => notify(connectorPage() ? 'connector-auth' : 'signin', connectorPage()
        ? 'This service needs browser authorization. Choose Connect services, finish setup, then return here.'
        : 'Use Sign in to reconnect Mistral securely in Chrome or another Chromium browser.');
      const isolatedPage = url => {
        const origin = new URL(url).origin;
        if (origin === 'https://docs.mistral.ai') return 'docs';
        if (origin === 'https://admin.mistral.ai') return 'admin';
        return 'work';
      };
      const navigation = (event, url) => {
        let origin;
        try { origin = new URL(url).origin; } catch { event.preventDefault(); return; }
        if (EMBEDDED.has(origin) && isolatedPage(url) !== (['docs', 'admin'].includes(next) ? next : 'work')) {
          event.preventDefault();
          void open(isolatedPage(url), lastRectangle, lastTheme, url);
        } else if (!EMBEDDED.has(origin) && !AUTH.has(origin)) {
          event.preventDefault();
          authNotice();
        }
      };
      contents.on('will-navigate', navigation);
      contents.on('will-redirect', navigation);
      contents.setWindowOpenHandler(({ url }) => {
        try {
          const destination = new URL(url);
          if (destination.protocol === 'blob:' && destination.origin === ORIGIN) {
            // Blob exports must be downloaded by their owning renderer.
            void contents.executeJavaScript(`{ const link = document.createElement('a'); link.href = ${JSON.stringify(url)}; link.download = ''; link.click(); }`)
              .catch(() => notify('error', 'The export could not download. Try again.'));
          }
          else if (EMBEDDED.has(destination.origin)) {
            if (isolatedPage(url) !== (['docs', 'admin'].includes(next) ? next : 'work')) void open(isolatedPage(url), lastRectangle, lastTheme, url);
            else void contents.loadURL(url).catch(() => notify('error', 'The workspace page could not load. Try Refresh.'));
          }
          else if (destination.protocol === 'https:' && (connectorPage() || AUTH.has(destination.origin) || destination.hostname === 'accounts.google.com')) authNotice();
          else if (destination.protocol === 'https:') void publicRequest(url).then(allowed => { if (allowed && version === generation) return shell.openExternal(url); }).catch(() => notify('error', 'The link could not open.'));
        } catch { /* Invalid remote link. */ }
        return { action: 'deny' };
      });
      contents.on('did-navigate', (_event, url) => { if (AUTH.has(new URL(url).origin)) authNotice(); });
      contents.on('did-fail-load', (_event, code, _description, _url, main) => {
        if (main && code !== -3 && version === generation) notify('error', 'Mistral could not load. Check your connection and try Refresh.');
      });
      contents.on('render-process-gone', () => { if (version === generation) notify('error', 'The workspace stopped. Try Refresh.'); });
      win.contentView.addChildView(current);
      current.setBounds(position);
      let loadTimer;
      try {
        await Promise.race([
          contents.loadURL(address || (ROUTES[next].startsWith('https:') ? ROUTES[next] : ORIGIN + ROUTES[next])),
          new Promise((_, reject) => { loadTimer = setTimeout(() => {
            contents.stop();
            reject(new Error('Workspace load timed out'));
          }, 30000); }),
        ]);
      } finally { clearTimeout(loadTimer); }
      if (version !== generation) return;
      current.setVisible(true);
      if (EMBEDDED.has(new URL(contents.getURL()).origin)) {
        updatePage(contents.getURL());
        contents.focus();
        notify('ready');
        void focusSection(contents, version).catch(() => { if (version === generation) notify('ready', 'Use Context in Mistral to choose this section.'); });
      }
    } catch {
      if (version === generation) notify('error', 'Could not open Mistral. Try Sign in or Refresh.');
    }
  }
  // A hidden page in the workspace partition answers Vibe Code Web reads, the
  // way the web app itself fetches them, so Mistral's browser checks pass.
  let reader = null;
  const closeReader = () => {
    const current = reader;
    reader = null;
    if (!current) return;
    clearTimeout(current.timer);
    if (current.view && !current.view.webContents.isDestroyed()) current.view.webContents.close();
  };
  function readerPage() {
    if (reader) {
      clearTimeout(reader.timer);
      reader.timer = setTimeout(closeReader, READER_IDLE);
      reader.timer.unref?.();
      return reader.ready;
    }
    const current = reader = { view: null, timer: setTimeout(closeReader, READER_IDLE) };
    current.timer.unref?.();
    current.ready = (async () => {
      await resetting;
      importing = importing.catch(() => {}).then(() => importSignIn(() => reader === current, 'work'));
      await importing;
      if (reader !== current) throw new Error('Vibe Code reader closed');
      const view = current.view = new WebContentsView({ webPreferences: { session: getSession('persist:mistral-workspace'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
      const contents = view.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, url) => {
        try { if (new URL(url).origin !== ORIGIN && !AUTH.has(new URL(url).origin)) event.preventDefault(); } catch { event.preventDefault(); }
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      let timer;
      try {
        await Promise.race([contents.loadURL(ORIGIN + '/code'), new Promise((_, reject) => {
          timer = setTimeout(() => { contents.stop(); reject(new Error('Vibe Code reader timed out')); }, 30000);
        })]);
      } finally { clearTimeout(timer); }
      return contents;
    })();
    return current.ready;
  }
  async function readCode(procedure, params) {
    const path = codeReadPath(procedure, params);
    let contents;
    try { contents = await readerPage(); } catch { closeReader(); return { status: 0, text: '' }; }
    let origin = null;
    try { origin = new URL(contents.getURL()).origin; } catch { /* Treated as signed out below. */ }
    // A sign-in redirect leaves the page off Mistral; reload after the next sign-in.
    if (origin !== ORIGIN) { closeReader(); return { status: 401, text: '' }; }
    try {
      const result = await contents.executeJavaScript(`(async () => {
        if (location.origin !== ${JSON.stringify(ORIGIN)}) return { status: 401, text: '' };
        try {
          const response = await fetch(${JSON.stringify(path)}, { credentials: 'include', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(20000) });
          if (response.type === 'opaqueredirect') return { status: 401, text: '' };
          const text = await response.text();
          return { status: response.status, text: text.length > 16 * 1024 * 1024 ? '' : text };
        } catch { return { status: 0, text: '' }; }
      })()`);
      if (!result || !Number.isInteger(result.status) || typeof result.text !== 'string') throw new Error('Invalid Vibe Code response');
      if (result.status === 401) closeReader();
      return { status: result.status, text: result.text };
    } catch { closeReader(); return { status: 0, text: '' }; }
  }
  return { open, close, readCode,
    resize: rectangle => { lastRectangle = rectangle; if (view) view.setBounds(bounds(rectangle, getWindow().getContentSize(), getWindow().webContents.getZoomFactor())); },
    setZoom: factor => { if (view) view.webContents.setZoomFactor(factor); },
    refresh: () => view ? open(section, lastRectangle, lastTheme, AUTH.has(new URL(view.webContents.getURL()).origin) ? undefined : view.webContents.getURL()) : Promise.resolve(),
    reset: () => {
      close();
      closeReader();
      permissions.clear();
      permissions.add('clipboard-sanitized-write');
      resetting = resetting.catch(() => {}).then(async () => {
        await importing.catch(() => {});
        for (const name of ['persist:mistral-workspace','persist:mistral-docs','persist:mistral-admin']) {
          const ses = partitions.get(name) || session.fromPartition(name);
          await ses.clearStorageData();
          await ses.clearCache();
          await ses.cookies.flushStore();
        }
      });
      return resetting;
    },
  };
}
module.exports = { createWorkspace, publicRequest, cookieDetails, bounds, codeReadPath, ROUTES };
