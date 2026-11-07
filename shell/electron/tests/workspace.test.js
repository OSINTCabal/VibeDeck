const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
function harness() {
  const views = [], events = [], jar = [], downloads = [], external = [];
  const ses = Object.assign(new EventEmitter(), { cookies: { get: async () => jar, set: async c => jar.push(c), flushStore: async () => {} },
    clearStorageData: async () => { jar.length = 0; }, clearCache: async () => {},
    webRequest: { onBeforeRequest: fn => { ses.request = fn; } },
    setPermissionCheckHandler(fn) { this.checkPermission = fn; }, setPermissionRequestHandler(fn) { this.requestPermission = fn; } });
  class View {
    constructor(options) {
      this.options = options;
      const w = this.webContents = new EventEmitter();
      w.focus = () => {};
      w.isDestroyed = () => !!w.destroyed;
      w.close = () => { w.destroyed = true; };
      w.loadURL = async url => { w.url = url; w.emit('did-finish-load'); };
      w.setZoomFactor = factor => {w.zoom=factor;};
      w.getURL = () => w.url;
      w.setWindowOpenHandler = fn => { w.popup = fn; };
      w.executeJavaScript = async code => { if (code.includes('link.download')) downloads.push(code); return true; };
      views.push(this);
    }
    setBounds(rect) { this.rect = rect; }
    setBackgroundColor(color) { this.background = color; }
    setVisible(visible) { this.visible = visible; }
  }
  const win = { isDestroyed: () => false, getContentSize: () => [1000,700],
    webContents: { getZoomFactor: () => 1, focus() {}, send: (...args) => events.push(args) }, contentView: { addChildView() {}, removeChildView() {} } };
  const browser = { workspaceCookies: async () => [] };
  const m = { exports: {} };
  new Function('require', 'module', fs.readFileSync(require.resolve('../workspace'), 'utf8'))(name =>
    name === 'electron' ? { WebContentsView: View, nativeTheme: {}, session: { fromPartition: () => ses }, dialog: { showMessageBox: async () => ({response:1}) }, shell: { openExternal: async url => external.push(url) } } :
    name === './usage-browser' ? browser : name === 'node:dns/promises' ? { lookup: async () => [{address:'1.1.1.1',family:4}] } : require(name), m);
  return { ...m.exports, controller: m.exports.createWorkspace(() => win), views, events, browser, ses, jar, downloads, external, win };
}
const rectangle = { x: 0, y: 96, width: 1000, height: 604 };
test('workspace section follows full and in-page navigation without losing Instructions', async () => {
  const h = harness();
  await h.controller.open('skills', rectangle);
  const w = h.views[0].webContents;
  await w.loadURL('https://chat.mistral.ai/connections');
  assert.equal(h.events.at(-1)[1].section, 'connectors');
  w.url = 'https://chat.mistral.ai/libraries/library-id';
  w.emit('did-navigate-in-page', {}, w.url, true);
  assert.equal(h.events.at(-1)[1].section, 'libraries');
  w.emit('did-navigate-in-page', {}, 'https://chat.mistral.ai/connections', false);
  assert.equal(h.events.at(-1)[1].section, 'libraries');
  await h.controller.open('instructions', rectangle);
  assert.equal(h.events.at(-1)[1].section, 'instructions');
  h.controller.close();
  w.emit('did-navigate-in-page', {}, 'https://chat.mistral.ai/connections', true);
  assert.equal(h.events.at(-1)[1].section, 'instructions');
});
test('workspace requests reject local networks, credentials and unsafe schemes without blocking public IPs', async () => {
  const { publicRequest } = harness();
  for (const url of ['http://1.1.1.1', 'file:///etc/passwd', 'https://user:pass@example.com',
    'https://127.0.0.1', 'https://10.1.2.3', 'https://192.168.1.1', 'https://169.254.169.254',
    'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:1.1.1.1]', 'https://[fc00::1]']) assert.equal(await publicRequest(url), false, url);
  for (const url of ['https://1.1.1.1', 'https://[2606:4700:4700::1111]', 'wss://1.1.1.1', 'data:text/plain,ok']) assert.equal(await publicRequest(url), true, url);
  assert.equal(await publicRequest('https://example.com', async () => [{address:'127.0.0.1',family:4}]), false);
  assert.equal(await publicRequest('https://example.com', async () => []), false);
  assert.equal(await publicRequest('https://example.com', async () => { throw new Error('DNS'); }), false);
});
test('cookie import accepts only secure Mistral cookies and preserves scope', () => {
  const { cookieDetails } = harness();
  const c = {name:'session', value:'fixture', domain:'chat.mistral.ai', secure:true, httpOnly:true, path:'/', sameSite:'Lax', expires:100};
  assert.deepEqual(cookieDetails(c), {url:'https://chat.mistral.ai/',name:'session',value:'fixture',path:'/',secure:true,httpOnly:true,sameSite:'lax',expirationDate:100});
  assert.equal(cookieDetails({...c, domain:'.mistral.ai'}).domain, '.mistral.ai');
  for (const domain of ['google.com','.accounts.google.com','mistral.ai.evil.test','evil.mistral.ai']) assert.equal(cookieDetails({...c,domain}), null);
  assert.equal(cookieDetails({...c,secure:false}), null);
  assert.equal(cookieDetails({...c,partitionKey:{}}), null);
});
test('workspace bounds protect desktop toolbar and stay inside window', () => {
  const { bounds } = harness();
  assert.deepEqual(bounds({x:-10,y:0,width:2000,height:2000},[1000,700]),{x:0,y:40,width:1000,height:660});
  assert.throws(() => bounds({...rectangle,width:NaN},[1000,700]), /Invalid/);
});
test('isolated views close on navigation and credentials cannot bypass cached origins', async () => {
  const h = harness();
  await h.controller.open('knowledge',rectangle);
  assert.equal(h.views[0].webContents.url,'https://chat.mistral.ai/knowledge');
  assert.deepEqual(h.views[0].options.webPreferences,{session:h.ses,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true});
  const request = url => new Promise(resolve => h.ses.request({url},resolve));
  assert.deepEqual(await request('https://chat.mistral.ai/'),{cancel:false});
  assert.deepEqual(await request('https://user:pass@chat.mistral.ai/'),{cancel:true});
  await h.controller.open('scheduled',rectangle);
  assert.equal(h.views[0].webContents.destroyed,true);
  assert.equal(h.views[1].webContents.url,'https://chat.mistral.ai/tasks');
  h.controller.close(); assert.equal(h.views[1].webContents.destroyed,true);
  await assert.rejects(h.controller.open('invalid',rectangle), /Unknown/);
  await assert.rejects(h.controller.open('work',rectangle,'invalid'), /theme/);
});
test('sign out drains an in-flight cookie write before clearing authentication', async () => {
  const h = harness(); let finish;
  h.browser.workspaceCookies = async () => [{name:'s',value:'fixture',domain:'chat.mistral.ai',secure:true}];
  h.ses.cookies.set = c => new Promise(resolve => { finish = () => {h.jar.push(c);resolve();}; });
  const opening = h.controller.open('knowledge',rectangle);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const resetting = h.controller.reset();
  finish(); await Promise.all([opening,resetting]);
  assert.deepEqual(h.jar,[]); assert.equal(h.views.length,0);
  h.browser.workspaceCookies = async () => [];
  await h.controller.open('knowledge',rectangle);
  assert.equal(h.views.length,1);
});

