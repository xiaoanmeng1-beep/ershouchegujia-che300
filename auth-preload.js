const { ipcRenderer, webFrame } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
  if (location.hostname !== 'login.che300.com') return;
  webFrame.executeJavaScript(`(() => {
    const report = (message) => document.dispatchEvent(new CustomEvent('valuation-auth-network', {
      detail: JSON.stringify({ phase: 'page-error', message: String(message).slice(0, 240) })
    }));
    window.addEventListener('error', event => report(event.message || 'Resource load failed'), true);
    window.addEventListener('unhandledrejection', event => report(event.reason?.message || 'Unhandled rejection'));
    const inspect = () => {
      const send = message => document.dispatchEvent(new CustomEvent('valuation-auth-network', {
        detail: JSON.stringify({ phase: 'sdk-runtime', message: JSON.stringify(message) })
      }));
      send({ sdk: typeof window._dx, module: typeof module, exports: typeof exports, define: typeof define, require: typeof require });
      for (const script of document.scripts) {
        if (!/dingxiang|captcha/i.test(script.src)) continue;
        send({ path: new URL(script.src).pathname, type: script.type, async: script.async, defer: script.defer });
      }
    };
    inspect();
    setTimeout(inspect, 4000);
  })()`).catch(() => {});
});

const safeAuthText = value => String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]')
  .replace(/车\s*300|che300/gi, '数据服务').replace(/\d{6,}/g, '[已隐藏]')
  .replace(/[A-Za-z0-9_=-]{32,}/g, '[已隐藏]').slice(0, 240);

document.addEventListener('valuation-auth-network', event => {
  try {
    const data = JSON.parse(event.detail);
    if (data.phase === 'response' && (Number(data.code) === 2001 || data.challenge === true)) {
      document.dispatchEvent(new Event('valuation-auth-challenge'));
      setTimeout(() => {
        const selector = '[class*="captcha"], [id*="captcha"], iframe';
        const roots = [...document.querySelectorAll(selector)].filter(node => !node.parentElement?.closest(selector));
        for (const node of roots.slice(0, 8)) {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          ipcRenderer.send('login-panel:diagnostic', { phase: 'challenge-layout', message: JSON.stringify({
            tag: node.tagName, id: node.id, className: String(node.className).slice(0, 80),
            display: style.display, visibility: style.visibility,
            width: Math.round(rect.width), height: Math.round(rect.height)
          }) });
        }
      }, 500);
    }
    ipcRenderer.send('login-panel:diagnostic', {
      phase: safeAuthText(data.phase), path: safeAuthText(data.path),
      status: Number(data.status) || 0, code: safeAuthText(data.code),
      message: safeAuthText(data.message), elapsedMs: Math.max(0, Number(data.elapsedMs) || 0)
    });
  } catch {}
});

function observeAuthRequests() {
  if (window.__valuationAuthObserved) return;
  window.__valuationAuthObserved = true;
  const meta = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const report = detail => {
    try { document.dispatchEvent(new CustomEvent('valuation-auth-network', { detail: JSON.stringify(detail) })); } catch {}
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    meta.delete(this);
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin === location.origin && ['/api/fe/v1/common/send-sms', '/api/fe/v1/auth/send-sms', '/api/fe/v1/auth/login'].includes(parsed.pathname)) {
        meta.set(this, { path: parsed.pathname });
      }
    } catch {}
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    const item = meta.get(this);
    if (item) {
      const started = Date.now();
      report({ phase: 'request', path: item.path });
      this.addEventListener('loadend', () => {
        let body = {};
        try { body = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); } catch {}
        report({ phase: 'response', path: item.path, status: this.status,
          code: typeof body?.code === 'number' ? body.code : '',
          message: typeof body?.msg === 'string' ? body.msg : '',
          challenge: body?.data?.need_slider_check === true, elapsedMs: Date.now() - started });
      }, { once: true });
    }
    return send.apply(this, arguments);
  };
}

