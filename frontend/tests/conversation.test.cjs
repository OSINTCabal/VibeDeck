const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const path = require('node:path');
function load(file, overrides = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', code)(id => overrides[id] || require(id), exports);
  return exports;
}
const api = load('lib/api.ts');
const { conversationEvent, initialConversation } = load('hooks/useConversation.ts', { '@/lib/api': api });
const entry = (id, text = '') => ({ id, type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
const snapshot = (history, extra = {}) => ({ kind: 'snapshot', lastEventId: 3, session: { status: { type: 'idle' } }, history, activeCallbacks: [], ...extra });

test('fresh snapshot repairs missed entries and retains loaded older pages', () => {
  let s = conversationEvent(initialConversation(), snapshot([entry('b'), entry('c', 'partial')]));
  s.entries.unshift(entry('a'));
  s = conversationEvent(s, snapshot([entry('b'), entry('c', 'complete'), entry('d')], { lastEventId: 9 }));
  assert.deepEqual(s.entries.map(e => e.id), ['a', 'b', 'c', 'd']);
  assert.equal(s.entries[2].content[0].text, 'complete');
  assert.equal(conversationEvent(s, { kind: 'entry', action: 'add', entry: entry('old'), lastEventId: 8 }), s);
});
test('snapshot recovers blocked turn, callbacks and children; completed turn clears ID', () => {
  const cb = { id: 'cb', type: 'callback', state: { status: 'open' } };
  let s = conversationEvent(initialConversation(), snapshot([], { session: { status: { type: 'blocked', activeTurnId: 't' } }, activeCallbacks: [cb], childSessions: [{ id: 'child' }] }));
  assert.equal(s.activeTurnId, 't');
  assert.equal(s.turnStatus, 'running');
  assert.equal(s.pendingCallbacks[0].id, 'cb');
  assert.equal(s.entries[0].id, 'cb');
  assert.ok(s.childSessions.child);
  s = conversationEvent(s, { kind: 'entry', action: 'update', entryId: 'cb', patch: [{ op: 'replace', path: '/state/status', value: 'answered' }] });
  assert.equal(s.pendingCallbacks.length, 0);
  s = conversationEvent(s, { kind: 'turn', status: 'completed', turn: { id: 't' } });
  assert.equal(s.activeTurnId, null);
});
test('JSON patch supports arrays, escaped keys, root replacement and blocks prototype writes', () => {
  const value = { content: [{ text: 'A' }], 'a/b': { '~key': 1 } };
  api.applyPatch(value, [{ op: 'append', path: '/content/0/text', value: 'B' }, { op: 'add', path: '/content/0', value: { text: 'first' } }, { op: 'replace', path: '/a~1b/~0key', value: 2 }, { op: 'add', path: '/__proto__/polluted', value: true }]);
  assert.equal(value.content[1].text, 'AB');
  assert.equal(value['a/b']['~key'], 2);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(api.applyPatch(value, [{ op: 'replace', path: '', value: { root: true } }]), { root: true });
});
test('stream preserves prior messages and parses split CRLF with separate thinking/text', async () => {
  const originalFetch = global.fetch;
  const chunks = ['data: {"stream":"think","delta":"hmm"}\r', '\n\r\ndata: {"stream":"text","delta":"hi"}\r\n\r\ndata: [DONE]\r\n\r\n'];
  let body;
  global.fetch = async (_, init) => { body = JSON.parse(init.body); return new Response(new ReadableStream({ start(c) { chunks.forEach(s => c.enqueue(new TextEncoder().encode(s))); c.close(); } })); };
  const deltas = [];
  try {
    await new Promise((resolve, reject) => api.streamChat({ message: 'next', messages: [{ role: 'user', content: 'earlier' }] }, { onDelta: (...d) => deltas.push(d), onDone: resolve, onError: reject }));
    assert.equal(body.messages[0].content, 'earlier');
    assert.deepEqual(deltas, [['think', 'hmm'], ['text', 'hi']]);
  } finally { global.fetch = originalFetch; }
});
test('sendTurn sends text, images, and the caller-provided requestId unchanged', async () => {
  // The Welcome page's retry logic relies on sendTurn passing the requestId we hand it
  // through to the request body verbatim — that's how the backend deduplicates retries
  // whose only change is configuration (model/agent), not content.
  const originalFetch = global.fetch;
  const bodies = [];
  global.fetch = async (_, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
  try {
    await api.sendTurn('s-1', 'hi', [{ source: { kind: 'inline', data: 'AAA' }, alias: 'a', mimeType: 'image/png' }], 'rid-stable-42');
    await api.sendTurn('s-1', 'hi', [{ source: { kind: 'inline', data: 'AAA' }, alias: 'a', mimeType: 'image/png' }], 'rid-stable-42');
    assert.equal(bodies.length, 2);
    for (const b of bodies) {
      assert.equal(b.requestId, 'rid-stable-42');
      assert.equal(b.text, 'hi');
      assert.equal(b.images[0].alias, 'a');
      assert.equal(b.images[0].source.data, 'AAA');
      assert.equal(b.images[0].source.kind, 'inline');
      assert.equal(b.images[0].mimeType, 'image/png');
    }
  } finally { global.fetch = originalFetch; }
});
test('getMcp propagates a server error so the view can render an error+Retry banner', async () => {
  // McpView renders an alert with Retry only when getMcp rejects. A 500 with a
  // JSON body must surface a non-empty error message.
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ detail: 'upstream timeout' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(api.getMcp(), /upstream timeout/);
  } finally { global.fetch = originalFetch; }
});

test('conversation flushes suspended frames, hidden approvals and bounded bursts; cleanup isolates old sessions', () => {
  const previous = Object.fromEntries(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'].map(k => [k, global[k]]));
  const effects = [], frames = new Map(), timers = new Map();
  let state, receive, serial = 0, stopped = 0;
  global.window = new EventTarget();
  global.document = Object.assign(new EventTarget(), { hidden: false });
  global.requestAnimationFrame = fn => { frames.set(++serial, fn); return serial; };
  global.cancelAnimationFrame = id => frames.delete(id);
  global.setTimeout = fn => { timers.set(++serial, fn); return serial; };
  global.clearTimeout = id => timers.delete(id);
  const react = {
    useState: initial => { state = initial(); return [state, update => { state = typeof update === 'function' ? update(state) : update; }]; },
    useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => effects.push(fn),
  };
  let cleanup;
  try {
    const hooks = load('hooks/useConversation.ts', { react, '@/lib/api': {
      ...api, openSessionEvents: (_, callback) => { receive = callback; return () => stopped++; },
    } });
    hooks.useConversation('first');
    cleanup = effects.shift()();
    receive(snapshot([], { session: { status: { type: 'running', activeTurnId: 'turn' } } }));
    assert.equal(state.loading, true);
    const fallback = [...timers.values()][0];
    fallback();
    assert.equal(state.turnStatus, 'running');
    assert.equal(frames.size, 0);
    receive({ kind: 'stats', stats: { marker: 'visible-frame' } });
    [...frames.values()][0]();
    assert.equal(state.stats.marker, 'visible-frame');
    receive({ kind: 'entry', action: 'add', entry: entry('before-hidden') });
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(state.entries[0].id, 'before-hidden');
    receive({ kind: 'callback', callback: { id: 'approval', type: 'callback', state: { status: 'open' } } });
    assert.equal(state.pendingCallbacks.length, 1);
    receive({ kind: 'turn', status: 'completed', turn: { id: 'turn' } });
    assert.equal(state.turnStatus, 'completed');
    assert.equal(frames.size + timers.size, 0);
    document.hidden = false;
    for (let i = 0; i < 128; i++) receive({ kind: 'entry', action: 'add', entry: entry('burst-' + i) });
    assert.equal(state.entries.length, 130);
    receive({ kind: 'entry', action: 'add', entry: entry('discard-on-close') });
    const stale = [...timers.values()][0];
    cleanup(); cleanup = null;
    stale(); receive({ kind: 'entry', action: 'add', entry: entry('after-close') });
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(state.entries.length, 130);
    assert.equal(frames.size + timers.size, 0);
    assert.equal(stopped, 1);
  } finally {
    cleanup?.();
    Object.assign(global, previous);
  }
});