test('workspace permissions honor explicit grants, reject foreign origins and reset on sign out', async () => {
  const h = harness(); await h.controller.open('knowledge',rectangle);
  const w=h.views[0].webContents;
  assert.equal(h.ses.checkPermission(w,'media','https://chat.mistral.ai'),false);
  const request = origin => new Promise(resolve => h.ses.requestPermission(w,'media',resolve,{requestingUrl:origin}));
  assert.equal(await request('https://other.example/'),false);
  assert.equal(await request('https://chat.mistral.ai/knowledge'),true);
  assert.equal(h.ses.checkPermission(w,'media','https://chat.mistral.ai'),true);
  await h.controller.reset();
  assert.equal(h.ses.checkPermission(w,'media','https://chat.mistral.ai'),false);
});

test('one imported Mistral session serves every page, unrelated cookies do not suppress sign-in', async () => {
  const h=harness(); let imports=0;
  h.jar.push({name:'__cf_bm',secure:true,httpOnly:true});
  h.browser.workspaceCookies=async()=>{imports++;return [{name:'ory_session_fixture',value:'test',secure:true,httpOnly:true,domain:'.mistral.ai'}];};
  for(const section of ['knowledge','skills','connectors','libraries','instructions','scheduled','knowledge']) {
    await h.controller.open(section,rectangle);
    assert.equal(h.views.at(-1).webContents.url,'https://chat.mistral.ai'+h.ROUTES[section]);
  }
  assert.equal(imports,1,'Page navigation reuses the imported session without another browser read or refresh');
});