// No credentials are read, forwarded or saved: the user operates the real form.
window.addEventListener('DOMContentLoaded', () => {
  if (location.hostname !== 'login.che300.com') {
    ipcRenderer.send('login-panel:document-state', { ready: false });
    return;
  }
  webFrame.executeJavaScript('(' + observeAuthRequests.toString() + ')()')
    .catch(() => ipcRenderer.send('login-panel:diagnostic', { phase: 'observer-unavailable' }));
  const style = document.createElement('style');
  style.textContent = `
    html, body { min-width: 0 !important; width: 100% !important; margin: 0 !important; background: #fff !important; overflow: hidden !important; }
    body * { visibility: hidden !important; }
    .tel-with-code, .tel-with-code *, .login-btn,
    .dx-popup-sms, .dx-popup-sms *, .dx-popup, .dx-popup *,
    [class*="dx_captcha"], [class*="dx_captcha"] *,
    [class*="dx-captcha"], [class*="dx-captcha"] *,
    [id*="dx-captcha"], [id*="dx-captcha"] *,
    .valuation-safe-message, .valuation-safe-message * { visibility: visible !important; }
    .tel-with-code { position: fixed !important; top: 14px !important; left: 14px !important; right: 14px !important; width: auto !important; margin: 0 !important; transform: none !important; }
    .tel-with-code .form-item { display: flex !important; width: 100% !important; height: 42px !important; margin: 0 0 12px !important; padding: 0 !important; }
    .tel-with-code .form-input { box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; height: 42px !important; padding: 0 10px !important; margin: 0 !important; border: 1px solid #dedede !important; border-radius: 5px !important; font: 14px "PingFang SC", sans-serif !important; text-indent: 0 !important; color: #27292d !important; background: #fff !important; }
    .tel-with-code .verification-code-input { width: 0 !important; flex: 1 1 0 !important; margin-right: 8px !important; }
    .tel-with-code .verification-code-btn { box-sizing: border-box !important; flex: 0 0 100px !important; height: 42px !important; padding: 0 !important; margin: 0 !important; display: flex !important; justify-content: center !important; align-items: center !important; border: 1px solid #b9d6f6 !important; border-radius: 5px !important; font: 12px "PingFang SC", sans-serif !important; color: #176fc7 !important; background: #f4f9ff !important; cursor: pointer !important; }
    .login-btn { position: fixed !important; top: 124px !important; left: 14px !important; right: 14px !important; width: auto !important; height: 42px !important; padding: 0 !important; margin: 0 !important; border-radius: 5px !important; display: flex !important; align-items: center !important; justify-content: center !important; background: #2f8df4 !important; color: #fff !important; font: 14px "PingFang SC", sans-serif !important; cursor: pointer !important; }
    .login-btn.valuation-login-pending { font-size: 0 !important; cursor: wait !important; }
    .login-btn.valuation-login-pending::after { content: ''; width: 18px; height: 18px; border: 2px solid #ffffff66; border-top-color: #fff; border-radius: 50%; animation: valuation-login-spin .8s linear infinite; }
    @keyframes valuation-login-spin { to { transform: rotate(360deg); } }
    .valuation-safe-message { box-sizing: border-box !important; position: fixed !important; top: 178px !important; left: 14px !important; right: 14px !important; width: auto !important; min-width: 0 !important; max-width: none !important; padding: 8px !important; margin: 0 !important; transform: none !important; font-size: 12px !important; }
  `;
  document.head.appendChild(style);
  let scheduled = false;
  let previous = '';
  let notice = '';
  let errorMessage = '';
  let challengeRequired = false;
  let challengeSeen = false;
  let challengeTimer;
  let smsTimer;
  let loginPhase = 'idle';
  let loginTimer;
  let loginRequestStarted = false;
  const setLoginPhase = phase => {
    loginPhase = phase;
    const button = document.querySelector('.login-btn');
    if (!button) return;
    const busy = phase !== 'idle';
    if (button.classList.contains('valuation-login-pending') !== busy) button.classList.toggle('valuation-login-pending', busy);
    button.setAttribute('aria-busy', String(busy));
    button.setAttribute('aria-disabled', String(busy));
  };
  const finishLoginWithError = message => {
    clearTimeout(loginTimer);
    setLoginPhase('idle');
    notice = 'error';
    errorMessage = message;
    schedule();
  };
  const sendState = () => {
    scheduled = false;
    if (document.title !== '账号登录') document.title = '账号登录';
    const phone = document.querySelector('.tel-with-code input[placeholder="请输入手机号"]');
    const button = document.querySelector('.verification-code-btn');
    const challengeVisible = [...document.querySelectorAll('.dx-popup-sms, .dx-popup, [class*="dx_captcha"], [class*="dx-captcha"], [id*="dx-captcha"]')].some(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 80 && rect.height > 60 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).opacity !== '0';
    });
    if (challengeVisible) { challengeSeen = true; clearTimeout(challengeTimer); }
    else if (challengeSeen) {
      challengeRequired = false;
      challengeSeen = false;
      if (loginPhase === 'challenge') setLoginPhase('idle');
    }
    const cooldown = Number((button?.textContent || '').match(/(\d+)秒/)?.[1] || 0);
    if (cooldown > 0) { challengeRequired = false; clearTimeout(challengeTimer); }
    const challenge = challengeRequired || challengeVisible;
    const messages = [...document.querySelectorAll('.el-message')];
    for (const message of messages) {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent.replace(/车\s*300|che300/gi, '数据服务').replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]');
        if (text !== node.textContent) node.textContent = text;
      }
      if (!message.classList.contains('valuation-safe-message')) message.classList.add('valuation-safe-message');
      if (message.classList.contains('el-message--error') && loginPhase === 'idle') {
        notice = 'error';
        errorMessage = safeAuthText(message.textContent);
      }
    }
    if (cooldown > 0 && notice !== 'error') notice = 'sent';
    if (challenge || cooldown > 0 || notice === 'error') clearTimeout(smsTimer);
    const state = { ready: Boolean(phone && button && document.querySelector('.login-btn')), challenge, cooldown, notice, errorMessage, loginPhase };
    const serialized = JSON.stringify(state);
    if (serialized !== previous) { previous = serialized; ipcRenderer.send('login-panel:document-state', state); }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(sendState, 0);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
  document.addEventListener('valuation-auth-network', event => {
    let data;
    try { data = JSON.parse(event.detail); } catch { return; }
    if (data.path !== '/api/fe/v1/auth/login') return;
    if (data.phase === 'request') {
      loginRequestStarted = true;
      clearTimeout(loginTimer);
      setLoginPhase('submitting');
      notice = '';
      errorMessage = '';
      loginTimer = setTimeout(() => finishLoginWithError('登录请求超时，请稍后重试'), 15000);
    } else if (data.phase === 'response') {
      clearTimeout(loginTimer);
      if (Number(data.code) === 2001 || data.challenge === true) {
        setLoginPhase('challenge');
      } else if (Number(data.code) === 2000 && data.status >= 200 && data.status < 300) {
        setLoginPhase('syncing');
        notice = '';
        errorMessage = '';
        loginTimer = setTimeout(() => finishLoginWithError('登录确认超时，请刷新账号状态后再操作'), 60000);
      } else {
        finishLoginWithError(safeAuthText(data.message) || '登录未完成，请重试');
      }
    }
    schedule();
  });
  document.addEventListener('click', event => {
    const loginButton = event.target instanceof Element ? event.target.closest('.login-btn') : null;
    if (loginButton) {
      if (loginPhase !== 'idle') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      loginRequestStarted = false;
      notice = '';
      errorMessage = '';
      setLoginPhase('submitting');
      clearTimeout(loginTimer);
      loginTimer = setTimeout(() => {
        if (!loginRequestStarted) { setLoginPhase('idle'); schedule(); }
      }, 2000);
      schedule();
      return;
    }
    const button = event.target instanceof Element ? event.target.closest('.verification-code-btn') : null;
    if (!button || /秒/.test(button.textContent)) return;
    if (loginPhase !== 'idle') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    notice = 'pending';
    errorMessage = '';
    clearTimeout(smsTimer);
    smsTimer = setTimeout(() => { notice = 'timeout'; schedule(); }, 15000);
    ipcRenderer.send('login-panel:sms-start');
    schedule();
  }, true);
  document.addEventListener('valuation-auth-challenge', () => {
    challengeRequired = true;
    clearTimeout(smsTimer);
    clearTimeout(challengeTimer);
    challengeTimer = setTimeout(() => {
      if (challengeSeen) return;
      challengeRequired = false;
      notice = 'error';
      errorMessage = '安全验证组件未显示，请重新加载后重试';
      if (loginPhase === 'challenge') setLoginPhase('idle');
      schedule();
    }, 10000);
    schedule();
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('pagehide', () => { clearTimeout(smsTimer); clearTimeout(challengeTimer); clearTimeout(loginTimer); });
  sendState();
});
