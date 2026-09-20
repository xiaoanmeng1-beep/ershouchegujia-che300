const { app, BrowserWindow, ipcMain, session, dialog, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { decodePriceImage, selfTest } = require('./price-decoder');
const { DataStore } = require('./data-store');
const { resolveDataDirectory, initializePortableDatabase } = require('./portable-data');
const { LatestRequest } = require('./latest-request');
const { EmbeddedLogin } = require('./embedded-login');

// Windows may freeze fully hidden Chromium windows even when page throttling is disabled.
// Catalog and quote extraction depend on those windows continuing to render and execute JS.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const quoteRequests = new LatestRequest();
const idleQuoteWindows = new Map();

let CHE300_PARTITION = 'persist:che300';
let currentAccountId = 'default';
let accounts = [];
const ACCOUNT_ROTATION_LIMIT = 20;
const ACCOUNT_PREFLIGHT_AT = 15;
const ACCOUNT_CHECK_TTL = 2 * 60 * 1000;
const CATEGORY_INDEX = {
  passenger: 'passenger-car',
  energy: 'green-car',
  commercial: 'commercial-car'
};
const CACHE_TTL = 3 * 24 * 60 * 60 * 1000;
const CATALOG_TTL = CACHE_TTL;

let mainWindow;
let loginWindow;
let loginCheckTimer;
let loginCompletion;
let resolveLoginCompletion;
let loginAuthenticated = false;
let sessionVerified = false;
let loginReachedLoginPage = false;
let loginSyncRecoveryAttempted = false;
let loginLastSyncPhase = '';
let loginPhoneMask = '';
let workerWindow;
let workerCategory = '';
let workerBrandId = '';
let browserQueue = Promise.resolve();
let catalogQueue = Promise.resolve();
let runtimeLogFile;
let regionRequest;
let dataStore;
const catalogTaskPromises = new Map();
let logSequence = 0;
const logHistory = [];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function emitLog(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  const safeMessage = `${message}${suffix}`
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]')
    .replace(/车\s*300|che300/gi, '数据服务');
  const entry = { id: ++logSequence, time: Date.now(), message: safeMessage };
  logHistory.push(entry);
  if (runtimeLogFile) {
    try { fs.appendFileSync(runtimeLogFile, JSON.stringify(entry) + '\n'); } catch {}
  }
  if (logHistory.length > 200) logHistory.shift();
  console.log(`[valuation] ${entry.message}`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:log', entry);
}

async function runLogged(label, details, task) {
  const startedAt = Date.now();
  emitLog(`${label}：开始`, details);
  try {
    const result = await task();
    emitLog(`${label}：完成`, { elapsedMs: Date.now() - startedAt, ...(Array.isArray(result) ? { count: result.length } : {}) });
    return result;
  } catch (error) {
    emitLog(`${label}：失败`, { message: error.message, elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

function serializeBrowserWork(task) {
  const result = browserQueue.then(task, task);
  browserQueue = result.catch(() => undefined);
  return result;
}

function queueCatalogTask(key, task) {
  if (catalogTaskPromises.has(key)) return catalogTaskPromises.get(key);
  const taskWithRetry = async () => {
    try { return await task(); }
    catch (error) {
      if (/无效|不存在/.test(error.message || '')) throw error;
      emitLog('目录请求失败，重试一次', { message: error.message });
      discardWorkerWindow();
      await sleep(400);
      return task();
    }
  };
  const promise = catalogQueue.then(taskWithRetry, taskWithRetry).finally(() => catalogTaskPromises.delete(key));
  catalogQueue = promise.catch(() => undefined);
  catalogTaskPromises.set(key, promise);
  return promise;
}

function scheduleCatalogTask(key, task) {
  queueCatalogTask(key, task).catch(error => emitLog('后台目录更新失败', { key, message: error.message }));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 400,
    minHeight: 350,
    movable: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    title: '二手车估价',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#f2f2f2',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.once('did-finish-load', () => {
    publishAccounts();
    verifyStartupAccounts().catch(error => emitLog('启动验证失败', { message: error.message }));
  });
  return mainWindow;
}

function normalizeChe300Target(targetUrl) {
  const fallback = 'https://www.che300.com/pinggu?city=3';
  try {
    const url = new URL(targetUrl || fallback);
    if (url.protocol !== 'https:' || url.hostname !== 'www.che300.com' || !url.pathname.startsWith('/pinggu')) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

function discardWorkerWindow() {
  if (workerWindow && !workerWindow.isDestroyed()) workerWindow.destroy();
  workerWindow = null;
  workerCategory = '';
  workerBrandId = '';
}

function installLoginSyncBridge(recover, targetUrl) {
  if (location.hostname !== 'login.che300.com' || window.__valuationLoginSync) return;
  if (typeof window.setCookieApi !== 'function' || typeof window.jsonp !== 'function') return;

  const sync = { phase: 'ready', error: '' };
  window.__valuationLoginSync = sync;
  const originalSetCookie = window.setCookieApi;
  const originalJsonp = window.jsonp;
  let activeRequests = null;
  let running = null;

  function notice(text) {
    let node = document.getElementById('valuation-session-notice');
    if (!node) {
      node = document.createElement('div');
      node.id = 'valuation-session-notice';
      node.setAttribute('role', 'status');
      node.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 20px;background:#edf4fb;color:#233d54;font:14px sans-serif;text-align:center;';
      document.body.appendChild(node);
    }
    node.textContent = text;
  }

  window.jsonp = function(url) {
    const parsed = new URL(url, location.href);
    if (!activeRequests || parsed.origin !== location.origin || parsed.pathname !== '/api/fe/v1/common/set-cookie') {
      return originalJsonp(url);
    }
    // Keep the official cookie-sync script alive until it actually completes.
    // No token is read, copied, or recorded by the host application.
    const task = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        error ? reject(error) : resolve();
      };
      window.jsonCallBack = function() {};
      script.onload = () => finish();
      script.onerror = () => finish(new Error('官方会话同步请求失败'));
      script.src = url;
      timer = setTimeout(() => finish(new Error('官方会话同步超时')), 15000);
      document.head.appendChild(script);
    });
    task.catch(() => {});
    activeRequests.push(task);
    return task;
  };

  window.setCookieApi = function(callback) {
    if (running) return running;
    activeRequests = [];
    sync.phase = 'syncing';
    sync.error = '';
    notice('正在同步账号授权，完成后自动查询，请稍候…');
    running = new Promise((resolve) => {
      let settled = false;
      const finish = (error, count) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeRequests = null;
        if (error || !count) {
          sync.phase = 'failed';
          sync.error = error ? error.message : '当前会话没有可同步的报价授权';
          notice(sync.error + '。请在下方完成登录后重试。');
          resolve(false);
          return;
        }
        sync.phase = 'synced';
        notice('账号授权同步完成，正在验证报价权限…');
        callback();
        resolve(true);
      };
      const timer = setTimeout(() => finish(new Error('获取官方授权信息超时')), 20000);
      try {
        originalSetCookie(() => {
          const requests = (activeRequests || []).slice();
          // Other products' sync endpoints can fail independently of the quote site.
          // Navigate after settlement; only the actual quote page confirms authorization.
          Promise.allSettled(requests).then(() => finish(null, requests.length));
        });
      } catch (error) {
        finish(error);
      }
    }).finally(() => { running = null; });
    return running;
  };

  if (recover) window.setCookieApi(() => location.assign(targetUrl));
}

async function loginPageState(window) {
  if (!window || window.isDestroyed()) return null;
  try {
    return await evaluatePage(window, `
      (() => {
        const visible = (node) => Boolean(node && node.getClientRects().length);
        const inputs = [...document.querySelectorAll('input')];
        return {
          url: location.href,
          syncPhase: window.__valuationLoginSync?.phase || '',
          syncError: window.__valuationLoginSync?.error || '',
          hasLogout: document.body.innerText.includes('退出'),
          hasPhoneInput: inputs.some((node) => visible(node) && (node.placeholder || '').includes('手机号')),
          hasQuoteImage: Boolean(document.querySelector('[class*="excellent_low_buy_price"] img, img[class*="excellent_low_buy_price"]'))
        };
      })()
    `);
  } catch {
    return null;
  }
}

function reportAuthState(phase) {
  const account = accounts.find(item => item.id === currentAccountId);
  if (account) {
    if (phase === 'authenticated') {
      account.validationVersion = (account.validationVersion || 0) + 1;
      account.status = 'authenticated';
      account.checkedAt = Date.now();
      account.hasSession = true;
    } else if (['expired', 'login-required', 'cancelled'].includes(phase)) {
      account.validationVersion = (account.validationVersion || 0) + 1;
      if (phase === 'login-required') account.loginInProgress = true;
      account.status = phase;
      account.checkedAt = 0;
    }
    publishAccounts();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('che300:auth-state', { phase, accountId: currentAccountId });
  }
}

function sessionSnapshotFile() {
  return path.join(app.getPath('userData'), 'account-sessions.bin');
}

function readSessionSnapshots() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(sessionSnapshotFile())) return {};
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(sessionSnapshotFile())));
  } catch (error) {
    emitLog('读取本机登录状态失败', { message: error.message });
    return {};
  }
}

function writeSessionSnapshots(snapshots) {
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.mkdirSync(path.dirname(sessionSnapshotFile()), { recursive: true });
  fs.writeFileSync(sessionSnapshotFile(), safeStorage.encryptString(JSON.stringify(snapshots)));
}