test('workspace blob exports download within their session and unsafe popup schemes stay blocked', async () => {
  const h = harness(); await h.controller.open('libraries', rectangle);
  const w = h.views[0].webContents;
  const blob = 'blob:https://chat.mistral.ai/export-fixture';
  assert.deepEqual(w.popup({url:blob}), {action:'deny'});
  assert.equal(h.downloads.length, 1);
  assert.ok(h.downloads[0].includes(JSON.stringify(blob)));
  for (const url of ['blob:https://other.example/file', 'data:text/html,fixture', 'file:///tmp/file', 'javascript:alert(1)', 'https://127.0.0.1/']) w.popup({url});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.external, []);
  w.popup({url:'https://console.mistral.ai/'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.external, ['https://console.mistral.ai/']);
});
test('downloads report completion/failure and reject unrelated contents', async () => {
  const h = harness(); await h.controller.open('libraries', rectangle);
  const w = h.views[0].webContents;
  for (const [state, status] of [['completed','ready'], ['interrupted','error']]) {
    const item = new EventEmitter();
    h.ses.emit('will-download', {preventDefault(){assert.fail('valid download blocked');}}, item, w);
    item.emit('done', {}, state);
    assert.equal(h.events.at(-1)[1].status,status);
  }
  let blocked=false;
  h.ses.emit('will-download', {preventDefault(){blocked=true;}}, new EventEmitter(), {});
  assert.equal(blocked,true);
  const item=new EventEmitter();
  h.ses.emit('will-download', {}, item, w);
  h.controller.close(); const before=h.events.length;
  item.emit('done', {}, 'completed');
  assert.equal(h.events.length,before);
});
test('clipboard reads require consent from the active Mistral page', async () => {
  const h=harness(); await h.controller.open('instructions',rectangle);
  const w=h.views[0].webContents;
  assert.equal(h.ses.checkPermission(w,'clipboard-read','https://chat.mistral.ai'),false);
  const request = origin => new Promise(resolve => h.ses.requestPermission(w,'clipboard-read',resolve,{requestingUrl:origin}));
  assert.equal(await request('https://other.example/'),false);
  assert.equal(await request('https://chat.mistral.ai/work'),true);
  await h.controller.reset();
  assert.equal(h.ses.checkPermission(w,'clipboard-read','https://chat.mistral.ai'),false);
});

test('workspace stays behind its loading screen until the remote page is ready', async () => {
  const h=harness();
  let finish;
  h.browser.workspaceCookies=async()=>[];
  const original=h.views;
  // Delay loadURL after the view is constructed by intercepting attachment.
  h.win.contentView.addChildView = view => {
    view.webContents.loadURL = url => new Promise(resolve => {view.webContents.url=url;finish=resolve;});
  };
  const opening=h.controller.open('knowledge',rectangle);
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(original[0].visible,false);
  assert.equal(original[0].background,'#19191b');
  finish();await opening;
  assert.equal(original[0].visible,true);
});

test('failed workspace load leaves a visible desktop error instead of an empty remote view', async () => {
  const h=harness();
  h.win.contentView.addChildView=view=>{view.webContents.loadURL=async()=>{throw new Error('offline');};};
  await h.controller.open('knowledge',rectangle,'light');
  assert.equal(h.views[0].visible,false);
  assert.equal(h.views[0].background,'#faf8f3');
  assert.equal(h.events.at(-1)[1].status,'error');
});


