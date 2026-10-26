import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

process.umask(0o077);
export const ROOT = path.join(os.homedir(), 'Library/Application Support/GymMonitor');
const CONFIG = path.join(ROOT, 'config.json');
const STATE = path.join(ROOT, 'state.json');
const CONTROL = path.join(ROOT, 'telegram-control.json');
const GOOGLE_REQUEST = path.join(ROOT, 'google-request.json');
const GOOGLE_INTERVAL_MS = 10 * 60000;
const LABEL = 'local.gym-monitor';
const WATCH_LABEL = LABEL + '.watchdog';
const WATCH_PLIST = path.join(os.homedir(), 'Library/LaunchAgents', WATCH_LABEL + '.plist');
let failureStage = 'startup';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const DEFAULTS = {
  name: 'K GYM & YOGA',
  query: 'K GYM & YOGA, 34 Sao Bien, Nha Trang, Vietnam',
  placeId: 'ChIJf65qrANncDERt9DWpG_ryC8',
  featureId: '0x31706703ac6aae7f:0x2fc8eb6fa4d6d0b7',
  url: 'https://www.google.com/maps?cid=3443260779864182967&hl=en',
  timezone: 'Asia/Ho_Chi_Minh',
  threshold: 30, rearmThreshold: 45,
  confirmations: 3, cooldownMinutes: 60,
  startHour: 9, endHour: 20,
  // Minutes since midnight, Sunday first. Verified against this venue's Maps card.
  weeklyHours: [[360, 720], [330, 1200], [330, 1200], [330, 1200], [330, 1200], [330, 1200], [330, 1200]],
  browserEnabled: false,
  browserHeadless: true,
  telegramToken: '', telegramChatId: '',
};
const read = (p, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
function write(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
  fs.chmodSync(p, 0o600);
}
function log(value) {
  const p = path.join(ROOT, 'history.jsonl');
  if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) {
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\n').slice(-1000).join('\n'));
  }
  fs.appendFileSync(p, JSON.stringify(value) + '\n', { mode: 0o600 });
}
function reportFatal(e) {
  // Raw JSON parser errors may expose config fragments, including credentials.
  const event = { checkedAt: new Date().toISOString(), status: 'fatal', stage: failureStage,
    code: /^[A-Z_]+$/.test(e.code ?? '') ? e.code : 'FAILED' };
  try { log(event); } catch {}
  try { write(path.join(ROOT, 'fatal.json'), event); } catch {}
  console.error(JSON.stringify(event));
}
function config() {
  const c = { ...DEFAULTS, ...read(CONFIG) };
  if (!Number.isFinite(c.threshold) || c.threshold < 0 || c.threshold > 100 ||
      !Number.isFinite(c.rearmThreshold) || c.rearmThreshold <= c.threshold || c.rearmThreshold > 100 ||
      !Number.isInteger(c.confirmations) || c.confirmations < 3 ||
      !Number.isFinite(c.cooldownMinutes) || c.cooldownMinutes < 0 ||
      !Number.isInteger(c.startHour) || !Number.isInteger(c.endHour) ||
      c.startHour < 0 || c.endHour > 24 || c.startHour >= c.endHour ||
      !Array.isArray(c.weeklyHours) || c.weeklyHours.length !== 7 ||
      c.weeklyHours.some(h => !Array.isArray(h) || h.length !== 2 || !h.every(Number.isFinite) || h[0] < 0 || h[1] > 1440 || h[0] > h[1])) {
    throw new Error('Некорректные пороги или часы в config.json');
  }
  return c;
}
export function inHours(c, now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: c.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [open, close] = c.weeklyHours[day];
  return minutes >= open && minutes < close && minutes >= c.startHour * 60 && minutes < c.endHour * 60;
}