function cookieSetDetails(cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '');
  const cookiePath = cookie.path || '/';
  const details = {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookiePath}`,
    name: cookie.name,
    value: cookie.value,
    path: cookiePath,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || 'unspecified'
  };
  if (!cookie.hostOnly && !cookie.name.startsWith('__Host-')) details.domain = cookie.domain;
  if (!cookie.session && Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate;
  return details;
}

async function saveAccountSession(accountId, partition) {
  const cookies = await session.fromPartition(partition).cookies.get({});
  const snapshots = readSessionSnapshots();
  snapshots[accountId] = cookies.filter(cookie => /(^|\.)che300\.com$/i.test(cookie.domain));
  writeSessionSnapshots(snapshots);
}

async function restoreAccountSessions() {
  const snapshots = readSessionSnapshots();
  for (const account of accounts) {
    const saved = snapshots[account.id];
    if (!Array.isArray(saved) || !saved.length) continue;
    const accountCookies = session.fromPartition(account.partition).cookies;
    for (const cookie of saved) {
      try { await accountCookies.set(cookieSetDetails(cookie)); }
      catch (error) { emitLog('恢复部分登录状态失败', { account: account.label, message: error.message }); }
    }
    await accountCookies.flushStore();
  }
}

function removeAccountSessionSnapshot(accountId) {
  const snapshots = readSessionSnapshots();
  if (!Object.hasOwn(snapshots, accountId)) return;
  delete snapshots[accountId];
  writeSessionSnapshots(snapshots);
}

async function completeLogin(reason, url) {
  if (loginAuthenticated) return true;
  loginAuthenticated = true;
  emitLog('登录状态已确认', { reason, url });
  sessionVerified = true;
  try {
    const accountSession = session.fromPartition(CHE300_PARTITION);
    await saveAccountSession(currentAccountId, CHE300_PARTITION);
    await accountSession.cookies.flushStore();
  } catch (error) {
    emitLog('登录可用于本次查询，但保存会话失败', { message: error.message });
  }
  const account = accounts.find(item => item.id === currentAccountId);
  if (account && loginPhoneMask && account.phoneMask !== loginPhoneMask) {
    account.phoneMask = loginPhoneMask;
    dataStore.db.prepare('UPDATE service_accounts SET phone_mask = ? WHERE id = ?')
      .run(loginPhoneMask, account.id);
  }
  reportAuthState('authenticated');
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  return true;
}

async function hasSyncedLoginCookie() {
  try {
    const cookies = await session.fromPartition(CHE300_PARTITION).cookies.get({ name: 'login_st' });
    const now = Date.now() / 1000;
    return cookies.some(cookie => Boolean(cookie.value) && (!cookie.expirationDate || cookie.expirationDate > now));
  } catch {
    return false;
  }
}

async function checkLoginWindow() {
  const state = await loginPageState(loginWindow);
  if (!state) return false;
  if (state.syncPhase && state.syncPhase !== loginLastSyncPhase) {
    loginLastSyncPhase = state.syncPhase;
    emitLog('官方登录会话同步', { phase: state.syncPhase, error: state.syncError });
  }
  if (state.syncPhase === 'synced' && !state.syncError && await hasSyncedLoginCookie()) {
    return completeLogin('登录会话同步完成', state.url);
  }
  let hostname = '';
  try {
    hostname = new URL(state.url).hostname;
  } catch {
    return false;
  }
  if (hostname !== 'www.che300.com' || state.hasPhoneInput || (!state.hasLogout && !state.hasQuoteImage)) {
    return false;
  }

  const reason = state.hasQuoteImage
    ? '登录后的报价页已打开'
    : '官网已显示登录状态';
  return completeLogin(reason, state.url);
}

async function openChe300Login(targetUrl) {
  if (!accounts.some(account => account.id === currentAccountId && !account.deleting)) {
    return { authenticated: false, code: 'NO_ACCOUNT' };
  }
  if (loginWindow && !loginWindow.isDestroyed()) {
    emitLog('登录面板已展开');
    loginWindow.focus();
    return loginCompletion;
  }

  const safeTargetUrl = normalizeChe300Target(targetUrl);
  emitLog('当前会话未登录，展开右侧登录面板', { targetUrl: safeTargetUrl });
  loginAuthenticated = false;
  loginReachedLoginPage = false;
  loginSyncRecoveryAttempted = false;
  loginLastSyncPhase = '';
  loginPhoneMask = '';
  sessionVerified = false;
  reportAuthState('login-required');
  loginCompletion = new Promise((resolve) => {
    resolveLoginCompletion = resolve;
  });

  loginWindow = new EmbeddedLogin(mainWindow, CHE300_PARTITION, emitLog);

  loginWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    loginWindow?.setTitle('账号授权');
  });

  const bridgeWindow = loginWindow;
  bridgeWindow.webContents.on('dom-ready', async () => {
    try {
      if (bridgeWindow.isDestroyed() || new URL(bridgeWindow.webContents.getURL()).hostname !== 'login.che300.com') return;
      const cookies = await session.fromPartition(CHE300_PARTITION).cookies.get({ url: 'https://login.che300.com/' });
      const recover = !loginSyncRecoveryAttempted && cookies.some(cookie => cookie.name === 'login_st' && Boolean(cookie.value));
      loginSyncRecoveryAttempted = true;
      emitLog('安装官方会话同步等待逻辑', { reuseSavedLogin: recover });
      await bridgeWindow.webContents.executeJavaScript('(' + installLoginSyncBridge.toString() + ')(' + JSON.stringify(recover) + ',' + JSON.stringify(safeTargetUrl) + ')');
    } catch (error) {
      emitLog('安装会话同步逻辑失败', { message: error.message });
    }
  });

  loginWindow.webContents.on('did-navigate', async (_event, url) => {
    try {
      const hostname = new URL(url).hostname;
      if (hostname === 'login.che300.com') {
        loginReachedLoginPage = true;
        return;
      }
      if (loginReachedLoginPage && hostname === 'www.che300.com') {
        if (await hasSyncedLoginCookie()) {
          await completeLogin('登录页回跳且会话已同步', url);
          return;
        }
        emitLog('登录页已回跳官网，等待会话同步完成', { url });
      }
    } catch (error) {
      emitLog('读取登录跳转地址失败', { message: error.message });
    }
  });

  loginWindow.webContents.on('did-finish-load', async () => {
    if (bridgeWindow.isDestroyed()) return;
    emitLog('登录面板页面已加载', { url: bridgeWindow.webContents.getURL() });
    await checkLoginWindow();
  });

  const loginUrl = new URL('https://login.che300.com/ucenter/login');
  loginUrl.searchParams.set('city', '3');
  loginUrl.searchParams.set('redirect_url', safeTargetUrl);
  const activeLoginWindow = loginWindow;
  activeLoginWindow.loadURL(loginUrl.toString()).catch((error) => {
    emitLog('授权页面加载失败', { message: error.message });
    if (!activeLoginWindow.isDestroyed()) activeLoginWindow.setPhase('failed');
  });
  loginCheckTimer = setInterval(async () => {
    if (!loginWindow || loginWindow.isDestroyed()) return;
    await checkLoginWindow();
  }, 750);
  loginWindow.on('closed', () => {
    clearInterval(loginCheckTimer);
    loginCheckTimer = null;
    loginWindow = null;
    const result = { authenticated: loginAuthenticated };
    const account = accounts.find(item => item.id === currentAccountId);
    if (account) account.loginInProgress = false;
    if (!loginAuthenticated) reportAuthState('cancelled');
    else publishAccounts();
    resolveLoginCompletion?.(result);
    resolveLoginCompletion = null;
    loginCompletion = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('che300-window-closed', result);
      mainWindow.show();
    }
  });

  return loginCompletion;
}

async function withPageTimeout(target, task, timeout = 20000, destroyOnTimeout = true) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('数据服务响应超时');
          error.code = 'REQUEST_TIMEOUT';
          reject(error);
          if (destroyOnTimeout) {
            if (target === workerWindow) discardWorkerWindow();
            else if (target && target !== loginWindow && !target.isDestroyed()) target.destroy();
          }
        }, Math.max(1, timeout));
      })
    ]);
  } finally { clearTimeout(timer); }
}

function evaluatePage(target, source, timeout = 20000, destroyOnTimeout = true) {
  const execute = () => {
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
      const error = new Error('后台页面已关闭');
      error.code = 'PAGE_CLOSED';
      throw error;
    }
    return target.webContents.executeJavaScript(source);
  };
  if (target === loginWindow) return Promise.resolve().then(execute);
  return withPageTimeout(target, execute, timeout, destroyOnTimeout);
}

async function loadChe300Page(browserWindow, url, timeout = 12000) {
  const contents = browserWindow.webContents;
  let readyHandler;
  let timeoutId;
  const domReady = new Promise((resolve, reject) => {
    readyHandler = resolve;
    contents.once('dom-ready', readyHandler);
    timeoutId = setTimeout(() => reject(new Error('数据服务连接超时')), timeout);
  });

  try {
    await Promise.race([browserWindow.loadURL(url), domReady]);
  } catch (error) {
    if (browserWindow === workerWindow) discardWorkerWindow();
    else if (!browserWindow.isDestroyed()) browserWindow.destroy();
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (!contents.isDestroyed()) contents.removeListener('dom-ready', readyHandler);
  }
}

async function getWorkerWindow() {
  if (workerWindow && !workerWindow.isDestroyed()) return workerWindow;
  emitLog('创建隐藏的数据采集窗口');
  workerWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    webPreferences: {
      partition: CHE300_PARTITION,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await loadChe300Page(workerWindow, 'https://www.che300.com/pinggu?city=3');
  emitLog('车300车型目录页加载完成');
  workerCategory = '';
  workerBrandId = '';
  return workerWindow;
}

async function getQuoteWindow(scope) {
  scope.check();
  if (scope.window && !scope.window.isDestroyed()) return scope.window;
  const idle = idleQuoteWindows.get(CHE300_PARTITION);
  if (idle) {
    clearTimeout(idle.timer);
    idleQuoteWindows.delete(CHE300_PARTITION);
    if (!idle.window.isDestroyed()) {
      emitLog('复用后台报价窗口');
      return scope.attach(idle.window);
    }
  }
  const quoteWindow = scope.attach(new BrowserWindow({
    width: 1440, height: 1200, show: false,
    webPreferences: {
      partition: CHE300_PARTITION, backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  }));
  scope.check();
  return quoteWindow;
}

function retainQuoteWindow(scope) {
  scope.check();
  const window = scope.window;
  if (!window || window.isDestroyed()) return;
  scope.window = null;
  const partition = CHE300_PARTITION;
  const previous = idleQuoteWindows.get(partition);
  if (previous) {
    clearTimeout(previous.timer);
    if (!previous.window.isDestroyed()) previous.window.destroy();
  }
  const entry = { window, timer: null };
  const retire = () => {
    if (idleQuoteWindows.get(partition) !== entry) return;
    idleQuoteWindows.delete(partition);
    clearTimeout(entry.timer);
    if (!window.isDestroyed()) window.destroy();
  };
  entry.timer = setTimeout(retire, 120000);
  entry.timer.unref();
  idleQuoteWindows.set(partition, entry);
  const owner = mainWindow;
  owner.once('closed', retire);
  window.once('closed', () => owner.removeListener('closed', retire));
  while (idleQuoteWindows.size > 2) {
    const [key, oldest] = idleQuoteWindows.entries().next().value;
    idleQuoteWindows.delete(key);
    clearTimeout(oldest.timer);
    if (!oldest.window.isDestroyed()) oldest.window.destroy();
  }
}

async function waitForPageCondition(window, expression, timeout = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await evaluatePage(window, `Boolean(${expression})`, Math.min(20000, timeout - (Date.now() - startedAt)))) return;
    await sleep(150);
  }
  throw new Error('等待数据服务响应超时');
}

function pageHostname(window) {
  try { return new URL(window.webContents.getURL()).hostname; }
  catch { return ''; }
}

async function waitForQuoteOrLogin(window, timeout = 30000) {
  const startedAt = Date.now();
  let refreshed = false;
  let lastWakeAt = 0;
  const quoteSelector = `document.querySelector(
    '[class*=low_buy_price] img, img[class*=low_buy_price], [class*=low_buy_price][style*=background], [class*=price] canvas'
  )`;
  while (Date.now() - startedAt < timeout) {
    if (pageHostname(window) === 'login.che300.com') return 'login';
    try {
      const phase = await evaluatePage(window, `(() => {
        const text = document.body?.innerText || '';
        if (text.includes('当前账号估值频繁') && text.includes('1小时')) return 'rate-limited';
        return Boolean(${quoteSelector}) ? 'quote' : '';
      })()`, 1500, false);
      if (phase) return phase;
    } catch (error) {
      if (error.code !== 'REQUEST_TIMEOUT') throw error;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed - lastWakeAt > 1000) {
      lastWakeAt = elapsed;
      try {
        await evaluatePage(window, `(() => {
          const visible = (node) => node && node.getClientRects().length > 0;
          const goodTab = [...document.querySelectorAll('button, a, li, div, span')]
            .find((node) => visible(node) && node.textContent.trim() === '车况良好');
          goodTab?.click();
          document.querySelectorAll('img[loading=lazy]').forEach((image) => { image.loading = 'eager'; });
          const target = document.querySelector('[class*=low_buy_price], [class*=individual_low_sold_price], [class*=price]');
          if (target) target.scrollIntoView({ block: 'center', inline: 'center' });
          else window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight * 0.55));
          window.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('scroll'));
          return true;
        })()`, 3000, false);
      } catch {}
    }
    if (!refreshed && elapsed > 12000) {
      refreshed = true;
      try {
        window.webContents.reloadIgnoringCache();
        await waitForPageCondition(window, "document.readyState === 'complete'", 8000);
      } catch {}
    }
    await sleep(180);
  }
  if (pageHostname(window) === 'login.che300.com') return 'login';
  throw new Error('等待数据服务响应超时');
}

function validNumericId(value, label) {
  const text = String(value || '');
  if (!/^\d+$/.test(text)) throw new Error(`${label}无效`);
  return text;
}

async function prepareCatalog(category) {
  const index = CATEGORY_INDEX[category];
  if (!index) throw new Error('车辆类型无效');
  const window = await getWorkerWindow();
  if (!/^https:\/\/www\.che300\.com\/pinggu(?:\?|$)/.test(window.webContents.getURL())) {
    await loadChe300Page(window, 'https://www.che300.com/pinggu?city=3');
    workerCategory = '';
    workerBrandId = '';
  }
  if (workerCategory !== category) {
    await evaluatePage(window, `document.querySelector('.tab[data-index=${JSON.stringify(index)}]')?.click()`);
    workerCategory = category;
    workerBrandId = '';
  }
  await waitForPageCondition(window, "document.querySelectorAll('#select1_2 .list_1[id]').length > 0", 12000);
  return window;
}

async function scrapeBrands(category) {
  const window = await prepareCatalog(category);
  return evaluatePage(window, `
    (() => {
      const brands = [];
      let initial = '';
      document.querySelectorAll('#select1_2 .brand > .pinpailist').forEach((node) => {
        const text = node.textContent.trim();
        if (/^[A-Z]$/.test(text)) {
          initial = text;
          return;
        }
        if (!node.id) return;
        if (text) brands.push({ id: node.id, name: text, initial: initial || '#' });
      });
      return brands.filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
    })()
  `);
}

async function refreshBrands(category) {
  const items = await scrapeBrands(category);
  dataStore.replaceBrands(category, items);
  emitLog('品牌目录已写入本地数据库', { category, count: items.length });
  return items;
}

async function getBrands(category) {
  const local = dataStore.getBrands(category);
  if (local.length) {
    emitLog('从本地数据库读取品牌', { category, count: local.length });
    if (!dataStore.isFresh('brands:' + category, CATALOG_TTL)) {
      scheduleCatalogTask('brands:' + category, () => refreshBrands(category));
    }
    return local;
  }
  return queueCatalogTask('brands:' + category, () => refreshBrands(category));
}

async function scrapeSeries(category, brandId) {
  const id = validNumericId(brandId, '品牌ID');
  const window = await prepareCatalog(category);
  await evaluatePage(window, `
    (() => {
      const target = document.querySelector('#select1_2 [id=${JSON.stringify(id)}]');
      if (!target) throw new Error('未找到品牌');
      document.querySelectorAll('#select2_2 .list_2[id]').forEach((node) => node.remove());
      target.click();
    })()
  `);
  await waitForPageCondition(window, "document.querySelectorAll('#select2_2 .list_2[id]').length > 0", 12000);
  workerBrandId = id;
  return evaluatePage(window, `
    [...document.querySelectorAll('#select2_2 .list_2[id]')]
      .map((node) => ({ id: node.id, name: node.textContent.trim() }))
      .filter((item, index, all) => item.name && all.findIndex((other) => other.id === item.id) === index)
  `);
}

async function refreshSeries(category, brandId) {
  const id = validNumericId(brandId, '品牌ID');
  const items = await scrapeSeries(category, id);
  dataStore.replaceSeries(category, id, items);
  emitLog('车系列表已写入本地数据库', { brandId: id, count: items.length });
  return items;
}

async function getSeries(category, brandId) {
  const id = validNumericId(brandId, '品牌ID');
  const local = dataStore.getSeries(category, id);
  if (local.length) {
    emitLog('从本地数据库读取车系', { brandId: id, count: local.length });
    const scope = `series:${category}:${id}`;
    if (!dataStore.isFresh(scope, CATALOG_TTL)) scheduleCatalogTask(scope, () => refreshSeries(category, id));
    return local;
  }
  return queueCatalogTask(`series:${category}:${id}`, () => refreshSeries(category, id));
}

async function scrapeModels(category, brandId, seriesId) {
  const selectedBrandId = validNumericId(brandId, '品牌ID');
  const id = validNumericId(seriesId, '车系ID');
  const window = await prepareCatalog(category);
  if (workerBrandId !== selectedBrandId) {
    await scrapeSeries(category, selectedBrandId);
  }
  await evaluatePage(window, `
    (() => {
      const target = document.querySelector('#select2_2 [id=${JSON.stringify(id)}]');
      if (!target) throw new Error('未找到车系');
      document.querySelectorAll('#select3_2 .list_3[id]').forEach((node) => node.remove());
      target.click();
    })()
  `);
  await waitForPageCondition(window, "document.querySelectorAll('#select3_2 .list_3[id]').length > 0", 12000);
  return evaluatePage(window, `
    [...document.querySelectorAll('#select3_2 .list_3[id]')].map((node) => ({
      id: node.id,
      year: node.getAttribute('rel') || '',
      name: node.getAttribute('data-name') || node.querySelector('.model_name')?.textContent.trim() || '',
      catalogPrice: node.textContent.match(/(\\d+(?:\\.\\d+)?)\\s*万(?:元)?\\s*$/)?.[0].trim() || '',
      minRegistrationYear: node.getAttribute('data-min') || '',
      maxRegistrationYear: node.getAttribute('data-max') || ''
    })).filter((item) => item.id && item.name)
  `);
}

async function refreshModels(category, brandId, seriesId) {
  const selectedBrandId = validNumericId(brandId, '品牌ID');
  const id = validNumericId(seriesId, '车系ID');
  const items = await scrapeModels(category, selectedBrandId, id);
  dataStore.replaceModels(category, selectedBrandId, id, items);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('catalog:models-updated', {
    category, brandId: selectedBrandId, seriesId: id, items
  });
  emitLog('具体车型已写入本地数据库', { seriesId: id, count: items.length });
  return items;
}

async function getModels(category, brandId, seriesId) {
  const selectedBrandId = validNumericId(brandId, '品牌ID');
  const id = validNumericId(seriesId, '车系ID');
  const local = dataStore.getModels(category, selectedBrandId, id);
  if (local.length) {
    emitLog('从本地数据库读取具体车型', { seriesId: id, count: local.length });
    const scope = `models:${category}:${selectedBrandId}:${id}`;
    if (local.some(model => model.catalogPrice == null) || !dataStore.isFresh(scope, CATALOG_TTL)) {
      scheduleCatalogTask(scope, () => refreshModels(category, selectedBrandId, id));
    }
    return local;
  }
  return queueCatalogTask(`models:${category}:${selectedBrandId}:${id}`, () => refreshModels(category, selectedBrandId, id));
}

async function getRegions() {
  let local = dataStore.getRegions();
  if (!local.length) {
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'app', 'regions.json'), 'utf8'));
    dataStore.replaceRegions(bundled.provinces, bundled.fetchedAt || 0);
    local = dataStore.getRegions();
  }
  if (dataStore.isFresh('regions', CATALOG_TTL)) return local;
  if (regionRequest) return local.length ? local : regionRequest;
  regionRequest = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await session.fromPartition(CHE300_PARTITION).fetch(
        'https://www.che300.com/api/city/city_selector', { signal: controller.signal });
      if (!response.ok) throw new Error('地区接口返回 ' + response.status);
      const payload = await response.json();
      if (Number(payload.code) !== 2000 || !payload.data?.provinces) throw new Error('地区目录格式异常');
      const provinces = Object.values(payload.data.provinces).flat().map(province => ({
        id: validNumericId(province.prov_id, '省份ID'),
        name: String(province.prov_name),
        cities: (province.city_list || []).map(city => ({
          id: validNumericId(city.city_id, '城市ID'), name: String(city.city_name)
        }))
      }));
      if (!provinces.length || provinces.some(province => !province.cities.length)) throw new Error('地区目录不完整');
      dataStore.replaceRegions(provinces);
      local = provinces;
      emitLog('省市目录更新完成', { provinces: provinces.length, cities: provinces.reduce((sum, province) => sum + province.cities.length, 0) });
    } catch (error) {
      emitLog('省市目录更新失败，继续使用本地目录', { message: error.message });
    } finally {
      clearTimeout(timer);
    }
    return local;
  })().finally(() => { regionRequest = null; });
  return local.length ? local : regionRequest;
}

const vehiclePhotoDownloads = new Map();
const cachedPhotoUpgrades = new Map();
const vehiclePhotoRetryAfter = new Map();

function originalVehiclePhotoUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'seriespics.che300.com'
      && /^\?imageMogr2\/thumbnail\/[^&]+$/.test(url.search)) {
      url.search = '';
      return url.href;
    }
  } catch {}
  return value;
}

function loadVehiclePhoto(imageUrl) {
  const cached = dataStore.getVehiclePhoto(imageUrl);
  if (cached) return Promise.resolve(cached);
  if (vehiclePhotoDownloads.has(imageUrl)) return vehiclePhotoDownloads.get(imageUrl);
  if ((vehiclePhotoRetryAfter.get(imageUrl) || 0) > Date.now()) {
    return Promise.reject(new Error('车型图片稍后重试'));
  }
  const task = (async () => {
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.che300.com')) {
      throw new Error('车型图片地址不可用');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await session.fromPartition(CHE300_PARTITION).fetch(imageUrl, { signal: controller.signal });
      const type = (response.headers.get('content-type') || '').split(';')[0].trim();
      if (!response.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) {
        await response.body?.cancel();
        throw new Error('车辆图片格式不可用');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('车辆图片过大');
        chunks.push(Buffer.from(chunk));
      }
      if (!size) throw new Error('车辆图片为空');
      const photo = { imageUrl, imageData: 'data:' + type + ';base64,' + Buffer.concat(chunks).toString('base64') };
      dataStore.saveVehiclePhoto(photo);
      vehiclePhotoRetryAfter.delete(imageUrl);
      return photo;
    } catch (error) {
      vehiclePhotoRetryAfter.set(imageUrl, Date.now() + 60000);
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  })();
  vehiclePhotoDownloads.set(imageUrl, task);
  task.then(() => vehiclePhotoDownloads.delete(imageUrl), () => vehiclePhotoDownloads.delete(imageUrl));
  return task;
}

function upgradeCachedVehiclePhoto(key, vehicle, inputKey) {
  if (!vehicle?.imageUrl) return vehicle;
  const imageUrl = originalVehiclePhotoUrl(vehicle.imageUrl);
  if (imageUrl === vehicle.imageUrl) return vehicle;
  const stored = dataStore.getVehiclePhoto(imageUrl);
  if (stored) {
    dataStore.updateQuotePhoto(key, vehicle.imageUrl, stored);
    return { ...vehicle, ...stored };
  }
  if (!cachedPhotoUpgrades.has(key) && (vehiclePhotoRetryAfter.get(imageUrl) || 0) <= Date.now()) {
    const task = loadVehiclePhoto(imageUrl).then(photo => {
      dataStore.updateQuotePhoto(key, vehicle.imageUrl, photo);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vehicle:photo-updated', {
          inputKey, previousImageUrl: vehicle.imageUrl, vehicle: { ...vehicle, ...photo }
        });
      }
      emitLog('已将缓存车型图片更新为原图');
    }).catch(error => {
      emitLog('车型原图暂不可用，保留已有图片', { message: error.message });
    }).finally(() => cachedPhotoUpgrades.delete(key));
    cachedPhotoUpgrades.set(key, task);
  }
  return vehicle;
}

async function getVehiclePhoto(window) {
  const details = await evaluatePage(window, `(() => {
    const img = document.querySelector('.rh > img');
    const candidates = [];
    const add = value => { try { if (value) candidates.push(new URL(value, location.href).href); } catch {} };
    if (img) {
      for (const key of ['data-original', 'data-large', 'data-full', 'data-src']) add(img.getAttribute(key));
      const sources = [img, ...(img.closest('picture')?.querySelectorAll('source') || [])];
      const variants = sources.flatMap(node => (node.getAttribute('srcset') || '').split(',').map(item => {
        const [url, size = '1x'] = item.trim().split(/\\s+/);
        return { url, size: parseFloat(size) || 1 };
      }));
      variants.sort((a, b) => b.size - a.size).forEach(item => add(item.url));
      add(img.currentSrc);
      add(img.src);
    }
    return { name: document.querySelector('.rh h1')?.textContent.trim() || '', candidates: [...new Set(candidates)] };
  })()`);
  const urls = details.candidates.filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.che300.com'); }
    catch { return false; }
  });
  const vehicle = { name: details.name, imageUrl: urls.at(-1) || '', imageData: '' };
  if (!urls.length) return vehicle;
  const attempts = [...new Set([originalVehiclePhotoUrl(urls[0]), urls.at(-1)])];
  for (const imageUrl of attempts) {
    try {
      Object.assign(vehicle, await loadVehiclePhoto(imageUrl));
      emitLog('已获取并缓存车型参考图片');
      break;
    } catch (error) {
      emitLog('车型图片候选加载失败', { message: error.message });
    }
  }
  return vehicle;
}

function initializeDataStore() {
  const directory = resolveDataDirectory({ packaged: app.isPackaged, platform: process.platform,
    executable: app.getPath('exe'), projectRoot: __dirname,
    portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR });
  const bundledDatabase = path.join(__dirname, 'app', 'catalog-seed.sqlite');
  const databaseFile = initializePortableDatabase(directory,
    path.join(app.getPath('userData'), 'valuation.sqlite'), bundledDatabase);
  dataStore = new DataStore(databaseFile);
  runtimeLogFile = path.join(directory, 'runtime.log');
  try {
    const oldQuotes = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'quote-cache.json'), 'utf8'));
    dataStore.migrateQuotes(oldQuotes);
  } catch {}
  try {
    const oldRegions = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'regions.json'), 'utf8'));
    if (!dataStore.getRegions().length && oldRegions.provinces?.length) {
      dataStore.replaceRegions(oldRegions.provinces, oldRegions.fetchedAt || 0);
    }
  } catch {}
  emitLog('便携数据库已就绪', { file: databaseFile });
}

function warmCatalog() {
  const category = 'passenger';
  if (!dataStore.getBrands(category).length || !dataStore.isFresh('brands:' + category, CATALOG_TTL)) {
    scheduleCatalogTask('brands:' + category, () => refreshBrands(category));
  }
  getRegions().catch(error => emitLog('后台地区更新失败', { message: error.message }));
}

async function estimateVehicle(input, scope) {
  scope.check();
  const provinceId = validNumericId(input.provinceId, '省份ID');
  const cityId = validNumericId(input.cityId, '城市ID');
  const modelId = validNumericId(input.modelId, '车型ID');
  const registration = String(input.registration || '');
  const mileage = Number(input.mileage);
  const registrationMatch = registration.match(/^(\d{4})-(\d{1,2})$/);
  const registrationMonth = Number(registrationMatch?.[2]);
  if (!registrationMatch || registrationMonth < 1 || registrationMonth > 12) throw new Error('首次上牌时间无效');
  if (!Number.isFinite(mileage) || mileage <= 0 || mileage > 100) throw new Error('行驶里程无效');

  const registrationText = `${registrationMatch[1]}-${registrationMonth}`;
  const mileageText = String(mileage).replace(/\.0+$/, '');
  const key = [provinceId, cityId, modelId, registrationText, mileageText].join(':');
  const cached = dataStore.getQuote(key);
  emitLog('估值参数已整理', { provinceId, cityId, modelId, registration: registrationText, mileage: mileageText });
  if (!input.forceRefresh && cached && cached.vehicle && cached.priceRuleVersion === 6 && cached.prices?.good?.high
    && Date.now() - cached.fetchedAt < CACHE_TTL) {
    emitLog('命中本地报价缓存');
    return { ok: true, cached: true, ...cached };
  }

  const url = `https://www.che300.com/pinggu/v${provinceId}c${cityId}m${modelId}r${registrationText}g${mileageText}?click=homepage&rt=1`;
  const quoteStartedAt = Date.now();
  const window = await scope.wait(() => getQuoteWindow(scope));
  const windowReadyMs = Date.now() - quoteStartedAt;
  emitLog('加载车300报价页', { url });
  recordAccountRequest();
  await scope.wait(() => loadChe300Page(window, url, 20000));
  const documentReadyMs = Date.now() - quoteStartedAt;

  try {
    const pagePhase = await scope.wait(() => waitForQuoteOrLogin(window, 30000));
    if (pagePhase === 'rate-limited') {
      emitLog('当前账号触发估值频率限制');
      return { ok: false, code: 'RATE_LIMITED', message: '当前账号暂时不可估值' };
    }
    if (pagePhase === 'login') {
      sessionVerified = false;
      emitLog('报价请求需要登录，保留查询参数');
      return { ok: false, code: 'AUTH_REQUIRED', message: '需要登录数据服务', url, targetUrl: url };
    }
  } catch (error) {
    scope.check();
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && pageHostname(window) === 'login.che300.com') {
      sessionVerified = false;
      emitLog('报价页已进入登录入口，不再重试报价');
      return { ok: false, code: 'AUTH_REQUIRED', message: '需要登录数据服务', url, targetUrl: url };
    }
    if (error.code === 'REQUEST_TIMEOUT' || error.code === 'PAGE_CLOSED'
      || window.isDestroyed() || window.webContents.isDestroyed()) {
      emitLog('后台报价页面不可继续读取，结束本次尝试', {
        code: error.code || 'PAGE_CLOSED', message: error.message
      });
      throw error;
    }
    const pageState = await scope.wait(() => evaluatePage(window, `({
      url: location.href,
      hostname: location.hostname,
      hasLogout: document.body.innerText.includes('退出'),
      rateLimited: document.body.innerText.includes('当前账号估值频繁') && document.body.innerText.includes('1小时'),
      hasPhoneInput: [...document.querySelectorAll('input')].some((node) => node.getClientRects().length && (node.placeholder || '').includes('手机号')),
      dataImageCount: [...document.images].filter((image) => image.src.startsWith('data:image')).length,
      text: document.body.innerText.slice(0, 500)
    })`));
    const requiresLogin = pageState.hostname === 'login.che300.com' || pageState.hasPhoneInput;
    if (requiresLogin) {
      sessionVerified = false;
      emitLog('报价页要求登录', { url: pageState.url, hasPhoneInput: pageState.hasPhoneInput });
      return { ok: false, code: 'AUTH_REQUIRED', message: '需要登录数据服务', url, targetUrl: url };
    }
    if (pageState.rateLimited) {
      emitLog('当前账号触发估值频率限制');
      return { ok: false, code: 'RATE_LIMITED', message: '当前账号暂时不可估值' };
    }
    emitLog('报价页已打开，但未找到报价图片', {
      url: pageState.url,
      hasLogout: pageState.hasLogout,
      dataImageCount: pageState.dataImageCount
    });
    return { ok: false, code: 'QUOTE_NOT_FOUND', message: '报价页已打开，但没有识别到价格图片' };
  }

  const images = await scope.wait(() => evaluatePage(window, `
    (() => {
      const pngFrom = (node) => {
        if (!node) return '';
        const candidates = [];
        if (node.matches?.('img')) candidates.push(node.currentSrc, node.src);
        for (const attribute of [...(node.attributes || [])]) candidates.push(attribute.value);
        const background = getComputedStyle(node).backgroundImage || '';
        const backgroundMatch = background.match(/url\\(["']?(data:image\\/png[^"')]+)["']?\\)/i);
        if (backgroundMatch) candidates.push(backgroundMatch[1]);
        return candidates.find((value) => typeof value === 'string' && value.startsWith('data:image/png')) || '';
      };
      const sourceFromRoot = (root) => {
        const own = pngFrom(root);
        if (own) return own;
        for (const child of root.querySelectorAll?.('img, [style*=background]') || []) {
          const source = pngFrom(child);
          if (source) return source;
        }
        return '';
      };
      const source = (prefix) => {
        const roots = [...document.querySelectorAll('[class*=' + prefix + ']')];
        for (const root of roots) {
          const value = sourceFromRoot(root);
          if (value) return value;
        }
        return '';
      };
      const goodPriceImages = [...document.querySelectorAll('[class*=good][class*=price], [class*=good] [class*=price]')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { src: sourceFromRoot(node), left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        })
        .filter((item, index, all) => item.src && item.width > 0 && item.height > 0
          && all.findIndex((other) => other.src === item.src && Math.abs(other.left - item.left) < 2
            && Math.abs(other.top - item.top) < 2) === index);

      const rows = [];
      for (const item of goodPriceImages) {
        let row = rows.find((candidate) => Math.abs(candidate.top - item.top) < 8);
        if (!row) {
          row = { top: item.top, items: [] };
          rows.push(row);
        }
        row.items.push(item);
      }
      const boundaryRow = rows.filter((row) => row.items.length >= 4)
        .sort((left, right) => right.top - left.top)[0];
      const boundaries = boundaryRow
        ? boundaryRow.items.sort((left, right) => left.left - right.left)
        : [];
      return {
        excellentLow: source('excellent_low_buy_price'),
        goodLow: source('good_low_buy_price'),
        goodBoundaryLow: boundaries[0]?.src || '',
        goodBoundaryHigh: boundaries[2]?.src || '',
        goodFallbackHigh: source('good_individual_low_sold_price'),
        goodBoundaryCount: boundaries.length,
        normalLow: source('normal_low_buy_price'),
      };
    })()
  `));
  emitLog('已获取报价图片', {
    excellentLow: Boolean(images.excellentLow),
    goodLow: Boolean(images.goodLow),
    normalLow: Boolean(images.normalLow),
    goodBoundaryLow: Boolean(images.goodBoundaryLow),
    goodBoundaryHigh: Boolean(images.goodBoundaryHigh),
    goodFallbackHigh: Boolean(images.goodFallbackHigh),
    goodBoundaryCount: images.goodBoundaryCount
  });
  emitLog('报价加载分段耗时', {
    windowReadyMs, documentReadyMs,
    imageWaitAfterDocumentMs: Date.now() - quoteStartedAt - documentReadyMs,
    totalUntilImagesMs: Date.now() - quoteStartedAt
  });

  const decodeAvailablePrice = (name, source) => {
    if (!source) return null;
    try {
      const value = decodePriceImage(source).value;
      return Number.isFinite(value) ? value : null;
    } catch (error) {
      emitLog('报价图片解析失败，改用备用价格', { field: name, message: error.message });
      return null;
    }
  };
  const decodedPrices = {
    excellentLow: decodeAvailablePrice('excellentLow', images.excellentLow),
    goodLow: decodeAvailablePrice('goodLow', images.goodLow),
    goodBoundaryLow: decodeAvailablePrice('goodBoundaryLow', images.goodBoundaryLow),
    goodBoundaryHigh: decodeAvailablePrice('goodBoundaryHigh', images.goodBoundaryHigh),
    goodFallbackHigh: decodeAvailablePrice('goodFallbackHigh', images.goodFallbackHigh),
    normalLow: decodeAvailablePrice('normalLow', images.normalLow)
  };
  const purchaseLow = decodedPrices.goodBoundaryLow
    ?? decodedPrices.goodLow
    ?? [decodedPrices.normalLow, decodedPrices.excellentLow].find(Number.isFinite);
  const highCandidates = [
    decodedPrices.goodBoundaryHigh,
    decodedPrices.goodFallbackHigh,
    decodedPrices.excellentLow,
    decodedPrices.normalLow
  ].filter((value) => Number.isFinite(value) && value > purchaseLow);
  const purchaseHigh = highCandidates[0] ?? purchaseLow;
  emitLog('报价价格已整理', {
    low: purchaseLow,
    high: purchaseHigh,
    usedFallback: !Number.isFinite(decodedPrices.goodBoundaryHigh)
  });

  const result = {
    url,
    fetchedAt: Date.now(),
    priceRuleVersion: 6,
    prices: {
      excellent: {
        low: decodedPrices.excellentLow ?? purchaseLow
      },
      good: {
        low: purchaseLow,
        high: purchaseHigh
      },
      normal: {
        low: decodedPrices.normalLow ?? purchaseLow
      }
    }
  };

  try {
    result.vehicle = await scope.wait(() => getVehiclePhoto(window));
  } catch (error) {
    scope.check();
    result.vehicle = { name: '', imageUrl: '', imageData: '' };
    emitLog('未获取到车型图片，不影响报价', { message: error.message });
  }
  scope.check();
  dataStore.saveQuote(key, result);
  emitLog('报价图片解码完成', result.prices);
  sessionVerified = true;
  reportAuthState('authenticated');
  retainQuoteWindow(scope);
  return { ok: true, cached: false, ...result };
}

