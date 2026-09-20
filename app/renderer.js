const state = {
  category: 'passenger',
  brand: null,
  series: null,
  model: null,
  registrationYear: '',
  registrationMonth: '',
  brands: [],
  seriesList: [],
  models: [],
  location: null
};

const catalogCache = {};
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const seenLogIds = new Set();
const $ = (selector) => document.querySelector(selector);

const defaultBannerCopy = {
  primary: '在线查价  X月份真实收车价',
  ticker: '所在地丨车型丨配置丨上牌丨公里数'
};
let bannerCopy = { ...defaultBannerCopy };
try {
  const saved = JSON.parse(localStorage.getItem('valuation-banner-copy'));
  if (saved && typeof saved.primary === 'string' && typeof saved.ticker === 'string') {
    bannerCopy = { primary: saved.primary, ticker: saved.ticker };
  }
} catch {}

function displayBannerPrimary(text) {
  return text.replace(/x(?=月份)/gi, String(new Date().getMonth() + 1));
}

function renderBannerCopy() {
  $('#valuationBannerPrimary').textContent = displayBannerPrimary(bannerCopy.primary);
  $('#valuationBannerTicker').textContent = bannerCopy.ticker;
  $('#bannerPrimaryInput').value = bannerCopy.primary;
  $('#bannerTickerInput').value = bannerCopy.ticker;
}

function updateBannerCopy() {
  bannerCopy = {
    primary: $('#bannerPrimaryInput').value,
    ticker: $('#bannerTickerInput').value
  };
  try { localStorage.setItem('valuation-banner-copy', JSON.stringify(bannerCopy)); } catch {}
  $('#valuationBannerPrimary').textContent = displayBannerPrimary(bannerCopy.primary);
  $('#valuationBannerTicker').textContent = bannerCopy.ticker;
}

$('#bannerPrimaryInput').addEventListener('input', updateBannerCopy);
$('#bannerTickerInput').addEventListener('input', updateBannerCopy);
renderBannerCopy();

const vehicleDialog = $('#vehicleDialog');
const configurationDialog = $('#configurationDialog');
const configurationField = $('#configurationField');
const configurationValue = $('#configurationValue');
let modelOptionsRequest = null;
const brandIndex = $('#brandIndex');
const brandList = $('#brandList');
const seriesList = $('#seriesList');
const trimList = $('#trimList');
const vehicleValue = $('#vehicleValue');
const registrationYearSelect = $('#registrationYearSelect');
const registrationMonthSelect = $('#registrationMonthSelect');
const provinceSelect = $('#provinceSelect');
const citySelect = $('#citySelect');
let regionSelectRequest = null;
const formMessage = $('#formMessage');
const resultCard = $('#resultCard');
let estimateTimer;
let estimateRunning = false;
let manualLoginRunning = false;
let lastSubmittedKey = '';
let lastSuccessfulQuote = null;
let estimateRevision = 0;
let pendingEstimateKey = '';
let latestQuoteRequestId = null;
const earlyQuoteUpdates = new Map();
const logOutput = $('#logOutput');
let regions = [];
let pendingProvinceId = '';

const loginPanel = $('#loginPanel');
const loginPanelHost = $('#loginPanelHost');
window.desktop.onLoginFormState(data => {
  if (loginPanel.hidden) return;
  const canShowLoginContent = data.ready || data.challenge;
  loginPanelHost.hidden = !canShowLoginContent;
  loginPanelHost.classList.toggle('has-challenge', data.challenge);
  $('#loginPanelSpinner').hidden = canShowLoginContent;
  $('#retryLoginPanel').hidden = data.notice !== 'error';
  $('#authNotice').textContent = data.challenge ? '请完成安全验证' :
    data.notice === 'error' ? (data.errorMessage || '发送未完成，请重试') :
    data.notice === 'timeout' ? '尚未确认验证码发送成功，请重试' : '';
  syncLoginPanelBounds();
});
let loginPanelFrame = 0;
function syncLoginPanelBounds() {
  if (loginPanelFrame) return;
  loginPanelFrame = requestAnimationFrame(() => {
    loginPanelFrame = 0;
    if (loginPanel.hidden || panelResizePointer !== null) return;
    const { x, y, width, height } = loginPanelHost.getBoundingClientRect();
    window.desktop.setLoginPanelBounds({ x, y, width, height });
  });
}
window.desktop.onLoginPanelState(({ phase }) => {
  loginPanel.hidden = phase === 'closed';
  $('.app-shell').classList.toggle('login-open', !loginPanel.hidden);
  $('#loginPanelSpinner').hidden = phase !== 'loading';
  $('#retryLoginPanel').hidden = phase !== 'failed';
  loginPanelHost.hidden = phase !== 'ready';
  if (phase === 'closed') {
    $('#authNotice').textContent = '';
    refreshLoginStatus();
  }
  syncLoginPanelBounds();
});
$('#closeLoginPanel').addEventListener('click', () => window.desktop.closeLoginPanel());
$('#retryLoginPanel').addEventListener('click', () => window.desktop.retryLoginPanel());
new ResizeObserver(syncLoginPanelBounds).observe(loginPanelHost);
window.addEventListener('resize', syncLoginPanelBounds);
window.addEventListener('scroll', syncLoginPanelBounds, true);

const panelShell = $('.app-shell');
const panelDivider = $('#panelDivider');
let panelResizePointer = null;
let preferredAccountWidth = 340;
let observedShellWidth = 0;
try {
  const saved = Number(localStorage.getItem('account-panel-width'));
  if (Number.isFinite(saved) && saved > 0) preferredAccountWidth = saved;
} catch {}

function panelWidthLimits() {
  const style = getComputedStyle(panelShell);
  const available = Math.max(0, panelShell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - panelDivider.offsetWidth);
  return {
    min: Math.min(260, available * 0.4),
    max: Math.max(0, available - Math.min(280, available * 0.45))
  };
}