// Only accept a record matching this exact place; never use nearby search results.
export function findPlace(tree, c = DEFAULTS) {
  if (!Array.isArray(tree)) return null;
  if (tree[78] === c.placeId || tree[10] === c.featureId) return tree;
  for (const item of tree) {
    const found = findPlace(item, c);
    if (found) return found;
  }
  return null;
}
export function sampleFromPlace(place, source) {
  const raw = place?.[84]?.[7]?.[1];
  // Maps has returned transient zeroes at an hourly rollover, immediately
  // followed by 100. We cannot distinguish these from a genuinely empty gym.
  // Fail closed rather than tell the user to go based on an ambiguous zero.
  const live = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : null;
  return {
    checkedAt: new Date().toISOString(), source, name: place?.[11],
    live, liveText: place?.[84]?.[6] ?? null,
    ...(raw === 0 ? { rawLive: 0, reason: 'unreliable_zero' } : {}),
    status: live === null ? 'no_live_data' : 'live',
  };
}
export function parseSearch(text, c = DEFAULTS) {
  const body = text.split('/*""*/')[0];
  const envelope = JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
  const payload = JSON.parse(envelope.d.replace(/^\)\]\}'\s*/, ''));
  const place = findPlace(payload, c);
  if (!place) throw new Error('Google не вернул ожидаемую карточку зала');
  return sampleFromPlace(place, 'google_search');
}
async function fetchSample(c) {
  const url = new URL('https://www.google.com/search');
  for (const [key, value] of Object.entries({ tbm: 'map', tch: '1', hl: 'en', q: c.query })) {
    url.searchParams.set(key, value);
  }
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Google HTTP ${r.status}`);
  try { return parseSearch(await r.text(), c); }
  catch { throw new Error('Не удалось прочитать данные Google: ограниченный доступ или изменился формат'); }
}
async function chrome() {
  const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright-core/index.mjs')).href);
  try {
    const major = execFileSync('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleShortVersionString', '/Applications/Google Chrome.app/Contents/Info.plist',
    ], { encoding: 'utf8', timeout: 5000 }).trim().split('.')[0];
    if (!/^\d+$/.test(major)) throw new Error('Cannot determine Chrome version');
    return await chromium.launchPersistentContext(path.join(ROOT, 'chrome-profile'), {
      // Scheduled checks must never open a browser window, even if an old config
      // file still contains browserHeadless=false. Only explicit login opens one.
      channel: 'chrome', headless: true, chromiumSandbox: true,
      // Maps serves its full desktop view for this installed Chrome's desktop UA.
      // Keep the actual installed version and normal automation flags intact.
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      // Keep macOS's real encrypted storage, matching the manual sign-in browser.
      // Playwright's test keychain cannot decrypt that profile's cookies.
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic', '--unsafely-disable-devtools-self-xss-warnings'],
      locale: 'en-US', timezoneId: 'Asia/Ho_Chi_Minh',
      viewport: { width: 1280, height: 1000 }, timeout: 30000,
    });
  } catch (e) {
    const reason = /ProcessSingleton|SingletonLock|already in use/i.test(e.message)
      ? 'Профиль уже открыт: закройте отдельное окно Chrome и повторите запуск.'
      : 'Проверьте установленный Google Chrome и разрешения macOS.';
    throw new Error(`Не удалось запустить Chrome. ${reason}`);
  }
}
async function readBrowserPage(page, c, responsePlace = null) {
  if (await page.getByRole('button', { name: /^Hours.*Closed/i }).count()) {
    return { checkedAt: new Date().toISOString(), status: 'closed', live: null, source: 'google_maps_browser' };
  }
  if (responsePlace) return sampleFromPlace(responsePlace, 'google_maps_browser');
  // Read the same place record as the HTTP source from the currently rendered Maps page.
  const initial = await page.evaluate(() => window.APP_INITIALIZATION_STATE ?? null);
  const direct = findPlace(initial, c);
  if (direct) return sampleFromPlace(direct, 'google_maps_browser');
  function embedded(tree) {
    if (typeof tree === 'string' && tree.startsWith(")]}'")) {
      try { return findPlace(JSON.parse(tree.slice(4)), c); } catch { return null; }
    }
    if (Array.isArray(tree)) {
      for (const item of tree) { const result = embedded(item); if (result) return result; }
    }
    return null;
  }
  const place = embedded(initial);
  return sampleFromPlace(place, 'google_maps_browser');
}
export async function browserSample(c, { verifyLive = false } = {}) {
  const context = await chrome();
  const watchdog = setTimeout(() => context.close().catch(() => {}), 70000);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    // Modern Maps may load place details separately from its initial page data.
    let responsePlace = null;
    const pending = new Set();
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.hostname.endsWith('.google.com') || url.pathname !== '/maps/preview/place') return;
      const task = (async () => {
        try {
          const body = (await response.text()).replace(/^\)\]\}'\s*/, '');
          const place = findPlace(JSON.parse(body), c);
          if (place) responsePlace = place;
        } catch { /* Other requests and partial responses are not live data. */ }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Bounded wait for the Maps place panel rather than the map's ongoing network traffic.
    await page.getByRole('heading', { name: c.name, exact: true }).waitFor({ timeout: 20000 });
    await Promise.allSettled([...pending]);
    let sample = await readBrowserPage(page, c, responsePlace);
    if (sample.live === null) {
      // Maps sometimes loads the place details after its initial heading.
      try { await page.getByText('Popular times', { exact: true }).waitFor({ timeout: 10000 }); } catch {}
      await Promise.allSettled([...pending]);
      sample = await readBrowserPage(page, c, responsePlace);
    }
    if (verifyLive) {
      try {
        await page.locator('[aria-label^="Currently "]').first().waitFor({ state: 'visible', timeout: 10000 });
      } catch { /* A missing rendered live chart must suppress the alert. */ }
      const labels = [];
      const bars = page.locator('[aria-label^="Currently "]');
      for (let i = 0; i < await bars.count(); i++) {
        const bar = bars.nth(i);
        if (await bar.isVisible()) labels.push(await bar.getAttribute('aria-label'));
      }
      sample = verifyChart(sample, labels);
    }
    return sample;
  } catch {
    throw new Error('Chrome не смог прочитать карточку. Откройте «Настроить.command» и проверьте вход Google');
  } finally {
    clearTimeout(watchdog);
    await context.close();
  }
}
export function verifyChart(sample, labels) {
  const values = labels.map(label => /^Currently (\d+)% busy, usually \d+% busy\.$/.exec(label ?? ''));
  const domLive = values.length === 1 && values[0] ? Number(values[0][1]) : null;
  const chartVerified = sample.status === 'live' && domLive === sample.live && domLive > 0;
  return { ...sample, checkedAt: new Date().toISOString(), apiLive: sample.live, domLive, chartVerified,
    ...(chartVerified ? {} : { status: 'no_live_data', live: null,
      reason: domLive === null ? 'missing_live_chart' : 'live_chart_mismatch' }) };
}
export function lowMessage(c, sample) {
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(sample.checkedAt));
  return `🏋️ ${c.name} — низкая загрузка\n` +
    `По данным Google: ${sample.live} из 100 на ${time}\n${c.url}`;
}
async function telegram(c, method, body) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(c.telegramToken)) throw new Error('Токен Telegram не настроен');
  // Never include the URL or original fetch error in logs: it contains the bot token.
  let result;
  try {
    const r = await fetch(`https://api.telegram.org/bot${c.telegramToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    result = await r.json();
  } catch { throw new Error('Не удалось соединиться с Telegram'); }
  if (!result.ok) throw new Error(`Telegram отклонил запрос (код ${result.error_code ?? 'unknown'})`);
  return result.result;
}
const pauseKeyboard = { inline_keyboard: [[{ text: '🏋️ Уже сходил — выключить на сегодня', callback_data: 'gym:stop' }]] };
async function send(c, text, replyMarkup = pauseKeyboard, chatId = c.telegramChatId) {
  await telegram(c, 'sendMessage', { chat_id: chatId, text,
    link_preview_options: { is_disabled: true }, reply_markup: replyMarkup });
}

