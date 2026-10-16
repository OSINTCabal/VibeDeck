const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

for (const failure of ['shutdown', 'remove']) {
  test(`disconnect ${failure} failure preserves its error and allows another sign-in`, async () => {
    const module = { exports: {} };
    let removed = false;
    const fakeFS = { rm: async () => { if (failure === 'remove') throw new Error('fixture remove failure'); removed = true; } };
    const source = fs.readFileSync(require.resolve('../usage-browser'), 'utf8') + `
      stopBrowsers = async () => { if (${JSON.stringify(failure)} === 'shutdown') throw new Error('fixture shutdown failure'); };
      signIn = async () => true;
    `;
    new Function('require', 'module', source)(id => id === 'electron' ? { app: { getPath: () => '/tmp/vibedeck-browser-fixture' } } : id === 'node:fs/promises' ? fakeFS : require(id), module);
    await assert.rejects(module.exports.disconnect(), /fixture .* failure/);
    assert.equal(removed, false, 'A failed shutdown must not remove a live browser profile');
    assert.equal(await module.exports.connect(), true, 'quitting must reset even when cleanup fails');
  });
}