function applyPanelWidth(width) {
  const limits = panelWidthLimits();
  const next = Math.round(Math.max(limits.min, Math.min(limits.max, width)));
  panelShell.style.setProperty('--account-width', `${next}px`);
  panelDivider.setAttribute('aria-valuemin', String(Math.round(limits.min)));
  panelDivider.setAttribute('aria-valuemax', String(Math.round(limits.max)));
  panelDivider.setAttribute('aria-valuenow', String(next));
  panelDivider.setAttribute('aria-valuetext', `右侧宽度 ${next} 像素`);
  syncLoginPanelBounds();
  return next;
}

function savePanelWidth() {
  try { localStorage.setItem('account-panel-width', String(preferredAccountWidth)); } catch {}
}

panelDivider.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  panelResizePointer = event.pointerId;
  panelDivider.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-panels');
  if (!loginPanel.hidden) window.desktop.setLoginPanelBounds({ x: 0, y: 0, width: 0, height: 0 });
});
panelDivider.addEventListener('pointermove', event => {
  if (panelResizePointer !== event.pointerId) return;
  const bounds = panelShell.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(panelShell).paddingRight);
  preferredAccountWidth = applyPanelWidth(bounds.right - padding - event.clientX - panelDivider.offsetWidth / 2);
});
function finishPanelResize(event) {
  if (panelResizePointer !== event.pointerId) return;
  panelResizePointer = null;
  document.body.classList.remove('resizing-panels');
  if (panelDivider.hasPointerCapture(event.pointerId)) panelDivider.releasePointerCapture(event.pointerId);
  savePanelWidth();
  syncLoginPanelBounds();
}
panelDivider.addEventListener('pointerup', finishPanelResize);
panelDivider.addEventListener('pointercancel', finishPanelResize);
panelDivider.addEventListener('lostpointercapture', finishPanelResize);
panelDivider.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const limits = panelWidthLimits();
  const current = Number(panelDivider.getAttribute('aria-valuenow'));
  const next = event.key === 'Home' ? limits.max : event.key === 'End' ? limits.min : current + (event.key === 'ArrowLeft' ? 20 : -20);
  preferredAccountWidth = applyPanelWidth(next);
  savePanelWidth();
});
new ResizeObserver(() => {
  if (observedShellWidth === panelShell.clientWidth) return;
  observedShellWidth = panelShell.clientWidth;
  applyPanelWidth(preferredAccountWidth);
}).observe(panelShell);
applyPanelWidth(preferredAccountWidth);

const inlinePickers = [
  { panel: vehicleDialog, field: $('#vehicleField') },
  { panel: configurationDialog, field: configurationField },
];
inlinePickers.forEach(({ panel, field }) => {
  field.after(panel);
  panel.classList.add('inline-picker');
  field.setAttribute('aria-controls', panel.id);
  field.setAttribute('aria-expanded', 'false');
  panel.addEventListener('close', () => field.setAttribute('aria-expanded', String(panel.open)));
});

function toggleInlinePicker(panel) {
  const selected = inlinePickers.find(item => item.panel === panel);
  if (panel.open) {
    panel.close();
    selected.field.setAttribute('aria-expanded', 'false');
    return false;
  }
  inlinePickers.forEach(item => {
    if (item.panel.open) item.panel.close();
    item.field.setAttribute('aria-expanded', 'false');
  });
  panel.show();
  selected.field.setAttribute('aria-expanded', 'true');
  return true;
}

document.addEventListener('pointerdown', event => {
  inlinePickers.forEach(({ panel, field }) => {
    if (panel.open && !panel.contains(event.target) && !field.contains(event.target)) {
      panel.close();
      field.setAttribute('aria-expanded', 'false');
    }
  });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const selected = inlinePickers.find(item => item.panel.open);
  if (!selected) return;
  event.preventDefault();
  selected.panel.close();
  selected.field.setAttribute('aria-expanded', 'false');
  selected.field.focus({ preventScroll: true });
});

function formatLogTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function appendLog(entry) {
  if (entry.id && seenLogIds.has(entry.id)) return;
  if (entry.id) seenLogIds.add(entry.id);
  const safeMessage = String(entry.message || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址]')
    .replace(/车\s*300|che300/gi, '数据服务');
  const line = '[' + formatLogTime(entry.time || Date.now()) + '] ' + safeMessage;
  logOutput.textContent += (logOutput.textContent ? '\n' : '') + line;
  const lines = logOutput.textContent.split('\n');
  if (lines.length > 200) logOutput.textContent = lines.slice(-200).join('\n');
  logOutput.scrollTop = logOutput.scrollHeight;
}

function appendLocalLog(message) {
  appendLog({ time: Date.now(), message });
}

function clearPrices(message = '完成车辆信息并估值后显示收车价') {
  setPriceLoading(false);
  $('#vehiclePhotoCard').hidden = true;
  $('#vehiclePhoto').removeAttribute('src');
  $('#primaryPrice').textContent = '--';
  $('#resultBody').textContent = message;
  resultCard.hidden = false;
}

function pickerStatus(container, text) {
  container.replaceChildren();
  const status = document.createElement('span');
  status.className = 'picker-status';
  if (/失败|超时|错误|error|ERR_|timeout|车\s*300|che300/i.test(String(text))) {
    appendLocalLog('选项加载异常：' + text);
    status.textContent = '';
  } else status.textContent = text;
  container.append(status);
}

function createPickerItem(item, active, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'picker-item' + (active ? ' active' : '');
  button.textContent = item.name;
  button.title = item.name;
  if (item.catalogPrice) {
    const name = document.createElement('span');
    name.className = 'picker-item-name';
    name.textContent = item.name;
    const price = document.createElement('span');
    price.className = 'picker-item-price';
    price.textContent = item.catalogPrice;
    button.classList.add('priced-model');
    button.replaceChildren(name, price);
    button.title = item.name + ' ' + item.catalogPrice;
  }
  button.addEventListener('click', onClick);
  return button;
}

function centerSelectedItem(container) {
  const active = container.querySelector('.picker-item.active, .date-option.active');
  if (!active) return;
  const top = active.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  container.scrollTo({ top: Math.max(0, top - (container.clientHeight - active.offsetHeight) / 2), behavior: 'instant' });
}