async function estimateWithLogin(input, scope) {
  scope.check();
  if (!accounts.some(account => account.id === currentAccountId && !account.deleting)) {
    return cachedQuoteForInput(input) || { ok: false, code: 'NO_ACCOUNT', message: '请先添加并登录账号' };
  }
  if (loginCompletion) {
    const login = await scope.wait(() => loginCompletion);
    if (!login?.authenticated) return { ok: false, code: 'LOGIN_CANCELLED' };
  }
  const activeAccount = accounts.find(account => account.id === currentAccountId && !account.deleting);
  const activeCookies = await scope.wait(() => session.fromPartition(activeAccount.partition).cookies.get({ url: 'https://www.che300.com/' }));
  activeAccount.hasSession = activeCookies.length > 0;
  if (!activeAccount.hasSession || activeAccount.status !== 'authenticated') {
    sessionVerified = false;
    if (!activeAccount.hasSession) activeAccount.status = 'signed-out';
    activeAccount.checkedAt = 0;
    publishAccounts();
    emitLog('当前账号登录状态未确认，直接展开登录入口', { status: activeAccount.status });
    const login = await scope.wait(() => openChe300Login());
    if (!login?.authenticated) return { ok: false, code: 'LOGIN_CANCELLED' };
  }
  reportAuthState('querying');
  const attempted = new Set();
  while (true) {
    const accountId = currentAccountId;
    let result;
    try {
      result = await estimateWithRetry(input, scope);
    } catch (error) {
      scope.check();
      const fallback = cachedQuoteForInput(input);
      if (fallback) { scheduleAccountMaintenance(accountId); return fallback; }
      throw error;
    }
    scope.check();
    if (result.ok) {
      if (!result.cached) scheduleAccountMaintenance(accountId);
      return result;
    }
    if (result.code === 'RATE_LIMITED') {
      markAccountRateLimited(accountId);
      attempted.add(accountId);
      const backup = await scope.wait(() => findReadyBackup(attempted));
      if (backup) {
        activateAccount(backup.id, true);
        scope.dispose();
        emitLog('当前账号进入冷却，切换备用账号继续估价', { account: backup.label });
        reportAuthState('querying');
        continue;
      }
      return cachedQuoteForInput(input) || result;
    }
    if (result.code !== 'AUTH_REQUIRED') {
      scheduleAccountMaintenance(accountId);
      return cachedQuoteForInput(input) || result;
    }

    sessionVerified = false;
    reportAuthState('expired');
    attempted.add(accountId);
    const backup = await scope.wait(() => findReadyBackup(attempted));
    if (backup) {
      activateAccount(backup.id, true);
      scope.dispose();
      emitLog('原账号登录失效，切换备用账号继续估价', { account: backup.label });
      reportAuthState('querying');
      continue;
    }
    const cached = cachedQuoteForInput(input);
    if (cached) return cached;

    emitLog('没有可用备用账号，完成授权后继续估值');
    const login = await scope.wait(() => openChe300Login(result.targetUrl || result.url));
    if (!login.authenticated) {
      return { ok: false, code: 'LOGIN_CANCELLED', message: '授权未完成，车辆信息已保留；可在右侧登录后继续。' };
    }
    reportAuthState('querying');
    scope.dispose();
    const retried = await estimateWithRetry(input, scope);
    if (retried.code === 'AUTH_REQUIRED') {
      sessionVerified = false;
      reportAuthState('expired');
    }
    scheduleAccountMaintenance(currentAccountId);
    return retried.ok ? retried : cachedQuoteForInput(input) || retried;
  }
}

