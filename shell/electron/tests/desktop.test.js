const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function load({ saved = null } = {}) {
  const writes = [];
  const menus = [];
  const tray = { tooltip: '', handlers: {}, setToolTip(text) { this.tooltip = text; }, setContextMenu(menu) { menus.push(menu); }, on(event, fn) { this.handlers[event] = fn; }, destroy() {} };
  const icon = { isEmpty: () => false, resize: () => icon };
  const electron = {
    app: { getPath: () => '/tmp/vibedeck-desktop-fixture', quit() {} },
    Menu: { buildFromTemplate: template => template },
    Tray: function Tray() { return tray; },
    nativeImage: { createFromPath: () => icon },
  };
  const fakeFS = {
    readFile: async () => { if (saved === null) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return saved; },
    writeFile: async (_file, data) => { writes.push(JSON.parse(data)); },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(require.resolve('../desktop'), 'utf8');
  new Function('require', 'module', '__dirname', source)(id => id === 'electron' ? electron : id === 'node:fs/promises' ? fakeFS : require(id), module, '/fixture');
  const shown = [], routes = [];
  const desktop = module.exports.createDesktop({ getWindow: () => null, showWindow: () => shown.push(1), navigate: route => routes.push(route) });
  return { desktop, tray, menus, writes, shown, routes };
}

test('close-to-tray is opt-in and needs a tray icon', async () => {
  const { desktop, writes } = load();
  await desktop.load();
  assert.deepEqual(desktop.get(), { closeToTray: false, tray: false });
  await desktop.update({ closeToTray: true });
  assert.deepEqual(writes, [{ closeToTray: true }]);
  assert.equal(desktop.keepRunning(), false, 'Without a tray there is no way back, so the window must close normally');
  desktop.start();
  assert.equal(desktop.keepRunning(), true);
});

test('saved preference loads and invalid input is rejected', async () => {
  const { desktop, writes } = load({ saved: '{"closeToTray":true}' });
  await desktop.load();
  assert.equal(desktop.get().closeToTray, true);
  for (const patch of [null, 'yes', { closeToTray: 'true' }, { closeToTray: 1 }]) await assert.rejects(desktop.update(patch), /Invalid desktop settings/);
  assert.equal(writes.length, 0);
});

test('tray menu shows usage, toggles the setting and routes the app', async () => {
  const { desktop, tray, menus, routes, writes } = load();
  await desktop.load();
  desktop.start();
  desktop.setUsage({ label: 'Vibe Code', percent: 5.4 });
  assert.equal(tray.tooltip, 'VibeDeck — Vibe Code: 5% used');
  const menu = menus.at(-1);
  menu.find(item => item.label === 'Usage').click();
  assert.deepEqual(routes, ['/usage']);
  const keep = menu.find(item => item.label === 'Keep running when closed');
  assert.equal(keep.checked, false);
  keep.click({ checked: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [{ closeToTray: true }]);
  for (const value of [{ label: 'x', percent: NaN }, { label: 1, percent: 2 }, 'x']) assert.throws(() => desktop.setUsage(value), /Invalid usage/);
  desktop.setUsage(null);
  assert.equal(tray.tooltip, 'VibeDeck');
});