function restoreVehiclePickerPosition() {
  requestAnimationFrame(() => {
    centerSelectedItem(brandList);
    centerSelectedItem(seriesList);
    centerSelectedItem(trimList);
  });
}



function resetRegistration() {
  state.registrationYear = '';
  state.registrationMonth = '';
  renderRegistrationYears();
}

function replaceSelectOptions(select, items, placeholder, selected = '') {
  select.replaceChildren(new Option(placeholder, ''));
  for (const item of items) select.add(new Option(item.name, String(item.id)));
  const value = String(selected || '');
  select.value = items.some(item => String(item.id) === value) ? value : '';
  select.disabled = !items.length;
}

function registrationYearRange() {
  const currentYear = new Date().getFullYear();
  const modelYear = Number.parseInt(state.model?.year, 10) || currentYear;
  const rawMin = Number.parseInt(state.model?.minRegistrationYear, 10) || modelYear;
  const rawMax = Number.parseInt(state.model?.maxRegistrationYear, 10) || modelYear;
  const minimum = Math.min(rawMin, rawMax);
  const maximum = Math.max(rawMin, rawMax);
  return Array.from({ length: maximum - minimum + 1 }, (_item, index) => minimum + index);
}

function renderRegistrationYears() {
  const years = state.model ? registrationYearRange() : [];
  replaceSelectOptions(registrationYearSelect, years.map(year => ({ id: year, name: String(year) })), '年份', state.registrationYear);
  if (state.registrationYear !== registrationYearSelect.value) {
    state.registrationYear = registrationYearSelect.value;
    state.registrationMonth = '';
  }
  renderRegistrationMonths();
}

function renderRegistrationMonths() {
  const months = state.registrationYear ? Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: String(index + 1).padStart(2, '0') })) : [];
  replaceSelectOptions(registrationMonthSelect, months, '月份', state.registrationMonth);
  state.registrationMonth = registrationMonthSelect.value;
}

function brandGroupId(initial) {
  return 'brand-group-' + initial;
}

function renderBrands() {
  brandList.replaceChildren();
  brandIndex.replaceChildren();
  brandList.scrollTop = 0;

  const groups = new Map(alphabet.map((letter) => [letter, []]));
  state.brands.forEach((brand) => {
    const initial = String(brand.initial || '').toUpperCase();
    if (groups.has(initial)) groups.get(initial).push(brand);
  });

  alphabet.forEach((initial) => {
    const brands = groups.get(initial);
    const indexButton = document.createElement('button');
    indexButton.type = 'button';
    indexButton.textContent = initial;
    indexButton.classList.toggle('unavailable', brands.length === 0);
    indexButton.disabled = brands.length === 0;
    indexButton.setAttribute('aria-label', '跳转到' + initial + '开头的品牌');
    indexButton.addEventListener('click', () => {
      const heading = document.getElementById(brandGroupId(initial));
      if (!heading) return;
      const top = heading.getBoundingClientRect().top - brandList.getBoundingClientRect().top + brandList.scrollTop;
      brandList.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      brandIndex.querySelectorAll('button').forEach(button => button.classList.toggle('active', button === indexButton));
      appendLocalLog('品牌列表定位到：' + initial);
    });
    brandIndex.append(indexButton);

    if (!brands.length) return;
    const heading = document.createElement('div');
    heading.className = 'brand-letter-heading';
    heading.id = brandGroupId(initial);
    heading.textContent = initial;
    brandList.append(heading);

    brands.forEach((brand) => {
      const brandButton = createPickerItem(brand, state.brand?.id === brand.id, async () => {
        if (state.brand?.id === brand.id && state.seriesList.length) return;
        brandList.querySelectorAll('.picker-item.active').forEach((button) => button.classList.remove('active'));
        brandButton.classList.add('active');
        state.brand = brand;
        state.series = null;
        state.model = null;
        state.seriesList = [];
        state.models = [];
        resetRegistration();
        syncVehicleFields();
        scheduleEstimate();
        pickerStatus(seriesList, '加载中…');
        trimList.replaceChildren();
        appendLocalLog('选择品牌：' + brand.name + '，开始加载车系');
        try {
          const loaded = await window.desktop.getSeries(state.category, brand.id);
          if (state.brand?.id !== brand.id) return;
          state.seriesList = loaded;
          renderSeries();
        } catch (error) {
          if (state.brand?.id === brand.id) pickerStatus(seriesList, error.message || '加载失败');
        }
      });
      brandList.append(brandButton);
    });
  });

}

function shortConfigurationName(model) {
  const fullName = String(model.name || '').trim();
  const year = fullName.match(/^\d{4}\s*款\s*/);
  let name = year ? fullName.slice(year[0].length) : fullName;
  const brand = String(state.brand?.name || '').trim();
  const series = String(state.series?.name || '').trim();
  const prefixes = [...new Set([brand && series ? brand + ' ' + series : '', series, brand])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const prefix of prefixes) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      const next = name.replace(new RegExp('^' + escaped + '(?=\\s|$)\\s*', 'i'), '').trim();
      if (next !== name) { name = next; break; }
    }
  }
  if (!name) return fullName;
  return (year ? year[0].trim() + ' ' : '') + name;
}

function syncVehicleFields() {
  vehicleValue.textContent = state.series?.name || '请选择车型';
  vehicleValue.title = state.series?.name || '';
  vehicleValue.classList.toggle('placeholder', !state.series);
  configurationField.disabled = !state.series;
  configurationValue.textContent = state.model
    ? shortConfigurationName(state.model) + (state.model.catalogPrice ? ' · ' + state.model.catalogPrice : '')
    : state.series ? '请选择配置' : '请先选择车型';
  configurationValue.title = state.model?.name || '';
  configurationValue.classList.toggle('placeholder', !state.model);
}