async function estimateWithRetry(input, scope) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    scope.check();
    try {
      const result = await estimateVehicle(input, scope);
      if (result.code === 'RATE_LIMITED') return result;
      if (result.ok || result.code === 'AUTH_REQUIRED' || attempt === 1) return result;
      emitLog('估价请求未返回报价，重试一次', { code: result.code });
    } catch (error) {
      scope.check();
      if (attempt === 1 || /无效/.test(error.message || '')) throw error;
      emitLog('估价请求失败，重试一次', { message: error.message });
    }
    scope.dispose();
    await scope.wait(() => sleep(500));
  }
}

function submitEstimate(input) {
  const scope = quoteRequests.start();
  const requestedAt = Date.now();
  const cached = cachedQuoteForInput(input, false);
  const onlineInput = cached ? { ...input, forceRefresh: true } : input;
  const task = serializeBrowserWork(async () => {
    try {
      scope.check();
      emitLog('开始最新估价请求', { requestId: scope.id, queueMs: Date.now() - requestedAt });
      const result = await scope.wait(() => estimateWithLogin(onlineInput, scope));
      return { ...result, requestId: scope.id };
    } catch (error) {
      if (scope.cancelled || error.code === 'SUPERSEDED') {
        emitLog('旧估价请求已取消', { requestId: scope.id });
        return { ok: false, code: 'SUPERSEDED', requestId: scope.id };
      }
      emitLog('本次估价请求失败', { requestId: scope.id, message: error.message });
      return { ok: false, code: 'REQUEST_FAILED', requestId: scope.id };
    } finally {
      emitLog('估价请求结束', { requestId: scope.id, elapsedMs: Date.now() - requestedAt });
      quoteRequests.finish(scope);
    }
  });
  if (!cached) return task;
  emitLog('先展示已有报价，后台强制更新', { ageMs: Date.now() - cached.fetchedAt });
  task.then(result => {
    if (!scope.cancelled && result.ok && !result.cached && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('che300:quote-updated', {
        requestId: scope.id, inputKey: JSON.stringify(input), result
      });
      emitLog('后台报价已更新');
    }
  }).catch(error => emitLog('后台报价更新失败，保留已有报价', { message: error.message }));
  return Promise.resolve({ ...cached, requestId: scope.id, refreshing: true });
}

