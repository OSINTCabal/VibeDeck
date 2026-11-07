// Opt-in real Electron + sidecar + CLI smoke check, driven by check_electron.py.
const assert = require('node:assert/strict');
const path = require('node:path');
const { _electron } = require(process.env.VIBEDECK_PLAYWRIGHT);
async function until(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const fs = require('node:fs');
  const bootstrap = path.join(process.env.VIBEDECK_TEST_HOME, 'electron-bootstrap.cjs');
  // Fixture protocol handlers serve these hosts; production DNS validation stays intact.
  fs.writeFileSync(bootstrap, `
    const dns = require('node:dns/promises');
    const hosts = new Set(['chat.mistral.ai', 'auth.mistral.ai', 'v2.auth.mistral.ai', 'docs.mistral.ai', 'admin.mistral.ai', 'console.mistral.ai', 'accounts.google.com']);
    dns.lookup = async (host, options) => {
      if (!hosts.has(host)) throw new Error('No DNS fixture for ' + host);
      const address = {address:'93.184.216.34',family:4};
      return options?.all ? [address] : address;
    };
    require(${JSON.stringify(path.join(root, 'shell/electron/main.js'))});
    global.fixtureBrowser = require(${JSON.stringify(path.join(root, 'shell/electron/usage-browser.js'))});
  `);
  const electron = await _electron.launch({
    executablePath: path.join(root, 'shell/electron/node_modules/electron/dist/electron'),
    args: [...(process.env.VIBEDECK_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), bootstrap, `--user-data-dir=${process.env.VIBEDECK_TEST_HOME}/electron`],
    env: process.env,
  });
  try {
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-vd-titlebar]').waitFor();
    await electron.evaluate(({ ipcMain }) => {
      let finish;
      ipcMain.removeHandler('usage:connect');
      ipcMain.removeHandler('usage:confirm-signin');
      ipcMain.handle('usage:connect', () => new Promise(resolve => {finish=resolve;}));
      ipcMain.handle('usage:confirm-signin', (_event,accepted) => {if(!finish)return false;finish(accepted);finish=null;return true;});
    });
    await page.getByRole('button', {name:'Sign in to Mistral',exact:true}).click();
    await page.getByRole('button', {name:'Cancel sign-in',exact:true}).click();
    await page.getByRole('heading', {name:'Welcome to VibeDeck',exact:true}).waitFor();
    await page.getByRole('button', {name:'Sign in to Mistral',exact:true}).click();
    await page.getByRole('button', {name:'I’ve signed in',exact:true}).click();
    await until(() => page.getByRole('dialog').count().then(count => count === 0), 'Completed sign-in left welcome dialog stuck');
    await page.goto(process.env.VIBEDECK_URL);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('usage:account');
      ipcMain.handle('usage:account', () => ({remembered:true}));
      ipcMain.removeHandler('usage:read');
      ipcMain.handle('usage:read', () => new Promise(() => {}));
    });
    await page.evaluate(() => localStorage.removeItem('vibedeck.mistral-welcome'));
    await page.reload();
    await page.locator('[data-vd-titlebar]').waitFor();
    assert.equal(await page.locator('dialog[open]').count(),0,'Remembered sign-in must not repeat onboarding');
    await page.getByRole('button', {name:'Account',exact:true}).click();
    await page.getByRole('navigation', {name:'Account menu'}).waitFor();
    await page.screenshot({path:path.join(process.env.VIBEDECK_ARTIFACTS,'electron-account-popup.png')});
    await page.getByRole('button', {name:'Mistral account',exact:true}).click();
    await page.getByRole('button', {name:'Switch Mistral account',exact:true}).waitFor();
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('usage:read');
      ipcMain.handle('usage:read', () => new Promise(() => {}));
    });
    await page.getByRole('button', {name:'Switch Mistral account',exact:true}).click();
    await page.getByRole('button', {name:'I’ve signed in',exact:true}).click();
    await until(() => page.locator('dialog[open]').count().then(count => count === 0), 'Sign-in waited for usage or left the account dialog open');

    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.vibedeck.usage.read), 'function');
    await page.getByRole('button', { name: 'Maximize', exact: true }).click();
    await until(async () => (await page.evaluate(() => window.vibedeck.getState())).maximized, 'Maximize failed');
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await until(async () => !(await page.evaluate(() => window.vibedeck.getState())).maximized, 'Restore failed');
    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await until(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'Minimize failed');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await page.getByRole('link', { name: 'Extensions', exact: true }).click();
    await page.getByRole('heading', { name: 'Extensions', exact: true }).waitFor();
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByRole('link', { name: 'CLI configuration', exact: true }).waitFor();
    await page.screenshot({path:path.join(process.env.VIBEDECK_ARTIFACTS,'electron-extensions.png')});
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await electron.evaluate(({shell}) => { global.fixtureExternal = []; shell.openExternal = async url => { global.fixtureExternal.push(url); }; });
    await page.getByRole('button', {name:'Vibe menu',exact:true}).click();
    await page.getByRole('link', {name:'Studio',exact:true}).click();
    await until(() => electron.evaluate(() => global.fixtureExternal.includes('https://console.mistral.ai/')), 'Studio did not open the browser console');
    // Serve remote-origin fixtures in the real isolated view. No cloud writes or credentials.
    await electron.evaluate(async ({ session }) => {
      for (const name of ['persist:mistral-workspace','persist:mistral-docs','persist:mistral-admin']) {
      const partition = session.fromPartition(name);
      await partition.protocol.handle('https', async request => {
        const url = new URL(request.url);
        if (url.origin === 'https://auth.mistral.ai' && url.pathname === '/admin-login-fixture') {
          return new Response(null, {status:302,headers:{location:'https://admin.mistral.ai/subscription'}});
        }
        if (!['https://chat.mistral.ai','https://docs.mistral.ai','https://admin.mistral.ai'].includes(url.origin)) return new Response('', { status: 403 });
        if (url.origin === 'https://admin.mistral.ai' && global.fixtureAdminLogin) {
          const cookies = await partition.cookies.get({url:url.origin});
          if (!cookies.some(cookie=>cookie.name==='ory_session_admin_fixture' && cookie.httpOnly && cookie.secure)) {
            return new Response(null,{status:302,headers:{location:'https://auth.mistral.ai/admin-login-fixture'}});
          }
        }
        return new Response(`<html><body><h1 id="page">${url.pathname}</h1>
          <button onclick="document.querySelector('h1').textContent='Skills'">Skills<span>New</span></button>
          <button onclick="document.querySelector('h1').textContent='Instructions'">Instructions</button>
          <input aria-label="Fixture memory" value="">
          <input type="file" aria-label="Upload fixture"><output id="upload"></output>
          <button id="export" onclick="window.fixtureBlob=window.URL.createObjectURL(new Blob(['export fixture'],{type:'text/plain'})); window.open(window.fixtureBlob)">Export fixture</button>
          <script>document.querySelector('input').value=localStorage.getItem('memory')||'';
          document.querySelector('input').onchange=e=>localStorage.setItem('memory',e.target.value);
          document.querySelector('input[type=file]').onchange=async e=>document.querySelector('#upload').textContent=await e.target.files[0].text();</script>
          </body></html>`, { headers: { 'content-type': 'text/html' } });
      });
      }
    });
    for (const [name, expected] of [['Skills','/skills'], ['Knowledge','/knowledge'], ['Instructions','Instructions'], ['Libraries','/libraries'], ['Connectors','/connections'], ['Scheduled','/tasks']]) {
      await page.getByRole('link', { name, exact: true }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor({state:'attached'});
      await page.locator('[data-vd-titlebar]').getByRole('button', {name:'Back to desktop',exact:true}).waitFor();
      assert.equal(await page.getByRole('button', {name:'Back to desktop',exact:true}).count(),1,'Workspace controls appear once');
      await until(() => electron.evaluate(({ webContents }) => webContents.getAllWebContents().some(w => w.getURL().startsWith('https://chat.mistral.ai/'))), 'Workspace not created');
      const remote = await electron.evaluateHandle(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('https://chat.mistral.ai/')));
      await until(() => remote.evaluate((w, expected) => w.executeJavaScript('document.querySelector("h1")?.textContent').then(text => text === expected), expected), 'Workspace destination did not open: ' + name).catch(async error => { throw error; });
      assert.deepEqual(await remote.evaluate(w => w.executeJavaScript('[typeof window.require, typeof window.vibedeck]')), ['undefined', 'undefined']);
      if (name === 'Connectors') {
        await remote.evaluate(w => w.executeJavaScript("window.open('https://accounts.google.com/o/oauth2/auth')"));
        await page.getByRole('status').filter({hasText:'This service needs browser authorization'}).waitFor();
        await page.getByRole('button', {name:'Dismiss workspace notice',exact:true}).click();
        assert.equal(await page.getByRole('status').filter({hasText:'This service needs browser authorization'}).count(),0);
        await electron.evaluate(({ ipcMain }) => {
          let finish;
          ipcMain.removeHandler('workspace:connectors');
          ipcMain.removeHandler('usage:confirm-signin');
          ipcMain.handle('workspace:connectors', () => new Promise(resolve => { finish=resolve; }));
          ipcMain.handle('usage:confirm-signin', (_event, accepted) => { finish(accepted); return true; });
        });
        await page.getByRole('button', {name:'Connect services',exact:true}).click();
        assert.equal(await page.getByRole('button', {name:'Back to desktop',exact:true}).isDisabled(), true, 'A pending browser handoff must keep its confirmation reachable');
        await page.getByRole('button', {name:'I’ve finished setup',exact:true}).click();
        await until(() => page.getByRole('button', {name:'Connect services',exact:true}).isEnabled(), 'Connector handoff never finished');
        await until(() => electron.evaluate(({webContents}) => webContents.getAllWebContents().some(w => w.getURL()==='https://chat.mistral.ai/connections')), 'Connector page was not restored');
        await page.route('**/api/mcp', route => route.fulfill({json:{servers:[{name:'Local research MCP',command:'fixture-mcp',transport:'stdio'}]}}));
        await page.getByRole('button', {name:'Show local CLI connectors',exact:true}).click();
        await page.getByText('Local research MCP', {exact:true}).waitFor();
        await until(() => electron.evaluate(({webContents}) => !webContents.getAllWebContents().some(w => w.getURL().startsWith('https://chat.mistral.ai/'))), 'Local connectors were covered by the web view');
        await page.screenshot({path:path.join(process.env.VIBEDECK_ARTIFACTS,'electron-local-connectors.png')});
        await page.getByRole('button', {name:'Refresh local CLI connectors',exact:true}).click();
        await page.getByText('Local research MCP', {exact:true}).waitFor();
        await page.getByRole('link', {name:'Manage web connectors',exact:true}).click();
        await until(() => electron.evaluate(({webContents}) => webContents.getAllWebContents().some(w => w.getURL()==='https://chat.mistral.ai/connections')), 'Web connectors did not reopen after local view');
        await page.unroute('**/api/mcp');
      }
      if (name === 'Libraries') {
        const beforeSignIn = await remote.evaluate(w => w.id);
        await electron.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('workspace:signin');
          ipcMain.handle('workspace:signin', () => false);
        });
        await page.getByRole('button', {name:'Switch account',exact:true}).click();
        await until(() => page.getByRole('button', {name:'Switch account',exact:true}).isEnabled(), 'Cancelled sign-in did not finish');
        assert.equal(await electron.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL() === 'https://chat.mistral.ai/libraries')?.id), beforeSignIn, 'Cancelled sign-in reloaded the workspace');
        const remotePage = electron.context().pages().find(p => p.url() === 'https://chat.mistral.ai/libraries');
        assert.ok(remotePage, 'Remote workspace is available for interaction checks');
        remotePage.on('pageerror', error => errors.push(error.message));
        await remotePage.getByLabel('Upload fixture').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('upload fixture')});
        await until(() => remotePage.locator('#upload').textContent().then(text => text === 'upload fixture'), 'File upload did not reach the page');
        const fs = require('node:fs');
        const target = path.join(process.env.VIBEDECK_ARTIFACTS,'workspace-export.txt');
        fs.rmSync(target, {force:true});
        await electron.evaluate(({ session }, target) => {
          session.fromPartition('persist:mistral-workspace').once('will-download', (_event,item) => item.setSavePath(target));
        }, target);
        // Playwright does not offset mouse coordinates for an embedded WebContentsView.
        await remote.evaluate(w => w.executeJavaScript("document.querySelector('#export').click()", true));
        await until(() => fs.existsSync(target) && fs.readFileSync(target,'utf8') === 'export fixture', 'Blob export failed');

        await page.reload();
        await page.getByRole('heading', { name, exact: true }).waitFor({state:'attached'});
      await page.locator('[data-vd-titlebar]').getByRole('button', {name:'Back to desktop',exact:true}).waitFor();
      assert.equal(await page.getByRole('button', {name:'Back to desktop',exact:true}).count(),1,'Workspace controls appear once');
        await until(() => electron.evaluate(({ webContents }) => {
          const views = webContents.getAllWebContents().filter(w => w.getURL().startsWith('https://chat.mistral.ai/'));
          return views.length === 1 && views[0].getURL().endsWith('/libraries');
        }), 'Workspace did not recover after desktop reload');
      }
      if (name === 'Knowledge') {
        await remote.evaluate(w => w.executeJavaScript('localStorage.setItem("memory", "persistent fixture")'));
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await until(() => electron.evaluate(({ webContents }) => {
          const w = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://chat.mistral.ai/'));
          return w ? w.executeJavaScript('document.querySelector("input")?.value === "persistent fixture"').catch(() => false) : false;
        }), 'Workspace state lost on refresh');
      }
      if (name === 'Skills') {
        await remote.evaluate(w => w.loadURL('https://chat.mistral.ai/connections'));
        await page.getByRole('button', {name:'Show local CLI connectors',exact:true}).click();
        await page.getByRole('heading', {name:'MCP Servers',exact:true}).waitFor();
        assert.ok(page.url().endsWith('/workspace/connectors'), 'Internal web navigation must return to the correct connector route');
        await page.getByRole('button', {name:'Show Mistral web connectors',exact:true}).click();
        await until(() => electron.evaluate(({webContents}) => webContents.getAllWebContents().some(w => w.getURL()==='https://chat.mistral.ai/connections')), 'Internal navigation returned to Skills instead of Connectors');
      }
      await page.getByRole('button', { name: 'Back to desktop', exact: true }).click();
      await until(() => electron.evaluate(({ webContents }) => !webContents.getAllWebContents().some(w => w.getURL().startsWith('https://chat.mistral.ai/'))), 'Workspace leaked after closing');
      await remote.dispose();
    }
    for (const [section,host] of [['docs','docs.mistral.ai'],['admin','admin.mistral.ai']]) {
      await page.goto(process.env.VIBEDECK_URL + '/workspace/' + section);
      await until(() => electron.evaluate(({webContents},host) => webContents.getAllWebContents().some(w=>w.getURL().startsWith('https://'+host+'/')),host), 'Embedded '+section+' did not open');
      const cookies = await electron.evaluate(({session},section)=>session.fromPartition('persist:mistral-'+section).cookies.get({}),section);
      assert.equal(cookies.length,0,'New embedded service has no copied login cookies');
    }
    await page.getByRole('button', {name:'Back to desktop',exact:true}).click();
    await electron.evaluate(() => {
      global.fixtureAdminLogin=true;
      global.fixtureCookieDestinations=[];
      global.fixtureBrowser.workspaceCookies=async(_base,destination)=>{
        global.fixtureCookieDestinations.push(destination);
        return [{domain:'admin.mistral.ai',name:'ory_session_admin_fixture',value:'admin-test',httpOnly:true,secure:true},
          {domain:'chat.mistral.ai',name:'work_only_fixture',value:'work-test',secure:true},
          {domain:'.google.com',name:'google_fixture',value:'never-copy',secure:true}];
      };
    });
    await page.goto(process.env.VIBEDECK_URL+'/workspace/admin');
    await until(()=>electron.evaluate(({webContents})=>webContents.getAllWebContents().some(w=>w.getURL()==='https://admin.mistral.ai/')),'Saved Admin session did not open');
    const admin=await electron.evaluateHandle(({webContents})=>webContents.getAllWebContents().find(w=>w.getURL()==='https://admin.mistral.ai/'));
    await until(()=>admin.evaluate(w=>w.executeJavaScript('document.querySelector("h1")?.textContent').then(text=>text==='/')),'Saved Admin session did not load');
    assert.deepEqual(await electron.evaluate(()=>global.fixtureCookieDestinations),['admin']);
    assert.deepEqual(await electron.evaluate(({session})=>session.fromPartition('persist:mistral-admin').cookies.get({}).then(c=>c.map(c=>c.name))),['ory_session_admin_fixture']);
    await admin.evaluate(w=>w.loadURL('https://auth.mistral.ai/admin-login-fixture'));
    assert.equal(await admin.evaluate(w=>w.getURL()),'https://admin.mistral.ai/subscription','OAuth callback must keep the same Admin renderer and session');
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await until(()=>electron.evaluate(({webContents})=>webContents.getAllWebContents().some(w=>w.getURL()==='https://admin.mistral.ai/subscription')),'Admin refresh lost authentication');
    await page.getByRole('button',{name:'Back to desktop',exact:true}).click();
    await page.goto(process.env.VIBEDECK_URL+'/workspace/admin');
    await until(()=>electron.evaluate(({webContents})=>webContents.getAllWebContents().some(w=>w.getURL()==='https://admin.mistral.ai/')),'Reopening Admin lost authentication');
    await electron.evaluate(({ipcMain})=>{
      let finish;
      ipcMain.removeHandler('workspace:signin');
      ipcMain.handle('workspace:signin',(_event,destination)=>{global.fixtureSignInDestination=destination;return new Promise(resolve=>{finish=resolve;});});
      ipcMain.removeHandler('usage:confirm-signin');
      ipcMain.handle('usage:confirm-signin',(_event,accepted)=>{if(!finish)return false;finish(accepted);finish=null;return true;});
    });
    await page.getByRole('button',{name:'Switch account',exact:true}).click();
    await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
    await until(()=>page.getByRole('button',{name:'Switch account',exact:true}).isEnabled(),'Cancelling Admin sign-in left controls disabled');
    assert.equal(await electron.evaluate(()=>global.fixtureSignInDestination),'admin','Admin recovery opens the Admin browser destination');
    assert.equal(await electron.evaluate(({session})=>session.fromPartition('persist:mistral-admin').cookies.get({}).then(c=>c.length)),1,'Cancellation preserves Admin authentication');
    assert.equal(await electron.evaluate(({session})=>session.fromPartition('persist:mistral-workspace').cookies.get({}).then(c=>c.length)),0,'Admin login does not write Work cookies');
    assert.equal(await electron.evaluate(({session})=>session.fromPartition('persist:mistral-docs').cookies.get({}).then(c=>c.length)),0,'Admin login does not write Docs cookies');
    await admin.dispose();
    await page.getByRole('button', {name:'Back to desktop',exact:true}).click();
    await page.evaluate(() => window.vibedeck.usage.disconnect());
    assert.equal(await electron.evaluate(({ session }) => session.fromPartition('persist:mistral-workspace').cookies.get({}).then(c => c.length)), 0);
    assert.equal(await electron.evaluate(({ session }) => session.fromPartition('persist:mistral-admin').cookies.get({}).then(c => c.length)), 0);
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    for (const name of ['Usage', 'Skills', 'MCP', 'Settings']) {
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByRole('navigation', { name: 'Account menu', exact: true }).getByRole('link', { name, exact: true }).click();
      await page.getByRole('heading', { name: name === 'MCP' ? 'MCP Servers' : name, exact: true }).waitFor();
      if (name === 'Skills') {
        const shared = page.getByRole('checkbox', {name:'Use shared Mistral workspace skills in the CLI and desktop'});
        await shared.check();
        await until(() => shared.isEnabled(), 'Shared skill setting did not finish saving');
        assert.equal((await (await electron.context().request.get(process.env.VIBEDECK_URL + '/api/skills')).json()).sharedEnabled, true);
        await shared.uncheck();
        await until(() => shared.isEnabled(), 'Shared skill setting did not finish disabling');
      }

    }
    const menu=page.getByRole('navigation',{name:'Settings sections'});
    for(const name of ['Models','Config','Providers']) {
      await menu.getByRole('link',{name,exact:true}).click();
      await page.getByRole('region',{name:`${name.toLowerCase()} settings`,exact:true}).waitFor();
    }
    await menu.getByRole('link',{name:'Config',exact:true}).click();
    await page.getByRole('combobox',{name:'App zoom',exact:true}).selectOption('1.25');
    await until(()=>page.getByRole('combobox',{name:'App zoom',exact:true}).isEnabled(),'Zoom did not finish');
    assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),1.25);
    await page.reload();
    await until(()=>page.getByRole('combobox',{name:'App zoom',exact:true}).inputValue().then(v=>v==='1.25'),'Zoom not restored');
    await page.goto(process.env.VIBEDECK_URL+'/workspace/docs');
    await until(()=>electron.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().startsWith('https://docs.mistral.ai/'))?.getZoomFactor()===1.25),'Embedded page zoom differs from desktop');
    const viewBounds = await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds());
    assert.equal(viewBounds.y,50,'Zoomed title bar must stay visible above embedded content');
    await page.getByRole('button',{name:'Back to desktop',exact:true}).click();
    await page.goto(process.env.VIBEDECK_URL+'/settings?section=config');
    await page.getByRole('combobox',{name:'App zoom',exact:true}).selectOption('1');
    await until(()=>page.getByRole('combobox',{name:'App zoom',exact:true}).isEnabled(),'Zoom reset did not finish');
    await page.getByRole('button',{name:'Forest',exact:true}).click();
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'forest');
    await page.getByRole('button',{name:'Dark',exact:true}).click();
    await page.screenshot({path:path.join(process.env.VIBEDECK_ARTIFACTS,'electron-settings-menu.png')});
    const api = electron.context().request;
    const config = await api.patch(`${process.env.VIBEDECK_URL}/api/config`, { data: { defaultModel: 'local' } });
    assert.equal(config.status(), 200);
    await page.goto(process.env.VIBEDECK_URL);
    await page.evaluate(cwd => localStorage.setItem('vibedeck.cwd', cwd), process.env.VIBEDECK_TEST_HOME);
    await page.reload();
    await page.locator('textarea').fill('Electron native round trip');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('LOCAL_INTEROP_OK', { exact: true }).waitFor({ timeout: 30000 }).catch(async error => { console.error('Fixture session:', (await page.locator('main').innerText()).slice(0,1500)); throw error; });
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    const sessionURL = page.url();
    await page.reload();
    await page.getByText('LOCAL_INTEROP_OK', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Continue in the vibe CLI', exact: true }).click();
    await until(() => page.locator('textarea').isDisabled(), 'CLI handoff did not disable composer');
    await page.getByRole('button', { name: 'Continue in desktop', exact: true }).click();
    await until(() => page.locator('textarea').isEnabled(), 'Desktop resume did not enable composer');
    await page.getByText('LOCAL_INTEROP_OK', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('link', { name: 'Usage', exact: true }).click();
    await page.getByRole('tab', { name: 'Local activity', exact: true }).click();
    await page.goto(sessionURL);
    await page.getByText('LOCAL_INTEROP_OK', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(process.env.VIBEDECK_ARTIFACTS, 'electron-native-flow.png') });
    console.log('PASS: real Electron isolated workspace routes, uploads, blob exports, persistence, close/sign-out, preload/IPC, window controls, navigation, first send, streaming, persisted history, CLI handoff and desktop resume');
  } finally { await electron.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
