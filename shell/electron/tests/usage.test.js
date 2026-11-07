async function connectAndConfirm(browser, accepted, destination) {
  const pending = browser.connect(undefined, destination);
  while (!browser.confirmSignIn(accepted)) await new Promise(resolve => setImmediate(resolve));
  return pending;
}
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { subscriptionBudgets, vibeAllowance, normalizeBilling } = require('../usage-data');
const budget = { budget: { vibe_budget: { usage_percentage: 25, initial_budget: 100, currency: 'usd', reset_at: '2026-11-01T00:00:00Z' } } };
const html = records => `<script>self.__next_f.push(${JSON.stringify([1, records])})</script>`;

test('subscription parser handles chunked Flight data and ignores length-delimited text decoys', () => {
  const decoy = `9:${JSON.stringify({ budget: { ...budget.budget, vibe_budget: { ...budget.budget.vibe_budget, usage_percentage: 99 } } })}\n`;
  const text = `1:T${Buffer.byteLength(decoy).toString(16)},${decoy}2:${JSON.stringify(budget)}\n`;
  const split = Math.floor(text.length / 2);
  const [a] = subscriptionBudgets(html(text.slice(0, split)) + html(text.slice(split)));
  assert.equal(a.usedPercent, 25);
  assert.equal(a.remaining, 75);
  assert.equal(a.currency, 'USD');
  assert.deepEqual(subscriptionBudgets('<script>throw new Error("never evaluate")</script>'), []);
});
test('ambiguous subscription accounts fail closed', () => {
  const other = structuredClone(budget); other.budget.vibe_budget.usage_percentage = 40;
  assert.throws(() => subscriptionBudgets(html(`1:${JSON.stringify([budget, other])}\n`)), /Multiple subscription accounts/);
  assert.equal(vibeAllowance([{ result: { data: { json: { usage_percentage: -1 } } } }]), null);
});
test('billing uses price per unit and never invents a price from another tier', () => {
  const scope = { event_type: 'chat', billing_metric: 'tokens', billing_group: 'input', api_zone: 'eu', service_tier: 'standard' };
  const data = { start_date: '2026-10-01', currency: 'USD', completion: { models: { m: { input: [{ ...scope, value: 1000, value_paid: 800, timestamp: '2026-10-09' }] } } }, prices: [{ ...scope, price: '0.000002' }] };
  assert.ok(Math.abs(normalizeBilling(data).cost - .0016) < 1e-12);
  assert.equal(normalizeBilling(data).inputTokens, 1000);
  data.prices[0].api_zone = 'us';
  assert.equal(normalizeBilling(data).cost, null);
});
function harness() {
  const cookies = [{ name: 'ory_session_test', value: 'secret-cookie' }];
  const ses = { cookies: { get: async () => cookies }, clearStorageData: async () => { cookies.length = 0; }, clearCache: async () => {}, fetch: async url => {
    if (url.includes('/subscription')) return new Response(html(`1:${JSON.stringify(budget)}\n`));
    return new Response(JSON.stringify({ start_date: '2026-10-01', currency: 'USD', completion: { models: {} } }));
  } };
  const browser = { connect: async () => {}, available: async () => cookies.length > 0,
    disconnect: () => ses.clearStorageData(), read: async url => {
      const response = await ses.fetch(url);
      return { status: response.status, type: response.type, text: await response.text() };
    } };
  const moduleObject = { exports: {} };
  new Function('require', 'module', fs.readFileSync(require.resolve('../usage'), 'utf8'))(id => id === './usage-browser' ? browser : require('../usage-data'), moduleObject);
  return { usage: moduleObject.exports, ses };
}
test('usage reads coalesce, cache, and disconnect clears authenticated data', async () => {
  const { usage, ses } = harness();
  let requests = 0;
  const original = ses.fetch;
  ses.fetch = async (...args) => { requests++; return original(...args); };
  const [a, b] = await Promise.all([usage.read(2026, 10), usage.read(2026, 10)]);
  assert.deepEqual(a, b); assert.equal(requests, 2);
  assert.equal(a.allowances[0].usedPercent, 25);
  assert.ok(!JSON.stringify(a).includes('secret-cookie'));
  await usage.read(2026, 10, true); assert.equal(requests, 2);
  await usage.disconnect();
  assert.equal((await usage.read(2026, 10)).status, 'disconnected');
  assert.equal(requests, 2);
});
test('disconnect invalidates in-flight responses', async () => {
  const { usage, ses } = harness();
  const pending = [];
  ses.fetch = () => new Promise(resolve => { pending.push(resolve); });
  const read = usage.read(2026, 10);
  await new Promise(resolve => setImmediate(resolve));
  await usage.disconnect();
  pending.forEach(resolve => resolve(new Response(JSON.stringify({ start_date: '2026-10-01', completion: { models: {} } }))));
  assert.equal((await read).status, 'disconnected');
});