function normalizeCachedQuote(cached) {
  if (!cached?.prices) return null;
  const values = [
    cached.prices?.good?.low,
    cached.prices?.good?.high,
    cached.prices?.excellent?.low,
    cached.prices?.normal?.low
  ].filter(Number.isFinite);
  if (!values.length) return null;
  const low = Number.isFinite(cached.prices?.good?.low)
    ? cached.prices.good.low
    : Math.min(...values);
  const high = Number.isFinite(cached.prices?.good?.high) && cached.prices.good.high > low
    ? cached.prices.good.high
    : values.filter((value) => value > low).sort((left, right) => left - right)[0];
  if (!Number.isFinite(high)) return null;
  return {
    ...cached,
    priceRuleVersion: 6,
    prices: {
      excellent: { low: cached.prices?.excellent?.low ?? high },
      good: { low, high },
      normal: { low: cached.prices?.normal?.low ?? low }
    }
  };
}

function cachedQuoteForInput(input, logFallback = true) {
  const date = String(input.registration || '').match(/^(\d{4})-(\d{1,2})$/);
  const mileage = Number(input.mileage);
  if (!date || Number(date[2]) < 1 || Number(date[2]) > 12 || !Number.isFinite(mileage) || mileage <= 0 || mileage > 100
      || ![input.provinceId, input.cityId, input.modelId].every(id => /^\d+$/.test(String(id)))) return null;
  const key = [input.provinceId, input.cityId, input.modelId, date[1] + '-' + Number(date[2]), String(mileage)].join(':');
  let cacheKey = key;
  let cached = normalizeCachedQuote(dataStore.getQuote(key));
  let nearest = false;
  if (!cached && logFallback) {
    const historical = dataStore.getLatestQuoteForModel(String(input.modelId));
    if (historical) {
      cacheKey = historical.key;
      cached = normalizeCachedQuote(historical.quote);
      nearest = Boolean(cached);
    }
  }
  if (!cached) return null;
  cached.vehicle = upgradeCachedVehiclePhoto(cacheKey, cached.vehicle, JSON.stringify(input));
  if (logFallback) emitLog(nearest ? '在线报价暂不可用，使用同车型历史报价' : '在线报价暂不可用，使用已有数据库报价');
  return { ...cached, ok: true, cached: true, historicalFallback: nearest };
}

