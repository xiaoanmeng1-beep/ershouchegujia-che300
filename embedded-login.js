const { WebContentsView } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

// Keep the real SMS controls, challenge widget and account session together.
class EmbeddedLogin extends EventEmitter {
  constructor(parent, partition, log) {
    super();
    this.parent = parent;
    this.log = log;
    this.closed = false;
    this.phase = 'loading';
    this.bounds = null;
    this.attempt = 0;
    this.formReady = false;
    this.lastFormState = '';
    this.view = new WebContentsView({ webPreferences: {
      partition, contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, preload: path.join(__dirname, 'auth-preload.js')
    } });
    this.webContents = this.view.webContents;
    this.networkReady = null;
    this.view.setBounds({ x: 0, y: 46, width: 340, height: 440 });
    this.view.setBackgroundColor('#ffffff');
    this.view.setVisible(false);
    parent.contentView.addChildView(this.view);
    this.onParentClosed = () => this.close();
    parent.once('closed', this.onParentClosed);
    this.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.setPhase('loading');
    });
    this.webContents.on('dom-ready', () => this.setPhase('ready'));
    this.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        this.log('授权页面导航失败', { code, description });
        this.setPhase('failed');
      }
    });
    this.webContents.on('render-process-gone', (_event, details) => {
      this.log('授权页面进程退出', { reason: details.reason });
      this.setPhase('failed');
    });
    this.webContents.on('console-message', (details) => {
      if (details?.level !== 'error') return;
      const message = String(details.message || '').replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]')
        .replace(/车\s*300|che300/gi, '数据服务').replace(/\d{6,}/g, '[已隐藏]')
        .replace(/[A-Za-z0-9_=-]{32,}/g, '[已隐藏]').slice(0, 300);
      this.log('登录页面脚本错误', { message });
    });
    this.webContents.once('destroyed', () => this.close());
    this.setPhase('loading');
  }

  isDestroyed() { return this.closed || this.webContents.isDestroyed(); }
  setTitle() {}
  focus() { if (!this.isDestroyed()) this.webContents.focus(); }

  setPhase(phase) {
    if (this.closed) return;
    this.phase = phase;
    if (phase !== 'ready') {
      this.formReady = false;
      this.lastFormState = '';
    }
    this.layout();
    if (!this.parent.isDestroyed()) this.parent.webContents.send('login-panel:state', { phase });
  }

  updateFormState(data) {
    if (this.isDestroyed() || this.parent.isDestroyed()) return;
    const state = {
      ready: data?.ready === true,
      challenge: data?.challenge === true,
      loginPhase: ['idle', 'submitting', 'challenge', 'syncing'].includes(data?.loginPhase) ? data.loginPhase : 'idle',
      cooldown: Math.max(0, Math.min(60, Number(data?.cooldown) || 0)),
      notice: ['pending', 'sent', 'error', 'timeout'].includes(data?.notice) ? data.notice : ''
    };
    if (typeof data?.errorMessage === 'string') {
      state.errorMessage = data.errorMessage.replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]')
        .replace(/车\s*300|che300/gi, '数据服务').replace(/\d{6,}/g, '[已隐藏]')
        .replace(/[A-Za-z0-9_=-]{32,}/g, '[已隐藏]').slice(0, 240);
    }
    this.formReady = state.ready || state.challenge;
    if (this.formReady) this.phase = 'ready';
    this.layout();
    const serialized = JSON.stringify(state);
    if (serialized === this.lastFormState) return;
    this.lastFormState = serialized;
    this.parent.webContents.send('login-panel:form-state', state);
    if (state.challenge) this.log('短信发送需要安全验证，显示原始验证组件');
    else if (state.notice === 'sent' && !this.smsAcknowledged) {
      this.smsAcknowledged = true;
      this.log('发送流程已进入验证码倒计时');
    } else if (state.notice === 'error') this.log('授权页面操作失败', { message: state.errorMessage || '页面没有提供错误说明' });
    else if (state.notice === 'timeout') this.log('短信操作等待超时，尚未确认发送成功');
    if (!state.cooldown) this.smsAcknowledged = false;
  }

  setBounds(bounds) {
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) return;
    this.bounds = bounds;
    this.layout();
  }

  layout() {
    if (this.isDestroyed() || this.parent.isDestroyed()) return;
    if (!this.bounds) { this.view.setVisible(false); return; }
    const [width, height] = this.parent.getContentSize();
    const b = this.bounds;
    const x = Math.max(0, Math.round(b.x));
    const y = Math.max(46, Math.round(b.y));
    const w = Math.max(0, Math.min(Math.round(b.width), width - x));
    const h = Math.max(0, Math.min(Math.round(b.y + b.height), height) - y);
    const fits = b.y >= 46 && w > 0 && h > 0;
    this.view.setVisible(fits && this.phase === 'ready');
    if (!fits) return;
    this.view.setBounds({ x, y, width: w, height: h });
    this.webContents.setZoomFactor(Math.min(1, Math.max(0.6, w / 320)));
  }

  async prepareNetwork() {
    const sdkUrl = 'https://cdn.dingxiang-inc.com/ctu-group/captcha-ui/index.js';
    const accountSession = this.webContents.session;
    const probe = async () => {
      const response = await accountSession.fetch(sdkUrl, {
        cache: 'no-cache', signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error('安全验证资源暂不可用');
      const body = await response.text();
      if (!/captcha\.js|Captcha/.test(body)) throw new Error('安全验证资源内容异常');
    };
    try {
      await probe();
    } catch (error) {
      const proxy = await accountSession.resolveProxy(sdkUrl);
      if (this.closed || !proxy || proxy === 'DIRECT' ||
          !/SSL_PROTOCOL_ERROR|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|TimeoutError/i.test(`${error.name} ${error.message}`)) {
        throw error;
      }
      this.log('安全验证代理连接失败，尝试当前账号直连');
      await accountSession.setProxy({ mode: 'direct' });
      try {
        await probe();
        this.log('安全验证直连成功，当前账号使用直连，系统代理设置不变');
      } catch (directError) {
        await accountSession.setProxy({ mode: 'system' });
        this.log('安全验证直连失败，已恢复当前账号系统代理');
        throw directError;
      }
    }
  }

  async loadURL(url) {
    if (new URL(url).hostname === 'login.che300.com') {
      this.networkReady ||= this.prepareNetwork().catch(error => {
        this.networkReady = null;
        throw error;
      });
      await this.networkReady;
      if (this.closed) return;
    }
    this.url = url;
    const attempt = ++this.attempt;
    for (let retry = 0; retry < 2; retry++) {
      if (this.isDestroyed() || attempt !== this.attempt) return;
      this.setPhase('loading');
      let timeout;
      try {
        await Promise.race([
          this.webContents.loadURL(url),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('授权页面加载超时')), 20000); })
        ]);
        if (!this.isDestroyed() && attempt === this.attempt) this.setPhase('ready');
        return;
      } catch (error) {
        if (this.isDestroyed() || attempt !== this.attempt) return;
        if (error.code === 'ERR_ABORTED' || error.errno === -3) return;
        this.webContents.stop();
        this.log('授权页面加载失败', { attempt: retry + 1, message: error.message });
        if (retry === 0) { this.log('授权页面自动重试一次'); continue; }
        this.setPhase('failed');
      } finally { clearTimeout(timeout); }
    }
  }

  retry() { if (!this.isDestroyed() && this.url) return this.loadURL(this.url); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.attempt++;
    this.parent.removeListener('closed', this.onParentClosed);
    if (!this.parent.isDestroyed()) {
      this.parent.contentView.removeChildView(this.view);
      this.parent.webContents.send('login-panel:state', { phase: 'closed' });
    }
    if (!this.webContents.isDestroyed()) this.webContents.close();
    this.emit('closed');
  }
}

module.exports = { EmbeddedLogin };
