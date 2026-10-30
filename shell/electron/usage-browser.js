// Google sign-in uses normal Chrome; the background reader only reads usage.
// This private profile belongs to VibeDeck. Only Mistral cookies may enter the isolated desktop workspace.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ORIGINS = ['https://admin.mistral.ai', 'https://console.mistral.ai'];
const profile = () => path.join(app.getPath('userData'), 'MistralUsageBrowser');
const marker = () => path.join(profile(), '.vibedeck-connected');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let signInBrowser, starting, connecting, confirmation, quitting = false;
function confirmSignIn(accepted) {
  if (!confirmation) return false;
  const resolve = confirmation; confirmation = null;
  resolve(accepted === true ? 0 : 1);
  return true;
}

async function endpoint() {
  try {
    const [port, browserPath] = (await fs.readFile(path.join(profile(), 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    if (!/^\d+$/.test(port) || !browserPath?.startsWith('/devtools/browser/')) return null;
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
    const version = await response.json();
    const ws = new URL(version.webSocketDebuggerUrl);
    if (!['127.0.0.1', 'localhost'].includes(ws.hostname) || ws.port !== port || ws.pathname !== browserPath) return null;
    return base;
  } catch { return null; }
}

async function command(base, target, method, params = {}, timeout = 20000) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/devtools/${target}`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Usage browser timed out.')); ws.close(); }, timeout);
      const fail = () => { clearTimeout(timer); reject(new Error('Usage browser connection closed.')); };
      ws.addEventListener('error', fail, { once: true });
      ws.addEventListener('close', fail, { once: true });
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })), { once: true });
      ws.addEventListener('message', event => {
        let data;
        try { data = JSON.parse(event.data); } catch { fail(); return; }
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (data.error) reject(new Error('Usage browser request failed.'));
        else resolve(data.result);
      });
    });
  } finally { ws.close(); }
}

async function pages(base) {
  const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2000) });
  return (await response.json()).filter(page => page.type === 'page');
}
async function browserTarget(base) {
  const [port, browserPath] = (await fs.readFile(path.join(profile(), 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  if (`http://127.0.0.1:${port}` !== base) throw new Error('Usage browser changed. Try connecting again.');
  return browserPath.slice('/devtools/'.length);
}
// The reader drives the browser over the Chrome DevTools Protocol, so any
// Chromium-based browser works. Firefox-based browsers (Firefox, Zen,
// LibreWolf) no longer expose CDP and cannot be used.
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave', 'brave-browser',
  'helium-browser', 'helium', 'vivaldi', 'vivaldi-stable', 'microsoft-edge', 'microsoft-edge-stable', 'opera', 'thorium-browser', 'ungoogled-chromium'];
const LINUX_FIXED = ['/opt/google/chrome/chrome', '/opt/brave.com/brave/brave', '/opt/helium-browser-bin/helium', '/opt/vivaldi/vivaldi',
  '/opt/microsoft/msedge/msedge', '/var/lib/flatpak/exports/bin/com.google.Chrome', '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
  '/var/lib/flatpak/exports/bin/com.brave.Browser'];
async function executable() {
  const candidates = [];
  if (process.env.VIBEDECK_BROWSER) candidates.push(process.env.VIBEDECK_BROWSER);
  if (process.platform === 'darwin') {
    candidates.push(...['Google Chrome', 'Chromium', 'Brave Browser', 'Helium', 'Vivaldi', 'Microsoft Edge', 'Arc']
      .map(name => `/Applications/${name}.app/Contents/MacOS/${name}`));
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) candidates.push(...['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe',
      'BraveSoftware/Brave-Browser/Application/brave.exe', 'Microsoft/Edge/Application/msedge.exe', 'Vivaldi/Application/vivaldi.exe']
      .map(rel => path.join(root, rel)));
  } else {
    const dirs = (process.env.PATH || '/usr/bin').split(path.delimiter).filter(Boolean);
    for (const name of LINUX_BROWSERS) candidates.push(...dirs.map(dir => path.join(dir, name)));
    candidates.push(...LINUX_FIXED);
    const flatpak = path.join(process.env.HOME || '', '.local/share/flatpak/exports/bin');
    candidates.push(...['com.google.Chrome', 'org.chromium.Chromium', 'com.brave.Browser'].map(id => path.join(flatpak, id)));
  }
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('Install a Chromium-based browser (Chrome, Chromium, Brave, Helium, Vivaldi or Edge) to connect Mistral usage. '
    + 'Firefox and Zen do not support the DevTools protocol VibeDeck uses. Set VIBEDECK_BROWSER to point at a custom browser.');
}
async function stopBrowsers() {
  if (starting) await starting.catch(() => {});
  const child = signInBrowser;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt++) await pause(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error('Close the Chrome sign-in window to finish connecting.');
  }
  signInBrowser = null;
  const base = await endpoint();
  if (!base) return;
  try { await command(base, await browserTarget(base), 'Browser.close'); }
  catch (error) { if (await endpoint()) throw error; }
  for (let attempt = 0; attempt < 50 && await endpoint(); attempt++) await pause(100);
  if (await endpoint()) throw new Error('Close the usage browser, then try again.');
}
async function startReader() {
  await fs.rm(path.join(profile(), 'DevToolsActivePort'), { force: true });
  const child = spawn(await executable(), [`--user-data-dir=${profile()}`, '--headless=new',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `${ORIGINS[0]}/subscription`],
    { stdio: 'ignore', detached: true });
  let failure;
  child.once('error', () => { failure = new Error('Could not open the usage reader.'); });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failure) throw failure;
    const base = await endpoint();
    if (base) return base;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await pause(200);
  }
  throw new Error('Usage reader did not start. Try connecting again.');
}
async function ensureReader() {
  if (quitting || connecting || (signInBrowser && signInBrowser.exitCode === null && signInBrowser.signalCode === null)) return null;
  if (starting) return starting;
  starting = (async () => {
    const base = await endpoint();
    if (base) return base;
    try { await fs.access(marker()); } catch { return null; }
    return startReader();
  })();
  try { return await starting; } finally { starting = null; }
}
async function signIn(parent, destination) {
  const existing = signInBrowser && signInBrowser.exitCode === null && signInBrowser.signalCode === null;
  if (!existing || destination !== 'work') await stopBrowsers();
  await fs.mkdir(profile(), { recursive: true, mode: 0o700 });
  await fs.chmod(profile(), 0o700);
  // Never attach debugging or automation during interactive Google sign-in.
  const child = existing && destination === 'work' ? signInBrowser : spawn(await executable(), [`--user-data-dir=${profile()}`, '--no-first-run', '--no-default-browser-check', '--new-window', destination === 'admin' ? 'https://admin.mistral.ai/' : destination === 'connectors' ? 'https://chat.mistral.ai/connections' : 'https://chat.mistral.ai/work'],
    { stdio: 'ignore', detached: true });
  signInBrowser = child;
  let failure;
  child.once('error', () => { failure = new Error('Could not open the sign-in browser.'); confirmSignIn(true); });
  child.unref();
  if (quitting) return false;
  if (failure) throw failure;
  const response = await new Promise(resolve => { confirmation = resolve; });
  if (quitting) return false;
  if (response !== 0) {
    try { await fs.access(marker()); } catch { return false; }
    await stopBrowsers();
    await startReader();
    return false;
  }
  if (failure) throw failure;
  await stopBrowsers();
  const base = await startReader();
  const cookies = await workspaceCookies(base, destination === 'admin' ? 'admin' : 'work');
  if (!cookies.some(cookie => cookie.name.startsWith('ory_session_') && cookie.secure && cookie.httpOnly && (cookie.expires == null || cookie.expires < 0 || cookie.expires > Date.now() / 1000))) {
    throw new Error('Mistral sign-in was not completed. Finish signing in with Google or email, then choose “I’ve signed in”.');
  }
  await fs.writeFile(marker(), '1', { mode: 0o600 });
  return true;
}
async function connect(parent, destination = 'work') {
  if (!['work', 'connectors', 'admin'].includes(destination)) throw new Error('Invalid account destination');
  if (quitting) return false;
  if (!connecting) connecting = signIn(parent, destination).finally(() => { connecting = null; });
  return connecting;
}