function initializeAccounts() {
  dataStore.db.exec(`CREATE TABLE IF NOT EXISTS service_accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, partition TEXT NOT NULL UNIQUE,
    request_count INTEGER NOT NULL DEFAULT 0, total_requests INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0
  )`);
  const accountColumns = dataStore.db.prepare('PRAGMA table_info(service_accounts)').all();
  if (!accountColumns.some(column => column.name === 'cooldown_until')) {
    dataStore.db.exec('ALTER TABLE service_accounts ADD COLUMN cooldown_until INTEGER NOT NULL DEFAULT 0');
  }
  if (!accountColumns.some(column => column.name === 'phone_mask')) {
    dataStore.db.exec("ALTER TABLE service_accounts ADD COLUMN phone_mask TEXT NOT NULL DEFAULT ''");
  }
  if (!dataStore.timestamp('service-accounts:initialized')) {
    dataStore.transaction(() => {
      if (!dataStore.db.prepare('SELECT id FROM service_accounts LIMIT 1').get()) {
        dataStore.db.prepare('INSERT INTO service_accounts(id, label, partition, active) VALUES (?, ?, ?, 1)')
          .run('default', '账号 1', 'persist:che300');
      }
      dataStore.touch('service-accounts:initialized');
    });
  }
  accounts = dataStore.db.prepare('SELECT * FROM service_accounts ORDER BY rowid').all().map(row => ({
    id: row.id, label: row.label, partition: row.partition,
    phoneMask: row.phone_mask || '',
    requests: row.request_count, totalRequests: row.total_requests, active: Boolean(row.active),
    cooldownUntil: Number(row.cooldown_until) || 0,
    status: Number(row.cooldown_until) > Date.now() ? 'cooldown' : 'unchecked',
    checkedAt: 0, lastCheckAt: 0, hasSession: false, maintenanceQueued: false
  }));
  const active = accounts.find(account => account.active) || accounts[0];
  currentAccountId = active?.id || '';
  CHE300_PARTITION = active?.partition || 'persist:valuation-unassigned';
}

