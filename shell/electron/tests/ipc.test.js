const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('usage IPC rejects remote callers and preserves workspace when sign-in is cancelled or fails', async () => {
  const handlers = new Map();
  let reads = 0, resets = 0, focused = 0;
  const usage = { read: () => { reads++; return { status: 'ready' }; }, connect() {}, disconnect() {} };
  const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { setDesktopName(name) {assert.equal(name,'vibedeck.desktop');}, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), on() {} } };
  const moduleObject = { exports: {} };
  const source = fs.readFileSync(require.resolve('../main'), 'utf8');
  new Function('require', 'module', '__dirname', source + '\nmodule.exports = value => { win = value; };')(
    name => name === 'electron' ? electron : name === './usage' ? usage : name === './desktop' ? { createDesktop: () => ({ get: () => ({ closeToTray: false, tray: true }), update: async () => {}, setUsage() {}, keepRunning: () => false }) } : name === './workspace' ? { createWorkspace: () => ({ open() {}, resize() {}, close() {}, reset() { resets++; } }) } : require(name), moduleObject, path.join(__dirname, '..'));
  const contents = {};
  moduleObject.exports({ webContents: contents, isDestroyed: () => false, focus: () => {focused++;} });
  const origin = new URL(process.env.VIBEDECK_URL || `http://127.0.0.1:${process.env.VIBEDECK_PORT || 9377}`).origin;
  const read = handlers.get('usage:read');
  assert.deepEqual(read({ sender: contents, senderFrame: { origin } }, 2026, 10), { status: 'ready' });
  assert.throws(() => read({ sender: contents, senderFrame: { origin: 'https://admin.mistral.ai' } }, 2026, 10), /Untrusted/);
  assert.throws(() => read({ sender: {}, senderFrame: { origin } }, 2026, 10), /Untrusted/);
  assert.throws(() => read({ sender: contents, senderFrame: null }, 2026, 10), /Untrusted/);
  assert.equal(reads, 1);
  for (const name of ['workspace:open', 'workspace:resize', 'workspace:close', 'workspace:signin', 'workspace:connectors', 'usage:confirm-signin', 'usage:account', 'workspace:refresh', 'window:get-zoom', 'window:set-zoom', 'desktop:get', 'desktop:set', 'tray:set-usage']) {
    assert.throws(() => handlers.get(name)({ sender: contents, senderFrame: { origin: 'https://chat.mistral.ai' } }), /Untrusted/);
    assert.throws(() => handlers.get(name)({ sender: {}, senderFrame: { origin } }), /Untrusted/);
  }
  const trusted={sender:contents,senderFrame:{origin}};
  for(const channel of ['usage:connect','workspace:signin']) {
    usage.connect=async()=>false;
    assert.equal(await handlers.get(channel)(trusted),false);
    assert.equal(resets,0);
    usage.connect=async()=>{throw new Error('incomplete');};
    await assert.rejects(handlers.get(channel)(trusted),/incomplete/);
    assert.equal(resets,0);
  }
  usage.connect=async()=>true;
  assert.equal(await handlers.get('workspace:signin')(trusted),true);
  assert.equal(resets,1);
  assert.equal(focused,5,'Success, cancellation and failure all return focus to VibeDeck');
  usage.connect=async(_win,destination)=>{assert.equal(destination,'connectors');return true;};
  assert.equal(await handlers.get('workspace:connectors')(trusted),true);
  assert.equal(resets,2);
  usage.connect=async(_win,destination)=>{assert.equal(destination,'admin');return true;};
  assert.equal(await handlers.get('workspace:signin')(trusted,'admin'),true);
  assert.equal(resets,3);
  for (const factor of [0,2,NaN,Infinity,"1",null]) await assert.rejects(handlers.get("window:set-zoom")(trusted,factor),/Invalid zoom/);
  assert.equal(handlers.get("window:get-zoom")(trusted),1);

});