export function localDay(timezone, now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function nextMidnight(timezone, now = Date.now()) {
  const today = localDay(timezone, now);
  let lo = now, hi = now + 36 * 3600000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(timezone, mid) === today) lo = mid;
    else hi = mid;
  }
  return new Date(hi).toISOString();
}
export function subscribers(control, c) {
  const result = { ...control.subscribers };
  const owner = String(c.telegramChatId ?? '');
  if (owner && !result[owner]) result[owner] = { mutedUntil: control.mutedUntil ?? null };
  return result;
}
export function controlCommand(update, c) {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  if (message?.chat?.type !== 'private' ||
      String((callback?.from ?? message.from)?.id) !== String(message.chat.id)) return null;
  if (callback) return callback.data === 'gym:stop' ? 'stop' : null;
  const text = (message.text ?? '').trim().toLowerCase();
  if (/^\/start(?:@[a-z0-9_]+)?(?:\s.*)?$/.test(text)) return 'start';
  if (text === 'stop' || text === '/stop') return 'stop';
  if (text === '/resume') return 'resume';
  return null;
}
export async function pollCommands(c) {
  if (!c.telegramToken) return true;
  const control = read(CONTROL);
  control.subscribers = subscribers(control, c);
  const updates = await telegram(c, 'getUpdates', { offset: control.offset ?? 0,
    timeout: 0, limit: 100, allowed_updates: ['message', 'callback_query'] });
  for (const update of updates) {
    let command = controlCommand(update, c);
    const chatId = String((update.callback_query?.message ?? update.message)?.chat?.id ?? '');
    if (!control.subscribers[chatId] && command !== 'start') command = null;
    const message = update.message;
    // A queued stop from a previous day must not mute a new day after sleep.
    const stale = message?.date && localDay(c.timezone, message.date * 1000) !== localDay(c.timezone);
    if (command && !stale) {
      const previous = control.subscribers[chatId] ?? {};
      control.subscribers[chatId] = { ...previous,
        mutedUntil: command === 'stop' ? nextMidnight(c.timezone) : null,
        revision: (previous.revision ?? 0) + 1, changedAt: new Date().toISOString() };
      if (chatId === String(c.telegramChatId)) control.mutedUntil = control.subscribers[chatId].mutedUntil;
    }
    control.offset = update.update_id + 1;
    // Persist the pause before acknowledging or making outgoing network requests.
    write(CONTROL, control);
    if (!command) continue;
    const text = stale ? 'Эта команда была отправлена в другой день. Отправьте её ещё раз.'
      : command === 'stop'
        ? '✅ Для вас на сегодня уведомления выключены до 00:00 по времени Нячанга. Завтра возобновятся автоматически. Вернуть сейчас: /resume'
        : command === 'start'
          ? `✅ Вы подписаны на мониторинг ${c.name}. Низкая загрузка: 1–${c.threshold} из 100 после ${c.confirmations} подтверждений. Проверки Google раз в 10 минут в часы мониторинга по Нячангу, пока Mac владельца работает. Пауза на сегодня: /stop. Вернуть уведомления: /resume.`
          : '✅ Для вас уведомления включены. Действуют обычные пороги и интервалы проверок.';
    try {
      if (update.callback_query) {
        await telegram(c, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: '✅ На сегодня уведомления выключены' });
      }
    } catch { /* A callback may expire while the Mac is asleep. */ }
    try {
      await send(c, text, !stale && command === 'stop' ? { inline_keyboard: [] } : pauseKeyboard, chatId);
    } catch { log({ checkedAt: new Date().toISOString(), status: 'command_reply_failed' }); }
  }
  // A stop can be in the next batch; drain the backlog before allowing alerts.
  return updates.length < 100;
}