function accountSnapshot() {
  for (const account of accounts) {
    if (account.cooldownUntil && account.cooldownUntil <= Date.now()) {
      account.cooldownUntil = 0;
      if (account.status === 'cooldown') account.status = 'unchecked';
      dataStore.db.prepare('UPDATE service_accounts SET cooldown_until = 0 WHERE id = ?').run(account.id);
    }
  }
  return accounts.map(account => ({
    id: account.id, label: account.label, active: account.id === currentAccountId,
    phoneMask: account.phoneMask || '',
    requests: account.requests, totalRequests: account.totalRequests,
    status: account.status, cooldownUntil: account.cooldownUntil || 0,
    hasSession: account.hasSession, loginInProgress: Boolean(account.loginInProgress)
  }));
}

function publishAccounts() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('che300:accounts', accountSnapshot());
}

async function listAccounts() {
  for (const account of accounts) {
    const cookies = await session.fromPartition(account.partition).cookies.get({ url: 'https://www.che300.com/' });
    account.hasSession = cookies.length > 0;
    if (!account.hasSession && account.status === 'unchecked') account.status = 'signed-out';
    else if (account.hasSession && account.status === 'unchecked') account.status = 'checking';
  }
  return accountSnapshot();
}

function activateAccount(id, resetRound = false) {
  const account = accounts.find(item => item.id === id);
  if (!account || account.deleting) throw new Error('账号不存在');
  if (resetRound) account.requests = 0;
  currentAccountId = id;
  CHE300_PARTITION = account.partition;
  sessionVerified = account.status === 'authenticated';
  dataStore.transaction(() => {
    dataStore.db.exec('UPDATE service_accounts SET active = 0');
    dataStore.db.prepare('UPDATE service_accounts SET active = 1, request_count = ? WHERE id = ?').run(account.requests, id);
  });
  publishAccounts();
  return accountSnapshot();
}

function addAccount() {
  const id = require('node:crypto').randomUUID();
  const account = {
    id, label: '账号 ' + (Math.max(0, ...accounts.map(item => Number(item.label.match(/\d+$/)?.[0]) || 0)) + 1), partition: 'persist:che300-account-' + id,
    phoneMask: '',
    requests: 0, totalRequests: 0, status: 'signed-out', checkedAt: 0, lastCheckAt: 0,
    hasSession: false, maintenanceQueued: false
  };
  dataStore.db.prepare('INSERT INTO service_accounts(id, label, partition) VALUES (?, ?, ?)').run(id, account.label, account.partition);
  accounts.push(account);
  if (!accounts.some(item => item.id === currentAccountId)) activateAccount(id);
  publishAccounts();
  return { id, label: account.label };
}

async function loginAccount(id) {
  const previousId = currentAccountId;
  activateAccount(id);
  try { return await openChe300Login(); }
  finally { if (accounts.some(item => item.id === previousId && !item.deleting)) activateAccount(previousId); }
}

async function deleteAccount(id) {
  const account = accounts.find(item => item.id === id);
  if (!account) return accountSnapshot();
  if (quoteRequests.current || loginCompletion || account.checkPromise || account.deleting
    || accounts.some(item => item.loginInProgress)) {
    throw new Error('账号正在使用或验证，请稍后再删除');
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: '删除账号', message: `确定删除${account.label}？`,
    detail: '将清除该账号在本机保存的登录信息，需要重新添加并登录才能再次使用。车型、图片和报价缓存不会删除。',
    buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (response !== 1) return accountSnapshot();
  if (quoteRequests.current || loginCompletion || account.checkPromise
    || accounts.some(item => item.loginInProgress)) {
    throw new Error('账号正在使用或验证，请稍后再删除');
  }
  account.deleting = true;
  account.validationVersion = (account.validationVersion || 0) + 1;
  account.status = 'deleting';
  account.checkedAt = 0;
  const targetSession = session.fromPartition(account.partition);
  try {
    if (currentAccountId === id) {
      const remaining = accounts.filter(item => item.id !== id && !item.deleting);
      const next = remaining.find(item => item.status === 'authenticated') || remaining[0];
      if (next) activateAccount(next.id);
      else {
        currentAccountId = '';
        CHE300_PARTITION = 'persist:valuation-unassigned';
        sessionVerified = false;
        dataStore.db.exec('UPDATE service_accounts SET active = 0');
      }
    }
    publishAccounts();
    const idle = idleQuoteWindows.get(account.partition);
    if (idle) {
      clearTimeout(idle.timer);
      idleQuoteWindows.delete(account.partition);
      if (!idle.window.isDestroyed()) idle.window.destroy();
    }
    if (workerWindow && !workerWindow.isDestroyed() && workerWindow.webContents.session === targetSession) {
      discardWorkerWindow();
    }
    await targetSession.closeAllConnections();
    await targetSession.clearStorageData();
    await targetSession.clearCache();
    await targetSession.cookies.flushStore();
    removeAccountSessionSnapshot(id);
    dataStore.db.prepare('DELETE FROM service_accounts WHERE id = ?').run(id);
    accounts = accounts.filter(item => item.id !== id);
    emitLog('账号及本地登录信息已删除', { account: account.label });
    publishAccounts();
    return accountSnapshot();
  } catch (error) {
    account.deleting = false;
    account.status = 'unknown';
    account.hasSession = false;
    publishAccounts();
    emitLog('账号删除未完成，可稍后重试', { account: account.label, message: error.message });
    throw error;
  }
}

function recordAccountRequest() {
  const account = accounts.find(item => item.id === currentAccountId);
  account.requests += 1;
  account.totalRequests += 1;
  dataStore.db.prepare('UPDATE service_accounts SET request_count = ?, total_requests = ? WHERE id = ?')
    .run(account.requests, account.totalRequests, account.id);
  emitLog('账号发起估价请求', { account: account.label });
  publishAccounts();
}

function markAccountRateLimited(id) {
  const account = accounts.find(item => item.id === id);
  if (!account) return;
  account.cooldownUntil = Date.now() + 60 * 60 * 1000;
  account.status = 'cooldown';
  dataStore.db.prepare('UPDATE service_accounts SET cooldown_until = ? WHERE id = ?')
    .run(account.cooldownUntil, account.id);
  emitLog('账号进入一小时估值冷却', { account: account.label });
  publishAccounts();
}

async function probeAccount(account, budget = 10000, force = false) {
  if (account.deleting || !accounts.includes(account)) return false;
  if (account.cooldownUntil > Date.now()) {
    account.status = 'cooldown';
    publishAccounts();
    return false;
  }
  if (account.loginInProgress) return account.status === 'authenticated';
  if (account.checkPromise) return account.checkPromise;
  if (!force) {
    if (account.status === 'authenticated' && Date.now() - account.checkedAt < ACCOUNT_CHECK_TTL) return true;
    if (account.status === 'expired' || account.status === 'login-required') return false;
    if (account.lastCheckAt && Date.now() - account.lastCheckAt < ACCOUNT_CHECK_TTL) return false;
  }
  const version = account.validationVersion || 0;
  const isCurrent = () => (account.validationVersion || 0) === version && !account.loginInProgress;
  const work = async () => {
    let probe;
    account.lastCheckAt = Date.now();
    const deadline = Date.now() + budget;
    try {
      const cookies = await session.fromPartition(account.partition).cookies.get({ url: 'https://www.che300.com/' });
      if (!isCurrent()) return account.status === 'authenticated';
      account.hasSession = cookies.length > 0;
      if (!account.hasSession) {
        account.status = 'signed-out';
        account.checkedAt = 0;
        publishAccounts();
        return false;
      }
      account.status = 'checking';
      publishAccounts();
      probe = new BrowserWindow({ show: false, webPreferences: {
        partition: account.partition, backgroundThrottling: false, paintWhenInitiallyHidden: true,
        contextIsolation: true, nodeIntegration: false, sandbox: true
      } });
      await loadChe300Page(probe, 'https://www.che300.com/pinggu?city=3&_session_check=' + Date.now(), Math.min(12000, budget));
      await waitForPageCondition(probe,
        "location.hostname === 'login.che300.com' || document.body.innerText.includes('退出') || [...document.querySelectorAll('input')].some(node => node.getClientRects().length && (node.placeholder || '').includes('手机号'))", Math.max(1, deadline - Date.now()));
      const state = await loginPageState(probe);
      if (!isCurrent()) return account.status === 'authenticated';
      const verified = Boolean(state && new URL(state.url).hostname === 'www.che300.com' && state.hasLogout && !state.hasPhoneInput);
      account.status = verified
        ? (account.cooldownUntil > Date.now() ? 'cooldown' : 'authenticated')
        : 'expired';
      account.checkedAt = verified ? Date.now() : 0;
      return verified;
    } catch (error) {
      if (isCurrent()) { account.status = 'unknown'; account.checkedAt = 0; }
      emitLog('账号状态暂时无法确认', { account: account.label, message: error.message });
      return false;
    } finally {
      if (probe && !probe.isDestroyed()) probe.destroy();
      if (isCurrent() && account.id === currentAccountId) sessionVerified = account.status === 'authenticated';
      publishAccounts();
    }
  };
  account.checkPromise = work().finally(() => { account.checkPromise = null; });
  return account.checkPromise;
}

async function refreshAccount(id) {
  const account = accounts.find(item => item.id === id);
  if (!account || account.deleting) return accountSnapshot();
  if (account.loginInProgress) return accountSnapshot();
  emitLog('主动验证账号登录态', { account: account.label });
  await probeAccount(account, 12000, true);
  return accountSnapshot();
}

async function verifyStartupAccounts() {
  const ordered = [...accounts].sort((a, b) => Number(b.id === currentAccountId) - Number(a.id === currentAccountId));
  for (const account of ordered) if (!account.loginInProgress) account.status = 'checking';
  publishAccounts();
  let next = 0;
  const worker = async () => {
    while (next < ordered.length) {
      const account = ordered[next++];
      const startedAt = Date.now();
      await refreshAccount(account.id);
      emitLog('启动登录验证完成', { account: account.label, status: account.status, elapsedMs: Date.now() - startedAt });
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, ordered.length) }, worker));
}