test('connector OAuth redirects and popups expose browser handoff', async () => {
  const h=harness(); await h.controller.open('connectors',rectangle);
  const w=h.views[0].webContents;
  for (const url of ['https://accounts.google.com/o/oauth2/auth','https://github.com/login/oauth/authorize']) {
    assert.deepEqual(w.popup({url}),{action:'deny'});
    assert.equal(h.events.at(-1)[1].status,'connector-auth');
    let blocked=false;
    w.emit('will-navigate',{preventDefault(){blocked=true;}},url);
    assert.equal(blocked,true);
    assert.equal(h.events.at(-1)[1].status,'connector-auth');
  }
  assert.deepEqual(h.external,[],'OAuth requests must not open in an unrelated browser profile');
});


test('stalled workspace navigation stops and shows recovery instead of loading forever', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  const h=harness(); let stopped=false;
  h.win.contentView.addChildView=view=>{
    view.webContents.loadURL=()=>new Promise(()=>{});
    view.webContents.stop=()=>{stopped=true;};
  };
  const opening=h.controller.open('connectors',rectangle);
  while (!h.views.length) await new Promise(resolve=>setImmediate(resolve));
  context.mock.timers.tick(30001);
  await opening;
  assert.equal(stopped,true);
  assert.equal(h.events.at(-1)[1].status,'error');
  assert.equal(h.views[0].visible,false);
});


test('Docs stays anonymous while Admin imports only its scoped Mistral login', async () => {
  const h=harness(); let imports=0;
  h.browser.workspaceCookies=async(_base,destination)=>{
    imports++;
    assert.equal(destination,'admin');
    return ['admin.mistral.ai','chat.mistral.ai','accounts.google.com'].map(domain=>({domain,name:'ory_session_fixture',value:'fixture',secure:true,httpOnly:true}));
  };
  await h.controller.open('docs',rectangle);
  assert.equal(h.views.at(-1).webContents.url,'https://docs.mistral.ai/');
  assert.equal(imports,0);
  await h.controller.open('admin',rectangle);
  assert.equal(h.views.at(-1).webContents.url,'https://admin.mistral.ai/');
  assert.equal(imports,1);
  assert.deepEqual(h.jar.map(cookie=>cookie.url),['https://admin.mistral.ai/']);
  await h.controller.refresh();
  assert.equal(imports,1,'Admin reuses its persistent session');
  h.views.at(-1).webContents.popup({url:'https://docs.mistral.ai/api'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.views.at(-1).webContents.url,'https://docs.mistral.ai/api');
  await h.controller.refresh();
  assert.equal(h.views.at(-1).webContents.url,'https://docs.mistral.ai/api','Refresh stays on the current embedded URL');
});

test('Admin auth callback stays in its partition and expired flows refresh from Admin', async () => {
  const h=harness();
  await h.controller.open('admin',rectangle);
  const w=h.views[0].webContents;
  w.url='https://auth.mistral.ai/self-service/login/browser?flow=expired';
  w.emit('did-navigate',{},w.url);
  assert.equal(h.events.at(-1)[1].status,'signin');
  assert.match(h.events.at(-1)[1].detail,/Chrome/);
  w.emit('will-redirect',{preventDefault(){assert.fail('Admin callback recreated its view');}},'https://admin.mistral.ai/subscription');
  assert.equal(h.views.length,1);
  assert.deepEqual(w.popup({url:'https://accounts.google.com/o/oauth2/auth'}),{action:'deny'});
  assert.deepEqual(w.popup({url:'https://auth.mistral.ai/self-service/login/browser'}),{action:'deny'});
  assert.deepEqual(h.external,[],'Google must use the app-owned normal browser');
  await h.controller.refresh();
  assert.equal(h.views.at(-1).webContents.url,'https://admin.mistral.ai/');
  assert.equal(w.destroyed,true);
  await h.controller.reset();
  assert.deepEqual(h.jar,[]);
});

test('zoom scales CSS bounds to physical window coordinates', () => {
  const h=harness();
  assert.deepEqual(h.bounds({x:0,y:40,width:800,height:520},[1000,700],1.25),{x:0,y:50,width:1000,height:650});
});