async function loadModelOptions() {
  if (!state.brand || !state.series) return;
  if (state.models.length) { renderModels(); return; }
  const { category } = state;
  const brandId = state.brand.id;
  const seriesId = state.series.id;
  const key = JSON.stringify([category, brandId, seriesId]);
  if (modelOptionsRequest?.key === key) return modelOptionsRequest.task;
  pickerStatus(trimList, '加载中…');
  const request = { key };
  request.task = window.desktop.getModels(category, brandId, seriesId).then(loaded => {
    if (state.category !== category || state.brand?.id !== brandId || state.series?.id !== seriesId) return;
    state.models = loaded;
    renderModels();
  }).catch(error => {
    if (state.category === category && state.brand?.id === brandId && state.series?.id === seriesId) {
      pickerStatus(trimList, error.message || '加载失败');
    }
  }).finally(() => {
    if (modelOptionsRequest === request) modelOptionsRequest = null;
  });
  modelOptionsRequest = request;
  return request.task;
}

function renderSeries() {
  seriesList.replaceChildren();
  state.seriesList.forEach((series) => {
    const seriesButton = createPickerItem(series, state.series?.id === series.id, async () => {
      seriesList.querySelectorAll('.picker-item.active').forEach(button => button.classList.remove('active'));
      seriesButton.classList.add('active');
      if (state.series?.id !== series.id) {
        state.series = series;
        state.model = null;
        state.models = [];
        resetRegistration();
        scheduleEstimate();
      }
      syncVehicleFields();
      vehicleDialog.close();
      toggleInlinePicker(configurationDialog);
      appendLocalLog('选择车系：' + series.name + '，开始选择配置');
      await loadModelOptions();
      requestAnimationFrame(() => centerSelectedItem(trimList));
    });
    seriesList.append(seriesButton);
  });
}

function renderModels() {
  trimList.replaceChildren();
  state.models.forEach((model) => {
    trimList.append(createPickerItem({ ...model, name: shortConfigurationName(model) }, state.model?.id === model.id, () => {
      const changedModel = state.model?.id !== model.id;
      state.model = model;
      if (changedModel) renderRegistrationYears();
      renderModels();
      syncVehicleFields();
      formMessage.textContent = '';
      clearPrices();
      appendLocalLog('具体车型已确认：' + model.name + '，可选上牌年份 ' + model.minRegistrationYear + '-' + model.maxRegistrationYear);
      configurationDialog.close();
      scheduleEstimate();
    }));
  });
}

async function loadBrands() {
  const cached = catalogCache[state.category];
  if (cached) {
    state.brands = cached;
    renderBrands();
    if (state.brand) renderSeries();
    if (state.series) renderModels();
    return;
  }

  brandIndex.replaceChildren();
  pickerStatus(brandList, '加载中…');
  seriesList.replaceChildren();
  trimList.replaceChildren();

  try {
    state.brands = await window.desktop.getBrands(state.category);
    catalogCache[state.category] = state.brands;
    if (state.brands.length) {
      renderBrands();
    } else {
      pickerStatus(brandList, '暂无品牌');
    }
  } catch (error) {
    pickerStatus(brandList, '加载失败');
    formMessage.textContent = '';
    appendLocalLog('加载失败：' + error.message);
  }
}

$('#vehicleField').addEventListener('click', async () => {
  formMessage.textContent = '';
  if (!toggleInlinePicker(vehicleDialog)) return;
  appendLocalLog('打开车型选择器');
  await loadBrands();
  restoreVehiclePickerPosition();
});

configurationField.addEventListener('click', async () => {
  if (!state.series || !toggleInlinePicker(configurationDialog)) return;
  await loadModelOptions();
  requestAnimationFrame(() => centerSelectedItem(trimList));
});

registrationYearSelect.addEventListener('change', () => {
  state.registrationYear = registrationYearSelect.value;
  renderRegistrationMonths();
  scheduleEstimate();
});
registrationMonthSelect.addEventListener('change', () => {
  state.registrationMonth = registrationMonthSelect.value;
  scheduleEstimate();
});


function renderCities() {
  const province = regions.find(item => String(item.id) === pendingProvinceId);
  replaceSelectOptions(citySelect, province?.cities || [], '城市', state.location?.cityId);
  citySelect.title = state.location?.cityName || '';
}

function renderProvinces() {
  pendingProvinceId = state.location ? String(state.location.provinceId) : pendingProvinceId;
  replaceSelectOptions(provinceSelect, regions, '省份', pendingProvinceId);
  pendingProvinceId = provinceSelect.value;
  provinceSelect.title = regions.find(item => String(item.id) === pendingProvinceId)?.name || '';
  renderCities();
}

async function loadRegionSelects() {
  if (regions.length) return;
  if (regionSelectRequest) return regionSelectRequest;
  provinceSelect.disabled = true;
  regionSelectRequest = window.desktop.getRegions().then(items => {
    regions = items;
    renderProvinces();
  }).catch(error => {
    provinceSelect.replaceChildren(new Option('点击重试', ''));
    provinceSelect.disabled = false;
    appendLocalLog('地区加载失败：' + error.message);
  }).finally(() => { regionSelectRequest = null; });
  return regionSelectRequest;
}
provinceSelect.addEventListener('focus', loadRegionSelects);
provinceSelect.addEventListener('pointerdown', loadRegionSelects);
provinceSelect.addEventListener('change', () => {
  pendingProvinceId = provinceSelect.value;
  state.location = null;
  provinceSelect.title = regions.find(item => String(item.id) === pendingProvinceId)?.name || '';
  renderCities();
  scheduleEstimate();
});
citySelect.addEventListener('change', () => {
  const province = regions.find(item => String(item.id) === pendingProvinceId);
  const city = province?.cities.find(item => String(item.id) === citySelect.value);
  state.location = city ? { provinceId: String(province.id), cityId: String(city.id), provinceName: province.name, cityName: city.name } : null;
  citySelect.title = city?.name || '';
  scheduleEstimate();
});
loadRegionSelects();
renderRegistrationYears();

