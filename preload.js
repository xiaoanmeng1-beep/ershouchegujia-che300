const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openChe300Login: (targetUrl) => ipcRenderer.invoke('che300:open-login', targetUrl),
  getChe300SessionState: () => ipcRenderer.invoke('che300:session-state'),
  getAccounts: () => ipcRenderer.invoke('che300:accounts'),
  refreshAccount: (id) => ipcRenderer.invoke('che300:refresh-account', id),
  addAccount: () => ipcRenderer.invoke('che300:add-account'),
  deleteAccount: (id) => ipcRenderer.invoke('che300:delete-account', id),
  loginAccount: (id) => ipcRenderer.invoke('che300:login-account', id),
  setLoginPanelBounds: (bounds) => ipcRenderer.send('login-panel:bounds', bounds),
  closeLoginPanel: () => ipcRenderer.send('login-panel:close'),
  retryLoginPanel: () => ipcRenderer.send('login-panel:retry'),
  onLoginPanelState: (callback) => ipcRenderer.on('login-panel:state', (_event, state) => callback(state)),
  onLoginFormState: (callback) => ipcRenderer.on('login-panel:form-state', (_event, state) => callback(state)),
  selectAccount: (id) => ipcRenderer.invoke('che300:select-account', id),
  onAccounts: (callback) => ipcRenderer.on('che300:accounts', (_event, accounts) => callback(accounts)),
  getBrands: (category) => ipcRenderer.invoke('catalog:brands', category),
  getRegions: () => ipcRenderer.invoke('catalog:regions'),
  getSeries: (category, brandId) => ipcRenderer.invoke('catalog:series', { category, brandId }),
  getModels: (category, brandId, seriesId) => ipcRenderer.invoke('catalog:models', { category, brandId, seriesId }),
  estimate: (input) => ipcRenderer.invoke('che300:estimate', input),
  cancelEstimate: () => ipcRenderer.send('che300:cancel-estimate'),
  onQuoteUpdated: (callback) => ipcRenderer.on('che300:quote-updated', (_event, payload) => callback(payload)),
  onVehiclePhotoUpdated: (callback) => ipcRenderer.on('vehicle:photo-updated', (_event, payload) => callback(payload)),
  onModelsUpdated: (callback) => ipcRenderer.on('catalog:models-updated', (_event, payload) => callback(payload)),
  getLogs: () => ipcRenderer.invoke('app:logs'),
  onLog: (callback) => ipcRenderer.on('app:log', (_event, entry) => callback(entry)),
  onAuthState: (callback) => ipcRenderer.on('che300:auth-state', (_event, state) => callback(state)),
  onChe300WindowClosed: (callback) => {
    ipcRenderer.on('che300-window-closed', (_event, result) => callback(result));
  }
});