function allowedRequest(value) {
  try {
    const url = new URL(value);
    return (url.origin === ORIGINS[0] && ['/subscription', '/api/billing/v2/usage'].includes(url.pathname))
      || (url.origin === ORIGINS[1] && url.pathname === '/api-ui/trpc/billing.vibeUsage');
  } catch { return false; }
}
async function read(value) {
  if (!allowedRequest(value)) throw new Error('Untrusted usage request.');
  const base = await ensureReader();
  if (!base) return null;
  const origin = new URL(value).origin;
  let target = (await pages(base)).find(page => {
    try { return new URL(page.url).origin === origin; } catch { return false; }
  });
  if (!target) {
    const { targetId } = await command(base, await browserTarget(base), 'Target.createTarget', { url: origin === ORIGINS[0] ? `${origin}/subscription` : `${origin}/` });
    for (let attempt = 0; attempt < 50; attempt++) {
      target = (await pages(base)).find(page => page.id === targetId);
      if (target?.url.startsWith(origin + '/')) break;
      if (target?.url.startsWith('https://v2.auth.mistral.ai/') || target?.url.startsWith('https://auth.mistral.ai/')) {
        return { status: 401, type: 'basic', text: '' };
      }
      await pause(100);
    }
    if (!target?.url.startsWith(origin + '/')) throw new Error('Mistral usage page could not be opened.');
  }
  let ready = false;
  const deadline = Date.now() + 15000;
  for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt++) {
    try {
      const state = await command(base, `page/${target.id}`, 'Runtime.evaluate', {
        expression: `location.origin === ${JSON.stringify(origin)} && document.readyState !== 'loading'`, returnByValue: true,
      }, Math.min(3000, Math.max(1, deadline - Date.now())));
      if (state.result?.value === true) { ready = true; break; }
    } catch { /* The execution context changes during navigation. */ }
    const current = (await pages(base)).find(page => page.id === target.id);
    if (current?.url.startsWith('https://v2.auth.mistral.ai/') || current?.url.startsWith('https://auth.mistral.ai/')) {
      return { status: 401, type: 'basic', text: '' };
    }
    await pause(100);
  }
  if (!ready) throw new Error('Mistral usage page is still loading. Try refreshing.');
  const result = await command(base, `page/${target.id}`, 'Runtime.evaluate', {
    expression: `(async () => {
      if (location.origin !== ${JSON.stringify(origin)}) return null;
      const response = await fetch(${JSON.stringify(value)}, {credentials:'include',cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(15000)});
      const text = await response.text();
      if (text.length > 12 * 1024 * 1024) throw new Error('Usage response too large.');
      return {status:response.status,type:response.type,text};
    })()`, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error('Mistral usage could not be read.');
  return result.result.value;
}
async function workspaceCookies(base = undefined, destination = 'work') {
  if (!['work', 'admin'].includes(destination)) throw new Error('Invalid cookie destination');
  base ||= await ensureReader();
  if (!base) return [];
  let target = (await pages(base)).find(page => {
    try { return [...ORIGINS, 'https://chat.mistral.ai', 'https://auth.mistral.ai', 'https://v2.auth.mistral.ai'].includes(new URL(page.url).origin); } catch { return false; }
  });
  let temporary;
  if (!target) {
    const result = await command(base, await browserTarget(base), 'Target.createTarget', { url: 'about:blank' });
    temporary = result.targetId;
    target = { id: temporary };
  }
  try {
    const result = await command(base, `page/${target.id}`, 'Network.getCookies', {
      urls: [destination === 'admin' ? 'https://admin.mistral.ai/' : 'https://chat.mistral.ai/', 'https://auth.mistral.ai/', 'https://v2.auth.mistral.ai/'],
    });
    return (result.cookies || []).filter(cookie => ['mistral.ai', destination === 'admin' ? 'admin.mistral.ai' : 'chat.mistral.ai', 'auth.mistral.ai', 'v2.auth.mistral.ai'].includes(cookie.domain?.replace(/^\./, '')));
  } finally {
    if (temporary) await command(base, await browserTarget(base), 'Target.closeTarget', { targetId: temporary }).catch(() => {});
  }
}
async function shutdown() {
  quitting = true;
  confirmSignIn(false);
  if (connecting) await connecting.catch(() => {});
  await stopBrowsers();
}
async function disconnect() {
  try { await shutdown(); await fs.rm(profile(), { recursive: true, force: true }); }
  finally { quitting = false; }
}
async function account() {
  try { await fs.access(marker()); return { remembered: true }; }
  catch (error) { if (error.code === 'ENOENT') return { remembered: false }; throw error; }
}
module.exports = { account, confirmSignIn, connect, disconnect, shutdown, workspaceCookies, read, available: async () => !!await ensureReader(), allowedRequest };