const movableVehiclePhoto = $('#vehiclePhotoEditor');
const vehiclePhotoImage = $('#vehiclePhoto');
const vehiclePhotoStage = $('#vehiclePhotoStage');
const vehiclePhotoResizeHandles = [...document.querySelectorAll('.vehicle-photo-resize-handle')];
const defaultVehiclePhotoPosition = { x: 0.5, y: 0 };
const defaultVehiclePhotoScale = 1;
const minimumVehiclePhotoScale = 0.25;
const maximumVehiclePhotoScale = 5;
const vehiclePhotoBaseWidth = 280;
let vehiclePhotoPosition = { ...defaultVehiclePhotoPosition };
let vehiclePhotoScale = defaultVehiclePhotoScale;
let vehiclePhotoDrag = null;
let vehiclePhotoResize = null;
try {
  const saved = JSON.parse(localStorage.getItem('vehicle-photo-position'));
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    vehiclePhotoPosition = { x: Math.max(0, Math.min(1, saved.x)), y: Math.max(0, Math.min(1, saved.y)) };
    if (Number.isFinite(saved.scale)) {
      vehiclePhotoScale = Math.max(minimumVehiclePhotoScale, Math.min(maximumVehiclePhotoScale, saved.scale));
    }
  }
} catch {}

function vehiclePhotoMovementRange() {
  return {
    x: vehiclePhotoStage.clientWidth - movableVehiclePhoto.offsetWidth,
    y: vehiclePhotoStage.clientHeight - movableVehiclePhoto.offsetHeight
  };
}

function applyVehiclePhotoPosition() {
  if (!vehiclePhotoStage.clientWidth) return;
  const range = vehiclePhotoMovementRange();
  movableVehiclePhoto.style.left = `${range.x * vehiclePhotoPosition.x}px`;
  movableVehiclePhoto.style.top = `${range.y * vehiclePhotoPosition.y}px`;
}

function saveVehiclePhotoPosition() {
  try {
    localStorage.setItem('vehicle-photo-position', JSON.stringify({ ...vehiclePhotoPosition, scale: vehiclePhotoScale }));
  } catch {}
}

function setVehiclePhotoScale(nextScale, preserveCenter = true) {
  const oldRange = vehiclePhotoMovementRange();
  const oldLeft = oldRange.x * vehiclePhotoPosition.x;
  const oldTop = oldRange.y * vehiclePhotoPosition.y;
  const oldCenter = {
    x: oldLeft + movableVehiclePhoto.offsetWidth / 2,
    y: oldTop + movableVehiclePhoto.offsetHeight / 2
  };
  vehiclePhotoScale = Math.max(minimumVehiclePhotoScale, Math.min(maximumVehiclePhotoScale, nextScale));
  movableVehiclePhoto.style.width = `${vehiclePhotoBaseWidth * vehiclePhotoScale}px`;
  const ratio = vehiclePhotoImage.naturalWidth ? vehiclePhotoImage.naturalHeight / vehiclePhotoImage.naturalWidth : 170 / 280;
  movableVehiclePhoto.style.height = `${vehiclePhotoBaseWidth * vehiclePhotoScale * ratio}px`;
  const range = vehiclePhotoMovementRange();
  const desiredLeft = preserveCenter ? oldCenter.x - movableVehiclePhoto.offsetWidth / 2 : oldLeft;
  const desiredTop = preserveCenter ? oldCenter.y - movableVehiclePhoto.offsetHeight / 2 : oldTop;
  vehiclePhotoPosition.x = range.x ? Math.max(0, Math.min(1, desiredLeft / range.x)) : 0.5;
  vehiclePhotoPosition.y = range.y ? Math.max(0, Math.min(1, desiredTop / range.y)) : 0.5;
  applyVehiclePhotoPosition();
  saveVehiclePhotoPosition();
}

function finishVehiclePhotoDrag(event) {
  if (!vehiclePhotoDrag || vehiclePhotoDrag.pointerId !== event.pointerId) return;
  vehiclePhotoDrag = null;
  movableVehiclePhoto.classList.remove('is-dragging');
  if (movableVehiclePhoto.hasPointerCapture(event.pointerId)) movableVehiclePhoto.releasePointerCapture(event.pointerId);
  saveVehiclePhotoPosition();
}