async function findReadyBackup(excluded = new Set([currentAccountId])) {
  const deadline = Date.now() + 12000;
  const start = accounts.findIndex(account => account.id === currentAccountId);
  for (let offset = 1; offset <= accounts.length; offset += 1) {
    const candidate = accounts[(start + offset) % accounts.length];
    if (!candidate || candidate.deleting || excluded.has(candidate.id) || candidate.cooldownUntil > Date.now()) continue;
    if (Date.now() >= deadline) break;
    if (await probeAccount(candidate, deadline - Date.now())) return candidate;
  }
  return null;
}

function scheduleAccountMaintenance(id) {
  const account = accounts.find(item => item.id === id);
  if (!account || account.maintenanceQueued || (account.requests !== ACCOUNT_PREFLIGHT_AT && account.requests < ACCOUNT_ROTATION_LIMIT)) return;
  account.maintenanceQueued = true;
  Promise.resolve().then(async () => {
    if (currentAccountId !== id) return;
    const backup = await findReadyBackup();
    if (account.requests >= ACCOUNT_ROTATION_LIMIT && backup) {
      await serializeBrowserWork(() => {
        if (currentAccountId !== id || backup.status !== 'authenticated' || backup.deleting || !accounts.includes(backup)) return;
        activateAccount(backup.id, true);
        emitLog('下一次估价使用备用账号', { from: account.label, to: backup.label });
      });
    } else {
      emitLog(backup ? '备用账号登录预检查通过' : '暂无可切换的已验证备用账号', { account: account.label, backup: backup?.label });
    }
  }).catch(error => emitLog('账号轮换检查失败', { message: error.message }))
    .finally(() => { account.maintenanceQueued = false; });
}

async function getSessionState() {
  const che300Session = session.fromPartition(CHE300_PARTITION);
  const cookies = await che300Session.cookies.get({ url: 'https://www.che300.com/' });
  return {
    hasSession: cookies.length > 0,
    authenticated: sessionVerified,
    cookieCount: cookies.length
  };
}

app.whenReady().then(async () => {
  initializeDataStore();
  initializeAccounts();
  const sessionRestore = restoreAccountSessions().catch(error => {
    emitLog('恢复账号登录状态失败', { message: error.message });
  });
  await Promise.race([
    sessionRestore,
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);
  selfTest();
  ipcMain.handle('app:logs', () => logHistory);
  ipcMain.handle('catalog:regions', getRegions);
  ipcMain.handle('che300:open-login', (_event, targetUrl) => serializeBrowserWork(() => openChe300Login(targetUrl)));
  ipcMain.on('login-panel:bounds', (event, bounds) => {
    if (event.sender === mainWindow?.webContents) loginWindow?.setBounds(bounds);
  });
  ipcMain.on('login-panel:close', (event) => {
    if (event.sender === mainWindow?.webContents) loginWindow?.close();
  });
  ipcMain.on('login-panel:retry', (event) => {
    if (event.sender === mainWindow?.webContents) {
      loginWindow?.retry()?.catch(error => emitLog('授权重试失败', { message: error.message }));
    }
  });
  ipcMain.on('login-panel:document-state', (event, state) => {
    if (!loginWindow || event.sender !== loginWindow.webContents || event.senderFrame !== event.sender.mainFrame) return;
    loginWindow.updateFormState(state);
    const phone = String(state?.phone || '').replace(/\D/g, '').slice(0, 11);
    if (/^1\d{10}$/.test(phone)) loginPhoneMask = phone.slice(0, 3) + '****' + phone.slice(-4);
    const account = accounts.find(item => item.id === currentAccountId);
    if (account?.loginInProgress && !loginAuthenticated) {
      const phase = state?.loginPhase;
      const status = phase === 'syncing' ? 'syncing' : phase === 'submitting' || phase === 'challenge' ? 'authenticating' : 'login-required';
      if (account.status !== status) { account.status = status; publishAccounts(); }
    }
  });
  ipcMain.on('login-panel:sms-start', (event) => {
    if (loginWindow && event.sender === loginWindow.webContents && event.senderFrame === event.sender.mainFrame) {
      emitLog('用户点击原始短信发送控件，等待发送结果');
    }
  });
  ipcMain.on('login-panel:diagnostic', (event, data) => {
    if (!loginWindow || event.sender !== loginWindow.webContents || event.senderFrame !== event.sender.mainFrame) return;
    const sanitize = value => String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]')
      .replace(/车\s*300|che300/gi, '数据服务').replace(/\d{6,}/g, '[已隐藏]')
      .replace(/[A-Za-z0-9_=-]{32,}/g, '[已隐藏]').slice(0, 240);
    emitLog('登录请求诊断', { phase: sanitize(data?.phase), path: sanitize(data?.path),
      status: Number(data?.status) || 0, code: sanitize(data?.code),
      message: sanitize(data?.message), elapsedMs: Math.max(0, Number(data?.elapsedMs) || 0) });
  });
  ipcMain.handle('che300:session-state', getSessionState);
  ipcMain.handle('che300:accounts', listAccounts);
  ipcMain.handle('che300:refresh-account', (event, id) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('不允许的账号操作');
    return refreshAccount(id);
  });
  ipcMain.handle('che300:add-account', () => serializeBrowserWork(addAccount));
  ipcMain.handle('che300:delete-account', (event, id) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('不允许的账号操作');
    return serializeBrowserWork(() => deleteAccount(id));
  });
  ipcMain.handle('che300:login-account', (_event, id) => serializeBrowserWork(() => loginAccount(id)));
  ipcMain.handle('che300:select-account', (_event, id) => serializeBrowserWork(() => activateAccount(id)));
  ipcMain.handle('catalog:brands', (_event, category) => runLogged('请求品牌目录', { category }, () => getBrands(category)));
  ipcMain.handle('catalog:series', (_event, input) => runLogged('请求车系列表', { brandId: input.brandId }, () => getSeries(input.category, input.brandId)));
  ipcMain.handle('catalog:models', (_event, input) => runLogged('请求具体车型', { seriesId: input.seriesId }, () => getModels(input.category, input.brandId, input.seriesId)));
  ipcMain.handle('che300:estimate', (_event, input) => submitEstimate(input));
  ipcMain.on('che300:cancel-estimate', () => quoteRequests.cancel());
  createMainWindow();
  setTimeout(warmCatalog, 250);
  setTimeout(() => scheduleCatalogTask('catalog:warm', () => prepareCatalog('passenger')), 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