test('usage browser accepts only fixed Mistral readers and handles a closed profile', async () => {
  const moduleObject = { exports: {} };
  new Function('require', 'module', fs.readFileSync(require.resolve('../usage-browser'), 'utf8'))(
    id => id === 'electron' ? { app: { getPath: () => '/nonexistent-vibedeck-test-profile' } } : require(id), moduleObject);
  const browser = moduleObject.exports;
  assert.equal(browser.allowedRequest('https://admin.mistral.ai/subscription'), true);
  assert.equal(browser.allowedRequest('https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?batch=1'), true);
  for (const url of ['https://admin.mistral.ai.evil.example/subscription', 'file:///etc/passwd',
    'http://admin.mistral.ai/subscription', 'https://admin.mistral.ai/api/delete-account']) {
    assert.equal(browser.allowedRequest(url), false);
    await assert.rejects(browser.read(url), /Untrusted/);
  }
  assert.equal(await browser.available(), false);
  assert.equal(await browser.read('https://admin.mistral.ai/subscription'), null);
});

test('Google sign-in opens normal Chrome with no debugging or automation flags', async () => {
  const launches = [];
  const moduleObject = { exports: {} };
  const child = { once() {}, unref() {}, exitCode: null, signalCode: null, kill() {this.exitCode=0;} };
  new Function('require', 'module', fs.readFileSync(require.resolve('../usage-browser'), 'utf8'))(id => {
    if (id === 'electron') return { app: { getPath: () => '/test-profile' }, dialog: { showMessageBox: async () => ({ response: 1 }) } };
    if (id === 'node:fs/promises') return { readFile: async () => { throw new Error('not running'); }, access: async name => { if (name.endsWith('.vibedeck-connected')) throw Object.assign(new Error('absent'), {code:'ENOENT'}); }, mkdir: async () => {}, chmod: async () => {} };
    if (id === 'node:child_process') return { spawn: (_executable, args) => { launches.push(args); return child; } };
    return require(id);
  }, moduleObject);
  assert.deepEqual(await moduleObject.exports.account(),{remembered:false});
  assert.equal(launches.length,0,'Account status never starts a browser or fetches billing');
  await connectAndConfirm(moduleObject.exports, false);
  await connectAndConfirm(moduleObject.exports, false);
  assert.equal(launches.length, 1, 'Cancelled sign-in reuses its existing browser');
  assert.ok(launches[0].includes('https://chat.mistral.ai/work'));
  assert.ok(launches[0].includes('--no-first-run'),'Suppress Chrome onboarding during browser sign-in');
  assert.ok(launches[0].includes('--no-default-browser-check'));
  assert.ok(!launches[0].some(arg => /debug|automation|headless/.test(arg)));
  await connectAndConfirm(moduleObject.exports, false, 'connectors');
  assert.ok(launches.at(-1).includes('https://chat.mistral.ai/connections'));
  assert.ok(!launches.at(-1).some(arg=>/debug|automation|headless/.test(arg)));
  await connectAndConfirm(moduleObject.exports, false, 'admin');
  assert.ok(launches.at(-1).includes('https://admin.mistral.ai/'));
  assert.ok(!launches.at(-1).some(arg=>/debug|automation|headless/.test(arg)));
  await assert.rejects(moduleObject.exports.connect(undefined,'https://evil.test'), /Invalid/);
  const pending = moduleObject.exports.connect();
  await new Promise(resolve => setImmediate(resolve));
  await moduleObject.exports.shutdown();
  assert.equal(await pending,false,'Closing the app cancels a pending confirmation instead of hanging');
  assert.equal(moduleObject.exports.confirmSignIn(true),false,'A finished confirmation cannot be replayed');
});

test('expired sign-in never reuses an authenticated allowance', async () => {
  const { usage, ses } = harness();
  ses.fetch = async () => new Response('', { status: 401 });
  const result = await usage.read(2026, 10);
  assert.equal(result.status, 'expired');
  assert.deepEqual(result.allowances, []);
  assert.equal(result.billing, null);
});