movableVehiclePhoto.addEventListener('dragstart', event => event.preventDefault());
movableVehiclePhoto.addEventListener('pointerdown', event => {
  if (event.button !== 0 || vehiclePhotoDrag || vehiclePhotoResize || event.target.closest('.vehicle-photo-resize-handle')) return;
  event.preventDefault();
  const range = vehiclePhotoMovementRange();
  vehiclePhotoDrag = {
    pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
    left: range.x * vehiclePhotoPosition.x, top: range.y * vehiclePhotoPosition.y
  };
  movableVehiclePhoto.setPointerCapture(event.pointerId);
  movableVehiclePhoto.focus({ preventScroll: true });
  movableVehiclePhoto.classList.add('is-dragging');
});
movableVehiclePhoto.addEventListener('pointermove', event => {
  if (!vehiclePhotoDrag || vehiclePhotoDrag.pointerId !== event.pointerId) return;
  const range = vehiclePhotoMovementRange();
  const left = vehiclePhotoDrag.left + event.clientX - vehiclePhotoDrag.clientX;
  const top = vehiclePhotoDrag.top + event.clientY - vehiclePhotoDrag.clientY;
  if (range.x) vehiclePhotoPosition.x = Math.max(0, Math.min(1, left / range.x));
  if (range.y) vehiclePhotoPosition.y = Math.max(0, Math.min(1, top / range.y));
  applyVehiclePhotoPosition();
});
movableVehiclePhoto.addEventListener('pointerup', finishVehiclePhotoDrag);
movableVehiclePhoto.addEventListener('pointercancel', finishVehiclePhotoDrag);
movableVehiclePhoto.addEventListener('lostpointercapture', finishVehiclePhotoDrag);
function resetVehiclePhotoPosition() {
  vehiclePhotoPosition = { ...defaultVehiclePhotoPosition };
  vehiclePhotoScale = defaultVehiclePhotoScale;
  movableVehiclePhoto.style.width = `${vehiclePhotoBaseWidth}px`;
  const ratio = vehiclePhotoImage.naturalWidth ? vehiclePhotoImage.naturalHeight / vehiclePhotoImage.naturalWidth : 170 / 280;
  movableVehiclePhoto.style.height = `${vehiclePhotoBaseWidth * ratio}px`;
  applyVehiclePhotoPosition();
  saveVehiclePhotoPosition();
}
movableVehiclePhoto.addEventListener('dblclick', resetVehiclePhotoPosition);
movableVehiclePhoto.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') { resetVehiclePhotoPosition(); return; }
  const range = vehiclePhotoMovementRange();
  const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y';
  if (!range[axis]) return;
  const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const nextPixels = range[axis] * vehiclePhotoPosition[axis] + direction * (event.shiftKey ? 10 : 2);
  vehiclePhotoPosition[axis] = Math.max(0, Math.min(1, nextPixels / range[axis]));
  applyVehiclePhotoPosition();
  saveVehiclePhotoPosition();
});
vehiclePhotoResizeHandles.forEach(handle => {
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || vehiclePhotoResize) return;
    event.preventDefault();
    event.stopPropagation();
    const range = vehiclePhotoMovementRange();
    vehiclePhotoResize = {
      handle,
      corner: handle.dataset.corner,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      width: movableVehiclePhoto.offsetWidth,
      height: movableVehiclePhoto.offsetHeight,
      left: range.x * vehiclePhotoPosition.x,
      top: range.y * vehiclePhotoPosition.y
    };
    handle.setPointerCapture(event.pointerId);
    movableVehiclePhoto.focus({ preventScroll: true });
  });
  handle.addEventListener('pointermove', event => {
    if (!vehiclePhotoResize || vehiclePhotoResize.handle !== handle || vehiclePhotoResize.pointerId !== event.pointerId) return;
    const horizontalSign = vehiclePhotoResize.corner.includes('e') ? 1 : -1;
    const verticalSign = vehiclePhotoResize.corner.includes('s') ? 1 : -1;
    const aspect = vehiclePhotoResize.width / vehiclePhotoResize.height;
    const dx = (event.clientX - vehiclePhotoResize.clientX) * horizontalSign;
    const dyAsWidth = (event.clientY - vehiclePhotoResize.clientY) * verticalSign * aspect;
    const targetWidth = vehiclePhotoResize.width + (Math.abs(dx) >= Math.abs(dyAsWidth) ? dx : dyAsWidth);
    vehiclePhotoScale = Math.max(minimumVehiclePhotoScale, Math.min(maximumVehiclePhotoScale, targetWidth / vehiclePhotoBaseWidth));
    const nextWidth = vehiclePhotoBaseWidth * vehiclePhotoScale;
    const nextHeight = nextWidth / aspect;
    movableVehiclePhoto.style.width = `${nextWidth}px`;
    movableVehiclePhoto.style.height = `${nextHeight}px`;
    const desiredLeft = vehiclePhotoResize.corner.includes('w')
      ? vehiclePhotoResize.left + vehiclePhotoResize.width - nextWidth : vehiclePhotoResize.left;
    const desiredTop = vehiclePhotoResize.corner.includes('n')
      ? vehiclePhotoResize.top + vehiclePhotoResize.height - nextHeight : vehiclePhotoResize.top;
    const range = vehiclePhotoMovementRange();
    vehiclePhotoPosition.x = range.x ? Math.max(0, Math.min(1, desiredLeft / range.x)) : 0.5;
    vehiclePhotoPosition.y = range.y ? Math.max(0, Math.min(1, desiredTop / range.y)) : 0.5;
    applyVehiclePhotoPosition();
  });
});
function finishVehiclePhotoResize(event) {
  if (!vehiclePhotoResize || vehiclePhotoResize.pointerId !== event.pointerId) return;
  const handle = vehiclePhotoResize.handle;
  vehiclePhotoResize = null;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  saveVehiclePhotoPosition();
}
vehiclePhotoResizeHandles.forEach(handle => {
  handle.addEventListener('pointerup', finishVehiclePhotoResize);
  handle.addEventListener('pointercancel', finishVehiclePhotoResize);
  handle.addEventListener('lostpointercapture', finishVehiclePhotoResize);
});
new ResizeObserver(applyVehiclePhotoPosition).observe(vehiclePhotoStage);

function fitVehiclePhoto() {
  const photo = vehiclePhotoImage;
  if (!photo.naturalWidth) return;
  movableVehiclePhoto.style.width = `${vehiclePhotoBaseWidth * vehiclePhotoScale}px`;
  movableVehiclePhoto.style.height = `${vehiclePhotoBaseWidth * vehiclePhotoScale * photo.naturalHeight / photo.naturalWidth}px`;
  applyVehiclePhotoPosition();
}
$('#vehiclePhoto').addEventListener('load', fitVehiclePhoto);
window.addEventListener('resize', fitVehiclePhoto);
window.desktop.onVehiclePhotoUpdated(({ inputKey, previousImageUrl, vehicle }) => {
  const photo = $('#vehiclePhoto');
  if (currentEstimateKey() !== inputKey || photo.dataset.imageUrl !== previousImageUrl || !vehicle?.imageData) return;
  photo.dataset.imageUrl = vehicle.imageUrl;
  photo.src = vehicle.imageData;
  photo.hidden = false;
  movableVehiclePhoto.hidden = false;
  $('#vehiclePhotoCard').hidden = false;
  $('#vehiclePhotoNote').textContent = '车型参考图，非实车照片';
  if (lastSuccessfulQuote?.key === inputKey) lastSuccessfulQuote.result.vehicle = vehicle;
});
$('#vehiclePhoto').addEventListener('error', () => {
  $('#vehiclePhoto').hidden = true;
  movableVehiclePhoto.hidden = true;
  $('#vehiclePhotoNote').textContent = '车型参考图片暂时无法加载，不影响报价';
});

$('#mileageInput').addEventListener('input', () => {
  scheduleEstimate(650);
});