export function decide(previous, sample, c, now = Date.now()) {
  // Also reject zeroes from old samples or another source before counting them.
  if (sample.status === 'live' &&
      (!Number.isFinite(sample.live) || sample.live <= 0 || sample.live > 100)) {
    sample = { ...sample, rawLive: sample.live, live: null, status: 'no_live_data',
      reason: sample.live === 0 ? 'unreliable_zero' : 'invalid_live' };
  }
  const s = { ...previous, lastCheck: sample.checkedAt, latest: sample };
  if (Date.parse(s.mutedUntil) > now) {
    s.lowCount = 0; s.lastLowConfirmation = null; s.firstLowConfirmation = null; s.lowNotified = false;
    // Pausing resets confirmations, but must preserve the alert cooldown.
    s.failures = 0; s.issueNotified = false;
    return { state: s, action: null };
  }
  if (!inHours(c, now) || ['outside_hours', 'closed', 'paused'].includes(sample.status)) {
    s.lowCount = 0;
    s.lastLowConfirmation = null; s.firstLowConfirmation = null;
    return { state: s, action: null };
  }
  if (sample.status !== 'live') {
    s.lowCount = 0;
    s.lastLowConfirmation = null; s.firstLowConfirmation = null;
    s.failures = (s.failures ?? 0) + 1;
    return { state: s, action: s.failures >= 3 && !s.issueNotified ? 'unavailable' : null };
  }
  s.failures = 0;
  s.issueNotified = false;
  s.lastLiveAt = sample.checkedAt;
  if (sample.live >= c.rearmThreshold) {
    s.lowNotified = false; s.lowCount = 0; s.lastLowConfirmation = null; s.firstLowConfirmation = null;
  } else if (sample.live <= c.threshold) {
    const gap = now - Date.parse(previous.lastCheck);
    const contiguous = previous.latest?.status === 'live' &&
      Number.isFinite(previous.latest.live) && previous.latest.live > 0 &&
      previous.latest.live <= c.threshold && gap >= 0 && gap <= GOOGLE_INTERVAL_MS + 3 * 60000;
    const elapsed = now - Date.parse(previous.lastLowConfirmation);
    if (!contiguous || !s.firstLowConfirmation || !s.lowCount || !Number.isFinite(elapsed) || elapsed < 0) {
      s.lowCount = 1;
      s.firstLowConfirmation = new Date(now).toISOString();
      s.lastLowConfirmation = new Date(now).toISOString();
    } else if (elapsed >= 10 * 60000) {
      s.lowCount += 1;
      s.lastLowConfirmation = new Date(now).toISOString();
    }
  } else { s.lowCount = 0; s.lastLowConfirmation = null; s.firstLowConfirmation = null; }
  const cooledDown = !s.lastAlert || now - Date.parse(s.lastAlert) >= c.cooldownMinutes * 60000;
  return { state: s, action: s.lowCount >= Math.max(3, c.confirmations) && now - Date.parse(s.firstLowConfirmation) >= 20 * 60000 && !s.lowNotified && cooledDown ? 'low' : null };
}
export async function check({ dry = false, http = false, verifyLive = false } = {}) {
  failureStage = 'config';
  const c = config();
  failureStage = 'lock';
  const lock = path.join(ROOT, 'check.lock');
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (Date.now() - fs.statSync(lock).mtimeMs < 5 * 60000) return console.log('Проверка уже выполняется');
    fs.rmdirSync(lock); fs.mkdirSync(lock);
  }
  try {
    let commandsReady = true;
    const refreshCommands = async () => {
      try { commandsReady = await pollCommands(c); }
      catch { commandsReady = false; }
    };
    if (!dry) await refreshCommands();
    const paused = !dry && Object.values(subscribers(read(CONTROL), c)).every(s => Date.parse(s.mutedUntil) > Date.now());
    const outsideHours = !dry && !inHours(c);
    if (!dry && !paused && !outsideHours) {
      const lastRequest = Date.parse(read(GOOGLE_REQUEST).requestedAt);
      const elapsed = Date.now() - lastRequest;
      if (elapsed >= 0 && elapsed < GOOGLE_INTERVAL_MS) {
        write(path.join(ROOT, 'heartbeat.json'), { completedAt: new Date().toISOString() });
        console.log('Google: ожидание следующей проверки (интервал 10 минут)');
        return;
      }
    }
    let sample;
    try {
      // Diagnostics must not postpone scheduled checks or their confirmations.
      if (!dry && !paused && !outsideHours) write(GOOGLE_REQUEST, { requestedAt: new Date().toISOString() });
      sample = paused
        ? { checkedAt: new Date().toISOString(), status: 'paused', live: null }
        : outsideHours
        ? { checkedAt: new Date().toISOString(), status: 'outside_hours', live: null }
        : verifyLive ? await browserSample(c, { verifyLive: true }) : c.browserEnabled && !http ? await browserSample(c) : await fetchSample(c);
    } catch (e) { sample = { checkedAt: new Date().toISOString(), status: 'error', live: null, error: e.message }; }
    if (dry) { console.log(JSON.stringify(sample, null, 2)); return sample; }
    // Chrome can take over a minute; read commands again before sending alerts.
    await refreshCommands();
    failureStage = 'state_read';
    const previous = read(STATE);
    const recipients = { ...previous.recipients };
    const actions = {};
    const ready = !!c.telegramToken;
    const applySample = (currentSample) => {
      for (const [chatId, subscriber] of Object.entries(subscribers(read(CONTROL), c))) {
        let prior = recipients[chatId] ?? (chatId === String(c.telegramChatId) ? previous : {});
        if ((prior.revision ?? 0) !== (subscriber.revision ?? 0)) {
          prior = { ...prior, lowCount: 0, firstLowConfirmation: null, lastLowConfirmation: null,
            lowNotified: false, failures: 0, issueNotified: false };
        }
        const decision = decide({ ...prior, mutedUntil: subscriber.mutedUntil ?? null }, currentSample, c);
        delete decision.state.recipients;
        decision.state.revision = subscriber.revision ?? 0;
        recipients[chatId] = decision.state;
        actions[chatId] = decision.action;
      }
    };
    applySample(sample);
    let preflight = null;
    if (ready && commandsReady && Object.values(actions).includes('low') && inHours(c)) {
      try {
        // One fresh Maps navigation for the whole batch, independent of the interval cache.
        preflight = await browserSample(c, { verifyLive: true });
      } catch {
        preflight = { checkedAt: new Date().toISOString(), status: 'error', live: null,
          reason: 'preflight_failed', chartVerified: false };
      }
      await refreshCommands();
      sample = preflight;
      // The fresh read cannot add a timed confirmation. High/missing values reset the series.
      applySample(sample);
    }
    for (const chatId of Object.keys(actions)) {
      if (!ready || !commandsReady || !actions[chatId]) continue;
      await refreshCommands();
      const subscriber = subscribers(read(CONTROL), c)[chatId];
      let state = recipients[chatId];
      if (!subscriber || !commandsReady) continue;
      if ((state.revision ?? 0) !== (subscriber.revision ?? 0) || Date.parse(subscriber.mutedUntil) > Date.now()) {
        state = { ...state, lowCount: 0, firstLowConfirmation: null, lastLowConfirmation: null,
          lowNotified: false, failures: 0, issueNotified: false,
          revision: subscriber.revision ?? 0, mutedUntil: subscriber.mutedUntil ?? null };
        recipients[chatId] = state;
        actions[chatId] = null;
        continue;
      }
      if (!inHours(c)) continue;
      try {
        if (actions[chatId] === 'low') {
          if (!preflight?.chartVerified || sample.status !== 'live' || sample.live > c.threshold ||
              (Date.now() - Date.parse(sample.checkedAt) < 0 || Date.now() - Date.parse(sample.checkedAt) > 60000)) continue;
          await send(c, lowMessage(c, sample), pauseKeyboard, chatId);
          state.lastAlert = new Date().toISOString(); state.lowNotified = true;
        } else {
          await send(c, '⚠️ ' + c.name + ': три проверки подряд нет текущих данных Google. Уведомления о низкой загрузке временно невозможны. Владелец мониторинга должен проверить вход через «Настроить.command».\n' + c.url, pauseKeyboard, chatId);
          state.issueNotified = true;
        }
        state.deliveryError = null;
      } catch (e) { state.deliveryError = e.message; }
    }
    const state = { ...previous, ...recipients[String(c.telegramChatId)], latest: sample,
      lastCheck: sample.checkedAt, recipients, telegramConfigured: ready };
    failureStage = 'state_write';
    write(STATE, state);
    failureStage = 'history_write';
    log({ ...sample, actions, commandsReady, telegramConfigured: ready, deliveryError: state.deliveryError ?? null });
    failureStage = 'heartbeat_write';
    write(path.join(ROOT, 'heartbeat.json'), { completedAt: new Date().toISOString() });
    console.log(`${sample.status}: ${sample.live ?? 'нет live-данных'}; Telegram ${ready ? 'настроен' : 'не настроен'}`);
  } finally { fs.rmdirSync(lock); }
}
function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const domain = () => `gui/${process.getuid()}`;
function stop() {
  fs.rmSync(path.join(ROOT, 'watchdog-enabled.json'), { force: true });
  try { launchctl('bootout', `${domain()}/${LABEL}`); } catch {}
}
function install() {
  failureStage = 'install';
  const here = fileURLToPath(import.meta.url);
  const installed = path.join(ROOT, 'monitor.mjs');
  if (here !== installed) fs.copyFileSync(here, installed);
  const watchdogSource = path.join(path.dirname(here), 'watchdog.rb');
  const watchdogInstalled = path.join(ROOT, 'watchdog.rb');
  if (watchdogSource !== watchdogInstalled) fs.copyFileSync(watchdogSource, watchdogInstalled);
  const c = config();
  // Protected last-known credentials survive a broken config.json.
  write(path.join(ROOT, 'watchdog-config.json'), { telegramToken: c.telegramToken, telegramChatId: c.telegramChatId,
    timezone: c.timezone, startHour: c.startHour, endHour: c.endHour });
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = [process.execPath, installed, 'check', '--quiet'];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${args.map(s => `<string>${escape(s)}</string>`).join('')}</array>\n<key>StandardErrorPath</key><string>${escape(path.join(ROOT, 'launchd-errors.log'))}</string>\n<key>WorkingDirectory</key><string>${escape(ROOT)}</string>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>60</integer>\n<key>ProcessType</key><string>Background</string>\n<key>LowPriorityIO</key><true/>\n<key>ExitTimeOut</key><integer>15</integer>\n</dict></plist>\n`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  stop();
  fs.writeFileSync(PLIST, xml, { mode: 0o600 });
  launchctl('enable', `${domain()}/${LABEL}`);
  launchctl('bootstrap', domain(), PLIST);
  const watchXml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${WATCH_LABEL}</string>
<key>ProgramArguments</key><array><string>/usr/bin/ruby</string><string>${escape(watchdogInstalled)}</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>
<key>StandardErrorPath</key><string>${escape(path.join(ROOT, 'watchdog-errors.log'))}</string>
</dict></plist>`;
  try { launchctl('bootout', `${domain()}/${WATCH_LABEL}`); } catch {}
  fs.writeFileSync(WATCH_PLIST, watchXml, { mode: 0o600 });
  write(path.join(ROOT, 'watchdog-enabled.json'), { since: new Date().toISOString() });
  launchctl('enable', `${domain()}/${WATCH_LABEL}`);
  launchctl('bootstrap', domain(), WATCH_PLIST);
  console.log('Автозапуск включён: каждую минуту и при входе в macOS.');
}
async function login() {
  const lock = path.join(ROOT, 'login.lock');
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = read(path.join(lock, 'owner.json')).pid;
    let active = false;
    if (Number.isInteger(pid)) { try { process.kill(pid, 0); active = true; } catch {} }
    if (active) throw new Error('Chrome для настройки уже открыт. Найдите отдельное окно K GYM & YOGA.');
    fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
  }
  write(path.join(lock, 'owner.json'), { pid: process.pid });
  stop();
  let child;
  let completionTimer;
  let verified = false;
  try {
    const c = config();
    // Sign-in is performed by the human in ordinary Chrome, without Playwright,
    // a debugging port, automation flags or modified browser security settings.
    child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      `--user-data-dir=${path.join(ROOT, 'chrome-profile')}`,
      '--no-first-run', '--no-default-browser-check', c.url,
    ], { stdio: 'ignore' });
    const closed = new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Не удалось запустить обычный Chrome')));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    completionTimer = setInterval(() => {
      if (fs.existsSync(path.join(lock, 'complete'))) child.kill('SIGTERM');
    }, 500);
    console.log('Открываю обычный Chrome с отдельным профилем, без управления автоматизацией. Войдите в Google вручную. Затем напишите «готово» в чат.');
    const result = await closed;
    if (result.code !== 0 && result.signal !== 'SIGTERM') {
      throw new Error('Не удалось открыть отдельный профиль Chrome. Закройте прежнее окно настройки и повторите.');
    }
    c.browserEnabled = true;
    write(CONFIG, c);
    console.log('Профиль сохранён. Проверка получения live:');
    const sample = await check({ dry: true });
    if (sample?.status !== 'live') {
      throw new Error('Не удалось подтвердить live-данные. Автозапуск оставлен выключенным; повторите настройку в часы работы зала.');
    }
    verified = true;
  } finally {
    clearInterval(completionTimer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    fs.rmSync(lock, { recursive: true, force: true });
    if (verified) install();
  }
}
async function setup() {
  // A configured Telegram bot must not block opening the Google login window.
  const existing = config();
  if (existing.telegramToken && existing.telegramChatId) {
    console.log('Telegram уже подключён. Открываю Google Chrome.');
    await login();
    return;
  }
  stop();
  // Do not let the scheduled job compete for the dedicated Chrome profile.
  const sink = new Writable({ write(chunk, encoding, cb) { if (!sink.muted) process.stdout.write(chunk, encoding); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: !!process.stdin.isTTY });
  const c = config();
  try {
    console.log('Создайте бота через @BotFather (/newbot). Токен сохранится только локально.');
    process.stdout.write('Токен бота (ввод скрыт; Enter — оставить текущий): ');
    sink.muted = true;
    let token;
    try { token = (await rl.question('')).trim(); } finally { sink.muted = false; console.log(); }
    if (token) c.telegramToken = token;
    const me = await telegram(c, 'getMe', {});
    console.log(`Откройте https://t.me/${me.username} и нажмите Start.`);
    await rl.question('После Start нажмите Enter здесь. ');
    const chat = (await rl.question('Ваш числовой chat_id (Enter — определить автоматически): ')).trim();
    if (chat) c.telegramChatId = chat;
    else {
      const updates = await telegram(c, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
      const ids = [...new Set(updates.map(u => u.message?.chat).filter(x => x?.type === 'private').map(x => String(x.id)))];
      if (ids.length !== 1) throw new Error('Не удалось однозначно определить чат. Запустите настройку снова и укажите свой chat_id.');
      c.telegramChatId = ids[0];
    }
    if (!/^\d+$/.test(String(c.telegramChatId))) throw new Error('Нужен числовой ID личного чата');
    const threshold = (await rl.question(`Порог низкой загрузки 0–99 (Enter — ${c.threshold}): `)).trim();
    if (threshold) {
      const n = Number(threshold);
      if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error('Порог должен быть целым числом от 0 до 99');
      c.threshold = n; c.rearmThreshold = Math.min(100, n + 15);
    }
    write(CONFIG, c);
    await send(c, `✅ Telegram подключён к мониторингу ${c.name}. Порог: ${c.threshold}/100. Проверка Google раз в 10 минут. Доступность live-данных Google проверяется отдельно.`);
  } finally {
    rl.close();
  }
  await login();
}
async function main() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(CONFIG)) write(CONFIG, DEFAULTS);
  const command = process.argv[2] ?? 'status';
  // launchd resumes after login even if the previous session was manually stopped.
  if (command === 'check' && process.argv.includes('--quiet') &&
      !fs.existsSync(path.join(ROOT, 'watchdog-enabled.json')) &&
      !fs.existsSync(path.join(ROOT, 'login.lock'))) {
    write(path.join(ROOT, 'watchdog-enabled.json'), { since: new Date().toISOString() });
  }
  if (command === 'install') install();
  else if (command === 'setup') await setup();
  else if (command === 'login') await login();
  else if (command === 'finish-login') {
    const lock = path.join(ROOT, 'login.lock');
    const pid = read(path.join(lock, 'owner.json')).pid;
    if (!Number.isInteger(pid)) throw new Error('Chrome для настройки не запущен');
    try { process.kill(pid, 0); } catch { throw new Error('Chrome для настройки уже закрыт'); }
    fs.writeFileSync(path.join(lock, 'complete'), '', { mode: 0o600 });
    console.log('Вход завершён. Автозапуск включится только после успешной проверки live.');
  }
  else if (command === 'check') await check({ dry: process.argv.includes('--dry-run'), http: process.argv.includes('--http'), verifyLive: process.argv.includes('--verify-live') });
  else if (command === 'stop') { stop(); console.log('Мониторинг остановлен. Для включения — «Настроить.command».'); }
  else if (command === 'uninstall') {
    stop(); if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
    try { launchctl('bootout', `${domain()}/${WATCH_LABEL}`); } catch {}
    fs.rmSync(WATCH_PLIST, { force: true });
    console.log('Автозапуск удалён. Конфигурация и профиль сохранены в: ' + ROOT);
  } else if (command === 'status') {
    let enabled = false;
    try { launchctl('print', `${domain()}/${LABEL}`); enabled = true; } catch {}
    const c = config(), s = read(STATE);
    console.log(JSON.stringify({ automatic: enabled, intervalMinutes: 1, name: c.name, threshold: c.threshold,
      telegramConfigured: !!(c.telegramToken && c.telegramChatId), browserEnabled: c.browserEnabled, windowless: true,
      watchdogEnabled: fs.existsSync(path.join(ROOT, 'watchdog-enabled.json')),
      heartbeat: read(path.join(ROOT, 'heartbeat.json')), fatal: read(path.join(ROOT, 'fatal.json')),
      notificationsPaused: Date.parse(read(CONTROL).mutedUntil) > Date.now(),
      mutedUntil: read(CONTROL).mutedUntil ?? null,
      subscriberCount: Object.keys(subscribers(read(CONTROL), c)).length,
      latest: s.latest ?? null, lastAlert: s.lastAlert ?? null, deliveryError: s.deliveryError ?? null, config: CONFIG }, null, 2));
  } else throw new Error('Команды: setup, login, finish-login, install, check [--dry-run] [--http] [--verify-live], status, stop, uninstall');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    reportFatal(e);
    // Browser and network error details may contain session data; keep output minimal.
    const message = /^(Токен|Не удалось|Telegram|Нужен|Порог|Некорректные|Команды|Chrome|Google)/.test(e.message) ? e.message : 'Ошибка запуска. Проверьте настройку Chrome и файлы мониторинга.';
    if (!process.argv.includes('--quiet')) console.error(message);
    process.exitCode = 1;
  });
}