for (const status of [401, 403]) {
  test(`optional console HTTP ${status} preserves authenticated admin usage`, async () => {
    const { usage, ses } = harness();
    const sibling = { budget: { api_budget: budget.budget.vibe_budget } };
    const fetch = ses.fetch;
    ses.fetch = url => url.startsWith('https://console.mistral.ai/')
      ? Promise.resolve(new Response('', { status }))
      : url.endsWith('/subscription')
        ? Promise.resolve(new Response(html(`1:${JSON.stringify(sibling)}\n`))) : fetch(url);
    const result = await usage.read(2026, 10);
    assert.equal(result.status, 'ready');
    assert.equal(result.allowances.length, 1);
    assert.equal(result.allowances[0].usedPercent, 25);
    assert.equal(result.billing.status, 'ready');
  });
}

test('billing permission failure does not expire a valid subscription', async () => {
  const { usage, ses } = harness();
  const fetch = ses.fetch;
  ses.fetch = url => url.includes('/api/billing/') ? Promise.resolve(new Response('', { status: 403 })) : fetch(url);
  const result = await usage.read(2026, 10);
  assert.equal(result.status, 'partial');
  assert.equal(result.allowances[0].usedPercent, 25);
  assert.match(result.detail, /HTTP 403/);
});

test('partial failures retain the last allowance with a stale label', async () => {
  const { usage, ses } = harness();
  const first = await usage.read(2026, 10);
  const realNow = Date.now;
  const fetch = ses.fetch;
  Date.now = () => realNow() + 301000;
  ses.fetch = url => url.endsWith('/subscription') ? Promise.reject(new Error('offline')) : fetch(url);
  try {
    const result = await usage.read(2026, 10);
    assert.equal(result.status, 'stale');
    assert.deepEqual(result.allowances, first.allowances);
    assert.equal(result.measuredAt, first.measuredAt);
    assert.equal(result.billing.status, 'ready');
  } finally { Date.now = realNow; }
});