async function refreshLoginStatus() {
  try {
    renderAccounts(await window.desktop.getAccounts());
  } catch (error) {
    appendLocalLog('检查会话失败：' + error.message);
  }
}

window.desktop.onAuthState(({ phase }) => {
  if (phase === 'login-required') formMessage.textContent = '';
  if (estimateRunning && !hasDisplayedPriceForCurrentEstimate() && phase === 'login-required') setPriceLoading(true);
  if (estimateRunning && !hasDisplayedPriceForCurrentEstimate() && phase === 'querying') setPriceLoading(true);
});

function showPrices(result) {
  setPriceLoading(false);
  const purchaseLow = result?.prices?.good?.low;
  const purchaseHigh = result?.prices?.good?.high;
  if (!Number.isFinite(purchaseLow) || !Number.isFinite(purchaseHigh)) {
    clearPrices('');
    appendLocalLog('忽略结构不完整的旧报价缓存');
    return false;
  }
  const vehicle = result.vehicle || {};
  const imageSource = vehicle.imageData || vehicle.imageUrl;
  $('#vehiclePhoto').dataset.imageUrl = vehicle.imageUrl || '';
  $('#vehiclePhotoCard').hidden = !imageSource;
  if (imageSource) {
    $('#vehiclePhoto').hidden = false;
    movableVehiclePhoto.hidden = false;
    $('#vehiclePhoto').alt = vehicle.name || '车型参考图片';
    $('#vehiclePhoto').style.width = '';
    $('#vehiclePhoto').src = imageSource;
    $('#vehiclePhotoTitle').textContent = vehicle.name || '车型参考图片';
    $('#vehiclePhotoNote').textContent = '车型参考图，非实车照片';
  }
  $('#primaryPrice').textContent = purchaseLow.toFixed(2) + '万 ～ ' + purchaseHigh.toFixed(2) + ' 万';
  $('#resultBody').textContent = '';
  resultCard.hidden = false;
  return true;
}

function currentEstimateInput() {
  const locationValue = state.location;
  const registration = state.registrationYear && state.registrationMonth
    ? state.registrationYear + '-' + state.registrationMonth.padStart(2, '0')
    : '';
  const mileage = Number($('#mileageInput').value);

  const month = Number(state.registrationMonth);
  const year = Number(state.registrationYear);
  if (!state.model || !locationValue || !registration || !Number.isFinite(mileage) || mileage <= 0 || mileage > 100
    || month < 1 || month > 12 || !registrationYearRange().includes(year)
    || !/^\d+(?:\.\d+)?$/.test($('#mileageInput').value.trim())) return null;
  const { provinceId, cityId } = locationValue;
  if (![provinceId, cityId, state.model.id].every(id => /^\d+$/.test(id))) return null;
  return { provinceId, cityId, modelId: state.model.id, registration, mileage };
}

function currentEstimateKey() {
  const input = currentEstimateInput();
  return input ? JSON.stringify(input) : '';
}

function hasDisplayedPriceForCurrentEstimate() {
  const key = currentEstimateKey();
  return Boolean(key && lastSuccessfulQuote?.key === key && !resultCard.hidden);
}

function scheduleEstimate(delay = 120) {
  clearTimeout(estimateTimer);
  const key = currentEstimateKey();
  if (key && key === pendingEstimateKey && estimateRunning) {
    if (!hasDisplayedPriceForCurrentEstimate()) setPriceLoading(true);
    return;
  }
  if (key && key === lastSubmittedKey && !estimateRunning && lastSuccessfulQuote?.key === key) {
    showPrices(lastSuccessfulQuote.result);
    return;
  }
  estimateRevision += 1;
  latestQuoteRequestId = null;
  earlyQuoteUpdates.clear();
  window.desktop.cancelEstimate();
  estimateRunning = false;
  pendingEstimateKey = key;
  lastSubmittedKey = '';
  clearPrices(key ? '正在准备报价…' : '填写完整后自动估价');
  formMessage.textContent = '';
  updateAccountButtons();
  if (!key) return;
  setPriceLoading(true);
  estimateTimer = setTimeout(runAutomaticEstimate, delay);
}

async function runAutomaticEstimate() {
  if (manualLoginRunning) return;
  const estimateInput = currentEstimateInput();
  if (!estimateInput) return;
  const key = JSON.stringify(estimateInput);
  if (estimateRunning && key === pendingEstimateKey) return;
  const revision = estimateRevision;
  pendingEstimateKey = key;
  lastSubmittedKey = key;
  estimateRunning = true;
  clearPrices('正在查询当前车辆…');
  setPriceLoading(true);
  updateAccountButtons();
  formMessage.textContent = '';
  appendLocalLog('自动估价：' + key);

  try {
    const result = await window.desktop.estimate(estimateInput);
    if (revision !== estimateRevision || currentEstimateKey() !== key) return;
    if (!result.ok) throw new Error(result.message || '暂时无法获取报价');
    latestQuoteRequestId = result.requestId;
    const displayedResult = earlyQuoteUpdates.get(result.requestId) || result;
    earlyQuoteUpdates.delete(result.requestId);
    lastSubmittedKey = key;
    lastSuccessfulQuote = { key, result: displayedResult };
    showPrices(displayedResult);
    formMessage.textContent = '';
    await refreshLoginStatus();
    appendLocalLog('估值完成，结果来源：' + (result.cached ? '本地缓存' : '实时数据'));
  } catch (error) {
    if (revision !== estimateRevision || currentEstimateKey() !== key) return;
    lastSubmittedKey = key;
    formMessage.textContent = '';
    clearPrices(error.message || '本次估值失败');
    appendLocalLog('估值失败：' + (error.message || '未知错误'));
  } finally {
    if (revision !== estimateRevision) return;
    estimateRunning = false;
    pendingEstimateKey = '';
    updateAccountButtons();
  }
}

function setPriceLoading(loading) {
  const price = $('#primaryPrice');
  price.classList.toggle('is-loading', loading);
  resultCard.setAttribute('aria-busy', String(loading));
  if (loading) {
    price.textContent = '';
    price.setAttribute('aria-label', '加载中');
  } else price.removeAttribute('aria-label');
}

