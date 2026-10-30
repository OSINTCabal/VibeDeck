const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

test('one focus refresh coalesces picker requests and stale responses cannot restore caches', async () => {
  const effects = [], updates = [], config = [], agents = [];
  const previous = global.window;
  global.window = new EventTarget();
  const react = { useState: value => [value, next => updates.push(next)], useEffect: fn => effects.push(fn) };
  const api = {
    getConfig: () => new Promise(resolve => config.push(resolve)),
    getAgents: () => new Promise(resolve => agents.push(resolve)),
  };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/Pickers.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'exports', code)(id => id === 'react' ? react : id === '@/lib/api' ? api : id === '@/lib/utils' ? {} : id === './ModelIcon' ? {} : require(id), exports);
  const cleanups = [];
  const mount = hook => { hook(); cleanups.push(effects.shift()()); };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    mount(exports.useVibeModels); mount(exports.useVibeModels);
    mount(exports.useAgents); mount(exports.useAgents);
    assert.equal(config.length, 1); assert.equal(agents.length, 1);
    window.dispatchEvent(new Event('focus'));
    assert.equal(config.length, 2); assert.equal(agents.length, 2);
    config[0]({ vibeModels: [{ id: 'old' }] }); agents[0]({ agents: [{ name: 'old' }] });
    await tick();
    assert.ok(!updates.some(value => Array.isArray(value) && value.some(item => item.id === 'old' || item.name === 'old')));
    mount(exports.useVibeModels); mount(exports.useAgents);
    assert.equal(config.length, 2); assert.equal(agents.length, 2);
    config[1]({ vibeModels: [{ id: 'fresh', name: 'Fresh' }] }); agents[1]({ agents: [{ name: 'fresh' }] });
    await tick();
    assert.ok(updates.some(value => Array.isArray(value) && value.some(item => item.id === 'fresh')));
    assert.ok(updates.some(value => Array.isArray(value) && value.some(item => item.name === 'fresh')));
    mount(exports.useVibeModels); mount(exports.useAgents);
    assert.equal(config.length, 2); assert.equal(agents.length, 2);
    cleanups.splice(0).forEach(cleanup => cleanup());
    window.dispatchEvent(new Event('focus'));
    assert.equal(config.length, 2); assert.equal(agents.length, 2);
  } finally { cleanups.forEach(cleanup => cleanup()); global.window = previous; }
});