test('reader resumes a remembered profile, recovers lost pages, and shutdown retains sign-in', async () => {
  const launches = [], commands = [], files = new Map([['.vibedeck-connected', '1']]);
  let running = false, targets = [], closed = 0, loginResponse = 1, sessionCookie = false, ready = true, closeWithoutAck = false;
  const fakeFs = {
    readFile: async name => {
      if (name.endsWith('DevToolsActivePort') && running) return '9222\n/devtools/browser/owned';
      throw new Error('absent');
    },
    access: async name => { if (name.endsWith('.vibedeck-connected') && !files.has('.vibedeck-connected')) throw Object.assign(new Error('absent'), {code:'ENOENT'}); },
    rm: async (name, options) => { if (options.recursive) files.clear(); },
    mkdir: async () => {}, chmod: async () => {},
    writeFile: async () => files.set('.vibedeck-connected', '1'),
  };
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(message) {
      const { method, params } = JSON.parse(message); commands.push(method);
      let result = {};
      if (method === 'Browser.close') { running = false; closed++; if (closeWithoutAck) {this.close();return;} }
      if (method === 'Network.getCookies') {
        assert.ok(['https://chat.mistral.ai/','https://admin.mistral.ai/'].includes(params.urls[0]));
        assert.deepEqual(params.urls.slice(1), ['https://auth.mistral.ai/', 'https://v2.auth.mistral.ai/']);
        result = {cookies:[...(sessionCookie ? [{domain:'.mistral.ai',name:'ory_session_fixture',value:'test',secure:true,httpOnly:true,expires:Date.now()/1000+60}] : []), {domain:'.mistral.ai',name:'fixture',value:'test'}, {domain:'.google.com',name:'excluded',value:'test'}, {domain:'admin.mistral.ai',name:'admin_only',value:'test'}, {domain:'chat.mistral.ai',name:'work_only',value:'test'}]};
      }
      if (method === 'Target.closeTarget') targets = targets.filter(t => t.id !== params.targetId);
      if (method === 'Target.createTarget') { targets.push({ id: 'owned', type: 'page', url: params.url }); result = { targetId: 'owned' }; }
      if (method === 'Runtime.evaluate') result = { result: { value: params.expression.startsWith('location.origin') ? ready : { status: 200, type: 'basic', text: '{}' } } };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const fakeFetch = async url => ({ json: async () => url.endsWith('/json/version')
    ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/owned' } : targets });
  const moduleObject = { exports: {} };
  new Function('require', 'module', 'fetch', 'WebSocket', fs.readFileSync(require.resolve('../usage-browser'), 'utf8'))(id => {
    if (id === 'electron') return { app: { getPath: () => '/test-profile' }, dialog: { showMessageBox: async () => ({ response: loginResponse }) } };
    if (id === 'node:fs/promises') return fakeFs;
    if (id === 'node:child_process') return { spawn: (_exe, args) => {
      launches.push(args); running = args.includes('--headless=new');
      return { once() {}, unref() {}, exitCode: null, signalCode: null, kill() { this.exitCode = 0; } };
    } };
    return require(id);
  }, moduleObject, fakeFetch, Socket);
  const browser = moduleObject.exports;
  assert.deepEqual(await Promise.all([browser.available(), browser.available()]), [true, true]);
  assert.equal(launches.length, 1, 'Parallel readers start only one Chrome');
  assert.ok(launches[0].includes('--headless=new'));
  assert.equal((await browser.read('https://admin.mistral.ai/subscription')).status, 200);
  assert.ok(commands.includes('Target.createTarget'), 'Closed/navigated tabs are recreated');
  const realNow = Date.now;
  let clock = realNow();
  ready = false;
  Date.now = () => (clock += 5000);
  try { await assert.rejects(browser.read('https://admin.mistral.ai/subscription'), /still loading/); }
  finally { Date.now = realNow; ready = true; }

  const workCookies = [{domain:'.mistral.ai',name:'fixture',value:'test'},{domain:'chat.mistral.ai',name:'work_only',value:'test'}];
  assert.deepEqual(await browser.workspaceCookies(), workCookies);
  assert.deepEqual(await browser.workspaceCookies(undefined,'admin'), [{domain:'.mistral.ai',name:'fixture',value:'test'},{domain:'admin.mistral.ai',name:'admin_only',value:'test'}]);
  await assert.rejects(browser.workspaceCookies(undefined,'https://evil.test'),/Invalid cookie destination/);
  targets = [];
  assert.deepEqual(await browser.workspaceCookies(), workCookies, 'Cookies remain available while startup tabs are absent');
  assert.equal(targets.length, 0, 'Temporary cookie reader tab is closed');
  running = false; targets = [];
  assert.equal(await browser.available(), true, 'Reader automatically recovers after closing');
  assert.equal(launches.length, 2);
  closeWithoutAck=true;
  assert.equal(await connectAndConfirm(browser, false), false, 'Manage-account cancellation is not a new sign-in');
  assert.equal(await browser.available(), true, 'Cancelling restores the remembered connection');
  loginResponse = 0;
  await assert.rejects(connectAndConfirm(browser, true), /sign-in was not completed/);
  sessionCookie = true;
  assert.equal(await connectAndConfirm(browser, true), true, 'Verified Google session connects both surfaces');
  assert.equal(await connectAndConfirm(browser, true, 'admin'), true, 'Admin completion checks its own scoped cookies');
  assert.ok(launches.at(-2).includes('https://admin.mistral.ai/'));
  await browser.shutdown();
  assert.equal(closed, 5);
  assert.ok(files.has('.vibedeck-connected'), 'Quitting retains the remembered account');
  const beforeStatus=launches.length;
  assert.deepEqual(await browser.account(),{remembered:true},'Saved connection survives app shutdown');
  assert.equal(launches.length,beforeStatus,'Checking the account does not start Chrome');
  assert.equal(await browser.available(), false, 'Shutdown never resurrects the reader');
  await browser.disconnect();
  assert.equal(files.size, 0, 'Explicit disconnect removes the owned profile');
  assert.deepEqual(await browser.account(),{remembered:false});
  assert.equal(await browser.available(), false);
});

test('usage refresh reports increased allowances without extra model requests', async () => {
  const { usage, ses } = harness();
  assert.equal((await usage.read(2026, 10)).allowances[0].usedPercent, 25);
  const realNow = Date.now;
  Date.now = () => realNow() + 11000;
  const oldFetch = ses.fetch;
  const increased = structuredClone(budget); increased.budget.vibe_budget.usage_percentage = 61;
  ses.fetch = url => url.endsWith('/subscription') ? Promise.resolve(new Response(html(`1:${JSON.stringify(increased)}\n`))) : oldFetch(url);
  try { assert.equal((await usage.read(2026, 10, true)).allowances[0].usedPercent, 61); }
  finally { Date.now = realNow; }
});
