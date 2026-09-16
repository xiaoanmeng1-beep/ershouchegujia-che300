function supersededError() {
  const error = new Error('请求已被新参数替代');
  error.code = 'SUPERSEDED';
  return error;
}

class RequestScope {
  constructor(id) {
    this.id = id;
    this.cancelled = false;
    this.window = null;
    this.cancelPromise = new Promise((resolve, reject) => { this.rejectCancellation = reject; });
    this.cancelPromise.catch(() => {});
  }

  check() { if (this.cancelled) throw supersededError(); }

  wait(task) {
    this.check();
    return Promise.race([Promise.resolve().then(() => { this.check(); return task(); }), this.cancelPromise])
      .then(result => { this.check(); return result; });
  }

  attach(window) {
    if (this.cancelled) {
      if (!window.isDestroyed()) window.destroy();
      this.check();
    }
    this.window = window;
    return window;
  }

  dispose() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.rejectCancellation(supersededError());
    this.dispose();
  }
}

class LatestRequest {
  constructor() { this.current = null; this.sequence = 0; }
  start() {
    this.cancel();
    this.current = new RequestScope(++this.sequence);
    return this.current;
  }
  cancel() { this.current?.cancel(); }
  finish(scope) {
    scope.dispose();
    if (this.current === scope) this.current = null;
  }
}

module.exports = { LatestRequest, RequestScope };