function updateAccountButtons() {
  const busy = estimateRunning || manualLoginRunning;
  $('#addAccount').disabled = busy;
  document.querySelectorAll('.account-actions button').forEach(button => {
    button.disabled = busy || button.dataset.current === 'true' || button.dataset.checking === 'true';
  });
}

function renderAccounts(accounts) {
  const container = $('#accountList');
  container.replaceChildren();
  if (!accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'account-policy';
    empty.textContent = '未登录，请添加账号';
    container.append(empty);
  }
  const statuses = {
    authenticated: '登录已确认', unchecked: '正在验证登录', 'signed-out': '未登录',
    checking: '检查中', expired: '登录已失效', 'login-required': '等待登录',
    cancelled: '登录未完成', unknown: '暂时无法确认', authenticating: '登录中', syncing: '同步登录状态',
    cooldown: '估值冷却中', deleting: '删除中'
  };
  accounts.forEach(account => {
    const card = document.createElement('section');
    card.className = 'account-item' + (account.active ? ' current' : '');
    const loginBusy = Boolean(account.loginInProgress || ['authenticating', 'syncing'].includes(account.status));
    if (loginBusy) {
      const spinner = document.createElement('span');
      spinner.className = 'account-login-spinner';
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-label', account.label + '正在登录');
      card.append(spinner);
    }
    const heading = document.createElement('strong');
    heading.textContent = account.label + (account.phoneMask ? ' · ' + account.phoneMask : '')
      + (account.active ? ' · 当前使用' : '');
    const status = document.createElement('span');
    status.className = 'account-item-status' + (account.status === 'authenticated' ? ' verified' : '');
    status.textContent = statuses[account.status] || '待验证';
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const login = document.createElement('button');
    login.type = 'button';
    login.textContent = account.status === 'authenticated' ? '重新登录' : '登录';
    login.addEventListener('click', () => accountAction(() => window.desktop.loginAccount(account.id)));
    const select = document.createElement('button');
    select.type = 'button';
    select.textContent = account.active ? '使用中' : '切换使用';
    select.dataset.current = String(account.active);
    select.addEventListener('click', () => accountAction(() => window.desktop.selectAccount(account.id)));
    const refresh = document.createElement('button');
    refresh.type = 'button';
    const checking = account.status === 'checking' || account.status === 'unchecked';
    refresh.textContent = checking ? '验证中…' : '刷新';
    refresh.dataset.checking = String(checking || account.loginInProgress);
    refresh.setAttribute('aria-label', '刷新' + account.label + '的登录状态');
    refresh.setAttribute('aria-busy', String(checking));
    refresh.addEventListener('click', async () => {
      if (refresh.disabled) return;
      refresh.disabled = true;
      refresh.textContent = '验证中…';
      try { renderAccounts(await window.desktop.refreshAccount(account.id)); }
      catch (error) { appendLocalLog('验证账号失败：' + (error.message || '未知错误')); await refreshLoginStatus(); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-account-button';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', '删除' + account.label);
    remove.dataset.checking = String(checking || account.loginInProgress || account.status === 'deleting');
    remove.addEventListener('click', async () => {
      if (remove.disabled || estimateRunning || manualLoginRunning) return;
      manualLoginRunning = true;
      updateAccountButtons();
      try { renderAccounts(await window.desktop.deleteAccount(account.id)); }
      catch (error) {
        appendLocalLog('删除账号未完成：' + (error.message || '未知错误'));
        await refreshLoginStatus();
      } finally {
        manualLoginRunning = false;
        updateAccountButtons();
      }
    });
    actions.append(login, select, refresh, remove);
    card.append(heading, status, actions);
    container.append(card);
  });
  updateAccountButtons();
}

async function accountAction(task) {
  if (estimateRunning || manualLoginRunning) return;
  manualLoginRunning = true;
  updateAccountButtons();
  try {
    const result = await task();
    if (result?.authenticated) {
      lastSubmittedKey = '';
      formMessage.textContent = '';
    }
    await refreshLoginStatus();
  } catch (error) {
    formMessage.textContent = '';
    appendLocalLog('账号操作失败：' + (error.message || '未知错误'));
  } finally {
    manualLoginRunning = false;
    updateAccountButtons();
    scheduleEstimate();
  }
}

$('#addAccount').addEventListener('click', () => accountAction(async () => {
  const account = await window.desktop.addAccount();
  return window.desktop.loginAccount(account.id);
}));
window.desktop.onAccounts(renderAccounts);
window.desktop.onQuoteUpdated(({ requestId, inputKey, result }) => {
  if (!result?.ok || result.cached || currentEstimateKey() !== inputKey) return;
  if (requestId !== latestQuoteRequestId) {
    if (estimateRunning) {
      earlyQuoteUpdates.set(requestId, result);
      if (earlyQuoteUpdates.size > 4) earlyQuoteUpdates.delete(earlyQuoteUpdates.keys().next().value);
    }
    return;
  }
  if (lastSubmittedKey !== inputKey) return;
  lastSuccessfulQuote = { key: inputKey, result };
  showPrices(result);
});
window.desktop.onModelsUpdated(({ category, brandId, seriesId, items }) => {
  if (state.category !== category || state.brand?.id !== brandId || state.series?.id !== seriesId) return;
  const scrollTop = trimList.scrollTop;
  state.models = items;
  if (state.model) {
    const selected = items.find(item => item.id === state.model.id);
    if (selected) {
      state.model = selected;
      syncVehicleFields();
    }
  }
  renderModels();
  trimList.scrollTop = scrollTop;
});

$('#clearLog').addEventListener('click', () => {
  logOutput.textContent = '';
  seenLogIds.clear();
});

window.desktop.onLog(appendLog);
window.desktop.getLogs()
  .then((entries) => entries.forEach(appendLog))
  .catch((error) => appendLocalLog('读取历史日志失败：' + error.message));

refreshLoginStatus();
clearPrices();
appendLocalLog('界面已就绪');
