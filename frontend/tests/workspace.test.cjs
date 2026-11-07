const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

test('queued workspace resize after unmount does not access the cleared ref or send IPC', () => {
  const effects = [];
  const ref = { current: { getBoundingClientRect: () => ({ x: 0, y: 50, width: 800, height: 600 }) } };
  let callback, resized = 0, closed = 0, disconnected = false;
  const desktop = {
    open: () => Promise.resolve(),
    resize: () => { resized++; return Promise.resolve(); },
    close: () => { closed++; return Promise.resolve(); },
    onState: () => () => {},
  };
  const react = { useEffect: fn => effects.push(fn), useRef: () => ref, useState: value => [value, () => {}] };
  const modules = {
    react, 'react-dom': {}, 'react-router-dom': { useNavigate: () => () => {}, useParams: () => ({ section: 'skills' }) },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '@/lib/theme': { getTheme: () => 'dark' },
  };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/views/WorkspaceView.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const Observer = class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } };
  new Function('require', 'exports', 'window', 'ResizeObserver', code)(id => modules[id] || {}, exports, { vibedeck: { workspace: desktop } }, Observer);
  exports.WorkspaceView();
  const cleanup = effects[1]();
  callback();
  assert.equal(resized, 1);
  cleanup();
  ref.current = null;
  assert.doesNotThrow(() => callback());
  assert.equal(resized, 1);
  assert.equal(closed, 1);
  assert.equal(disconnected, true);
});
