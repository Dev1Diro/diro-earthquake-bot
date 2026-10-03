import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createDiscordRuntime } from './discord-runtime.js';
import { StateStore } from './state-store.js';
import { configureSecrets, redact } from './security.js';

dns.setDefaultResultOrder('ipv4first');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  htmlEntities: true,
  trimValues: true,
});

const T = Object.freeze({
  botErrorLog: '\ubd07 \uc624\ub958 \ub85c\uadf8',
  botLog: '\ubd07 \ub85c\uadf8',
  detail: '\ub0b4\uc6a9',
  earthquakeTitle: '\uc9c0\uc9c4 \ubc1c\uc0dd \uc54c\ub9bc',
  earthquakeContent: '@everyone \uc9c0\uc9c4 \ubc1c\uc0dd',
  epicenter: '\uc9c4\uc559\uc9c0',
  magnitude: '\uaddc\ubaa8',
  depth: '\uae4a\uc774',
  intensity: '\uc9c4\ub3c4',
  analysis: '\ubd84\uc11d',
  map: '\uc9c0\ub3c4',
  viewLocation: '\uc704\uce58 \ubcf4\uae30',
  noInfo: '\uc815\ubcf4 \uc5c6\uc74c',
  safetyTitle: '\uc548\uc804\uc548\ub0b4\ubb38\uc790',
  safetyContent: '@everyone \uc548\uc804\uc548\ub0b4\ubb38\uc790',
  area: '\uc9c0\uc5ed',
  nationwide: '\uc804\uad6d',
  noFeel: '\ubb34\uac10',
  weakShake: '\uc57d\ud55c \uc9c4\ub3d9',
  indoorFeel: '\uc2e4\ub0b4\uc5d0\uc11c \uc77c\ubd80 \uac10\uc9c0 \uac00\ub2a5',
  windowShake: '\ucc3d\ubb38\uc774\ub098 \ubb3c\uccb4\uac00 \ud754\ub4e4\ub9b4 \uc218 \uc788\uc74c',
  strongShake: '\uac15\ud55c \ud754\ub4e4\ub9bc\uacfc \uc77c\ubd80 \ud53c\ud574 \uac00\ub2a5',
  severeShake: '\ub9e4\uc6b0 \uac15\ud55c \ud754\ub4e4\ub9bc\uacfc \ud53c\ud574 \uac00\ub2a5',
});

const ENV = Object.freeze({
  DISCORD_TOKEN: cleanEnv('DISCORD_TOKEN'),
  KMA_KEY: cleanEnv('KMA_KEY'),
  SAFETY_KEY: cleanEnv('SAFETY_KEY'),
  CHANNEL_ID: cleanEnv('CHANNEL_ID') || firstCsvValue(process.env.CHANNEL_IDS),
  LOGS: cleanEnv('LOGS') || cleanEnv('logs') || cleanEnv('LOG_CHANNEL_ID'),
  GUILD_ID: cleanEnv('GUILD_ID'),
  DATA_DIR: cleanEnv('DATA_DIR') || '.data',
  ALERT_MENTION_EVERYONE: cleanEnv('ALERT_MENTION_EVERYONE') === 'true',
  TRUST_PROXY: cleanEnv('TRUST_PROXY') === 'true',
  PORT: Number(process.env.PORT) || 3000,
});

configureSecrets([ENV.DISCORD_TOKEN, ENV.KMA_KEY, ENV.SAFETY_KEY]);

for (const name of ['DISCORD_TOKEN', 'CHANNEL_ID']) {
  if (!ENV[name]) {
    console.error(`${name} env var is missing.`);
    process.exit(1);
  }
}

if (!isSnowflake(ENV.CHANNEL_ID)) {
  console.error('CHANNEL_ID must be a Discord channel ID.');
  process.exit(1);
}

if (ENV.LOGS && !isSnowflake(ENV.LOGS)) {
  console.warn('LOGS is not a valid Discord channel ID. Log channel disabled.');
}

const CFG = Object.freeze({
  CHECK_MS: 60_000,
  ALERT_MAX_AGE_MS: 30 * 60 * 1000,
  API_TIMEOUT_MS: 8000,
  DISCORD_TIMEOUT_MS: 7000,
  SENT_TTL_MS: ONE_DAY_MS,
  DISCORD_QUEUE_MAX: 40,
  DISCORD_DELAY_MS: 250,
  HTTP_RATE_BURST: 24,
  HTTP_RATE_REFILL_PER_SEC: 0.5,
  MAX_URL_LENGTH: 240,
  HTTP_BUCKET_MAX: 1000,
  MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
});

const sentIds = new Map();
const sendQueue = [];
const httpBuckets = new Map();

let queueRunning = false;
let firstSafetyCheck = true;
let lastKmaStatus = 'booting';
let lastSafetyStatus = 'booting';
let lastDiscordStatus = 'idle: no alert sent yet';
let lastCheckAt = null;
let blockedRequests = 0;
let checksRunning = false;
let rerunRequested = false;
let stateStore = null;
let discordRuntime = null;
const errorLogTimes = new Map();

function cleanEnv(name) {
  return process.env[name]?.trim() || '';
}

function firstCsvValue(value) {
  return String(value || '').split(',')[0]?.trim() || '';
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || ''));
}

function sanitize(value, max = 1000) {
  const text = redact(value).replace(/[<>"'`\x00-\x1f]/g, '').trim();
  return text.slice(0, max) || T.noInfo;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function remember(id) {
  const now = Date.now();
  if (stateStore) {
    await stateStore.update(state => {
      state.alerts[`${ENV.CHANNEL_ID}:${id}`] = now;
      for (const [key, at] of Object.entries(state.alerts)) {
        if (!Number.isFinite(at) || now - at > CFG.SENT_TTL_MS) delete state.alerts[key];
      }
    });
  }
  sentIds.set(id, now);

  for (const [key, at] of sentIds.entries()) {
    if (now - at > CFG.SENT_TTL_MS) sentIds.delete(key);
  }
}

function wasSent(id) {
  return sentIds.has(id);
}

async function log(level, message, error) {
  const line = redact(`[${nowIso()}] [${level}] ${message}${error ? ` - ${error?.message || error}` : ''}`);
  console.log(line);
  // LOGS is for guild events and moderation. Polling telemetry stays in stdout.
  if (level !== 'ERROR' || !ENV.LOGS || !isSnowflake(ENV.LOGS)) return;
  const previous = errorLogTimes.get(message) || 0;
  if (Date.now() - previous < 10 * 60_000) return;
  errorLogTimes.set(message, Date.now());

  const fields = error ? [{ name: T.detail, value: sanitize(error?.message || error, 900), inline: false }] : [];
  await enqueueDiscordMessage(ENV.LOGS, {
    embeds: [
      {
        title: level === 'ERROR' ? T.botErrorLog : T.botLog,
        color: level === 'ERROR' ? 0xff3333 : 0x4aa3ff,
        description: sanitize(message, 1800),
        fields,
        timestamp: nowIso(),
      },
    ],
    allowed_mentions: { parse: [] },
  }).catch((sendError) => {
    console.warn(`[LOG DELIVERY ERROR] ${redact(sendError.message)}`);
  });
}

function enqueueDiscordMessage(channelId, payload) {
  return queueDiscordMessage(channelId, payload, false);
}

function enqueuePriorityDiscordMessage(channelId, payload) {
  return queueDiscordMessage(channelId, payload, true);
}

function queueDiscordMessage(channelId, payload, priority) {
  if (!channelId) return Promise.reject(new Error('Discord channel is missing'));
  if (sendQueue.length >= CFG.DISCORD_QUEUE_MAX) {
    return Promise.reject(new Error('Discord send queue is full'));
  }

  return new Promise((resolve, reject) => {
    const entry = { channelId, payload, resolve, reject };
    if (priority) sendQueue.unshift(entry);
    else sendQueue.push(entry);
    if (!queueRunning) void processDiscordQueue();
  });
}

async function processDiscordQueue() {
  queueRunning = true;

  while (sendQueue.length) {
    const { channelId, payload, resolve, reject } = sendQueue.shift();
    try {
      await sendDiscordMessage(channelId, payload);
      resolve();
    } catch (error) {
      reject(error);
    }
    await sleep(CFG.DISCORD_DELAY_MS);
  }

  queueRunning = false;
}

async function sendDiscordMessage(channelId, payload) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  let lastError;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.DISCORD_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bot ${ENV.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        const body = await safeJson(res);
        const retrySeconds = Number(body?.retry_after ?? 1);
        if (!Number.isFinite(retrySeconds) || retrySeconds < 0 || retrySeconds > 5) {
          const error = new Error('Discord rate limit: retry on the next poll');
          error.noRetry = true;
          throw error;
        }
        const retryAfterMs = Math.ceil(retrySeconds * 1000);
        lastError = new Error('Discord rate limit exceeded');
        clearTimeout(timer);
        await sleep(retryAfterMs);
        continue;
      }

      if (!res.ok) {
        const error = new Error(`Discord HTTP ${res.status}${res.status === 403 ? ': channel permissions missing' : ''}`);
        error.noRetry = res.status >= 400 && res.status < 500;
        throw error;
      }

      if (channelId === ENV.CHANNEL_ID) lastDiscordStatus = 'ok';
      return;
    } catch (error) {
      lastError = error;
      if (error.noRetry) break;
      if (attempt === 2) {
        console.error(`[DISCORD SEND ERROR] channel=${channelId}`, redact(error?.message || error));
      } else {
        await sleep(500 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (channelId === ENV.CHANNEL_ID) lastDiscordStatus = `error: ${redact(lastError?.message || 'message delivery failed')}`;
  throw lastError || new Error('Discord message delivery failed');
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function keyCandidates(rawKey) {
  const set = new Set();
  const raw = String(rawKey || '').trim();
  if (!raw) return [];

  try {
    const decoded = decodeURIComponent(raw);
    set.add(encodeURIComponent(decoded));
  } catch {
    set.add(encodeURIComponent(raw));
  }
  set.add(encodeURIComponent(raw));

  return [...set].filter(Boolean);
}

function buildUrl(base, serviceKey, params = {}) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  return `${base}?serviceKey=${serviceKey}${query ? `&${query}` : ''}`;
}

async function fetchTextWithKeyFallback(base, apiKey, params = {}) {
  let lastError = null;

  for (const serviceKey of keyCandidates(apiKey)) {
    const url = buildUrl(base, serviceKey, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.API_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json, application/xml, text/xml, text/plain' },
      });

      const bytes = await readLimitedResponse(res);
      const text = decodeResponseText(bytes, res.headers.get('content-type'));
      if (new URL(base).hostname === 'www.safetydata.go.kr' && isIpDeniedMessage(text)) {
        const error = new Error('Safety API IP 허용 안 됨: Render 서비스의 Connect → Outbound 공인 IP를 Safety API 이용신청의 허용 IP에 등록해야 합니다.');
        error.code = 'SAFETY_IP_NOT_ALLOWED';
        throw error;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${sanitize(text, 200)}`);

      if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_KEY_IS_NOT_REGISTERED_ERROR|INVALID_REQUEST_PARAMETER_ERROR/i.test(text)) {
        lastError = new Error(sanitize(text, 300));
        continue;
      }

      parseApiRecords(text); // HTTP 200 may still contain an API error.
      return text;
    } catch (error) {
      if (error.code === 'SAFETY_IP_NOT_ALLOWED') throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('API request failed');
}

async function readLimitedResponse(res) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > CFG.MAX_RESPONSE_BYTES) throw new Error('API response exceeds size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function decodeResponseText(bytes, contentType = '') {
  const utf8Preview = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 300));
  const xmlEncoding = utf8Preview.match(/encoding=["']([^"']+)["']/i)?.[1];
  const headerEncoding = String(contentType || '').match(/charset=([^;\s]+)/i)?.[1];
  const encodings = [headerEncoding, xmlEncoding, 'utf-8', 'euc-kr', 'ks_c_5601-1987']
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  for (const encoding of [...new Set(encodings)]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // Try the next encoding.
    }
  }

  return new TextDecoder().decode(bytes);
}

function isIpDeniedMessage(value) {
  return /IP_IS_NOT_REGISTERED|IP_NOT_ALLOWED|(?:등록되지\s*않은|허용되지\s*않은)\s*(?:IP|아이피)|(?:unregistered|unauthorized)\s*IP|(?:IP|아이피)[^<>\n]{0,60}(?:허용.*않|등록.*않|등록되지|not\s*(?:allowed|registered)|denied|unauthorized)/i.test(String(value || ''));
}

function parseXmlRecords(data) {
  const records = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if ('tmEqk' in node || 'MSG_CN' in node || 'msgCn' in node || ('loc' in node && 'mt' in node)) {
      records.push(node);
      return;
    }
    Object.values(node).forEach(visit);
  }
  visit(data);
  return records;
}

function extractJsonRecords(data) {
  const candidates = [
    data?.response?.body?.items?.item,
    data?.body?.items?.item,
    data?.body?.data,
    data?.body,
    data?.items?.item,
    data?.item,
    data?.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object' && ('tmEqk' in candidate || 'MSG_CN' in candidate || 'msgCn' in candidate)) return [candidate];
  }

  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && ('tmEqk' in data || 'MSG_CN' in data)) return [data];
  return [];
}

function parseApiRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('API returned an empty response');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (data?.OpenAPI_ServiceResponse) {
      const header = data.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      assertApiResult(header.returnReasonCode, header.returnAuthMsg || header.errMsg);
      throw new Error('API returned a service error');
    }
    if (!Array.isArray(data) && (!data || typeof data !== 'object' || !['response', 'header', 'body', 'items', 'item', 'data', 'tmEqk', 'MSG_CN', 'msgCn'].some(key => key in data))) {
      throw new Error('API returned an unsupported JSON response');
    }
    const header = data?.response?.header || data?.header || data;
    assertApiResult(header.resultCode, header.resultMsg);
    return extractJsonRecords(data);
  }

  if (!trimmed.startsWith('<') || !/<\/?(?:[\w-]+:)?(?:response|OpenAPI_ServiceResponse|body|item|items)\b/i.test(trimmed)) throw new Error('API returned an unsupported response');
  if (/<!DOCTYPE\b/i.test(trimmed)) throw new Error('API XML with DOCTYPE is not supported');
  if (XMLValidator.validate(trimmed) !== true) throw new Error('API returned invalid XML');
  const data = xmlParser.parse(trimmed);
  const root = data.response || data.OpenAPI_ServiceResponse || data;
  const header = root.header || root.cmmMsgHeader || root;
  assertApiResult(header.resultCode ?? header.returnReasonCode, header.resultMsg || header.returnAuthMsg || header.errMsg);
  if (data.OpenAPI_ServiceResponse || data.html) {
    throw new Error(`API returned an error response: ${sanitize(header.errMsg || header.returnAuthMsg, 200)}`);
  }
  return parseXmlRecords(data);
}

async function fetchApiPages(base, apiKey, params) {
  const result = [];
  const maximumPages = 20;
  for (let page = 1; page <= maximumPages; page++) {
    const text = await fetchTextWithKeyFallback(base, apiKey, { ...params, pageNo: page });
    const records = parseApiRecords(text);
    result.push(...records);
    const parsed = text.trim().startsWith('<') ? xmlParser.parse(text) : JSON.parse(text);
    const countValue = parsed?.response?.body?.totalCount ?? parsed?.body?.totalCount ?? parsed?.totalCount;
    const total = countValue === undefined ? null : Number(countValue);
    if (total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new Error('API returned invalid totalCount');
    if ((total !== null && result.length >= total) || records.length < Number(params.numOfRows)) return result;
    if (page === maximumPages) throw new Error('API pagination limit exceeded; data may be incomplete');
  }
  return result;
}

function assertApiResult(code, message) {
  if (code === undefined || code === null || code === '') return;
  const value = String(code).trim();
  if (['00', '0', '200', 'INFO-000', 'NORMAL_SERVICE'].includes(value)) return;
  if (value === '03') return; // KMA: no data.
  throw new Error(`API ${value}: ${sanitize(message, 200)}`);
}

function formatKstDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getKmaRange() {
  const yesterdayKst = new Date(Date.now() + KST_OFFSET_MS - ONE_DAY_MS);

  return {
    fromTmFc: formatKstDate(yesterdayKst),
    toTmFc: formatKstDate(new Date(Date.now() + KST_OFFSET_MS)),
  };
}

function parseKmaTime(tmEqk) {
  const value = String(tmEqk || '').replace(/\D/g, '');
  if (value.length < 14) return null;

  const y = value.slice(0, 4);
  const m = value.slice(4, 6);
  const d = value.slice(6, 8);
  const h = value.slice(8, 10);
  const min = value.slice(10, 12);
  const s = value.slice(12, 14);
  const time = new Date(`${y}-${m}-${d}T${h}:${min}:${s}+09:00`).getTime();
  return Number.isFinite(time) ? time : null;
}

function parseKstLikeTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d{14}$/.test(raw)) return parseKmaTime(raw);
  if (/^\d{12}$/.test(raw)) return parseKmaTime(`${raw}00`);

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+09:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinLastFiveMinutes(time) {
  const now = Date.now();
  return time && now - time <= FIVE_MINUTES_MS && time <= now + 60_000;
}

function isRecentAlert(time) {
  const now = Date.now();
  return Number.isFinite(time) && time > 0 && now - time <= CFG.ALERT_MAX_AGE_MS && time <= now + 60_000;
}

function kmaId(item) {
  return `KMA_${item.tmEqk || ''}_${item.tmSeq || ''}_${item.lat || ''}_${item.lon || ''}_${item.mt || ''}`;
}

function safetyId(item) {
  const raw =
    item.MD101_SN ||
    item.SN ||
    item.id ||
    item.MSG_SN ||
    `${item.CRT_DT || item.REG_DT || item.CREATE_DT || ''}_${item.RCV_AREA_NM || ''}_${item.MSG_CN || ''}`;

  return `SAFE_${crypto.createHash('sha1').update(String(raw)).digest('hex')}`;
}

function intensityText(item, mag) {
  if (item.inT) return sanitize(item.inT, 60);
  if (!mag || mag < 2) return T.noFeel;
  if (mag < 3) return T.weakShake;
  if (mag < 4) return T.indoorFeel;
  if (mag < 5) return T.windowShake;
  if (mag < 6) return T.strongShake;
  return T.severeShake;
}

async function checkKmaEarthquakes() {
  if (!ENV.KMA_KEY) {
    lastKmaStatus = 'disabled: KMA_KEY is missing';
    return;
  }
  const range = getKmaRange();
  const items = await fetchApiPages('https://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg', ENV.KMA_KEY, {
    numOfRows: 100,
    pageNo: 1,
    dataType: 'JSON',
    fromTmFc: range.fromTmFc,
    toTmFc: range.toTmFc,
  });

  let sent = 0;
  const failures = [];

  for (const item of items) {
    const eventTime = parseKmaTime(item.tmEqk);
    const announcedTime = parseKstLikeTime(item.tmFc);
    if (!eventTime || !isRecentAlert(announcedTime || eventTime)) continue;

    const id = kmaId(item);
    if (wasSent(id)) continue;

    const lat = Number(item.lat);
    const lon = Number(item.lon);
    const mag = Number(item.mt);
    const mapUrl = Number.isFinite(lat) && Number.isFinite(lon)
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
      : null;

    const fields = [
      { name: T.epicenter, value: sanitize(item.loc, 200), inline: false },
      { name: T.magnitude, value: Number.isFinite(mag) ? `M${mag.toFixed(1)}` : T.noInfo, inline: true },
      { name: T.depth, value: item.dep ? `${sanitize(item.dep, 20)}km` : T.noInfo, inline: true },
      { name: T.intensity, value: intensityText(item, mag), inline: true },
    ];

    if (item.rem) fields.push({ name: T.analysis, value: sanitize(item.rem, 200), inline: false });
    if (mapUrl) fields.push({ name: T.map, value: `[${T.viewLocation}](${mapUrl})`, inline: false });

    const embed = {
      title: T.earthquakeTitle,
      color: mag >= 5 ? 0xff3333 : mag >= 4 ? 0xff9900 : 0x2f80ed,
      fields,
      timestamp: new Date(eventTime).toISOString(),
    };

    if (item.img) {
      try {
        const image = new URL(String(item.img));
        if (image.protocol === 'https:' && !image.username && !image.password && image.href.length < 2000) embed.image = { url: image.href };
      } catch { /* Invalid optional image must not prevent an earthquake alert. */ }
    }

    try {
      await enqueuePriorityDiscordMessage(ENV.CHANNEL_ID, {
        content: ENV.ALERT_MENTION_EVERYONE ? T.earthquakeContent : T.earthquakeContent.replace('@everyone ', ''),
        embeds: [embed],
        allowed_mentions: { parse: ENV.ALERT_MENTION_EVERYONE ? ['everyone'] : [] },
      });

      await remember(id);
      sent++;
    } catch (error) {
      failures.push(redact(error.message));
    }
  }

  if (failures.length) throw new Error(`KMA delivery failed=${failures.length}, sent=${sent}: ${failures[0]}`);
  lastKmaStatus = `ok: fetched=${items.length}, sent=${sent}`;
  await log('INFO', `KMA check complete (${lastKmaStatus})`);
}

function safetyMessage(item) {
  return item.MSG_CN || item.msgCn || item.message || item.CN || '';
}

function safetyArea(item) {
  return item.RCPTN_RGN_NM || item.RCV_AREA_NM || item.areaNm || item.AREA_NM || item.region || T.nationwide;
}

function safetyTitle(item) {
  return item.DSSTR_SE_NM || item.DST_SE_NM || item.disasterType || item.title || T.safetyTitle;
}

function safetyTime(item) {
  return parseKstLikeTime(
    item.CRT_DT ||
      item.REG_DT ||
      item.CREATE_DT ||
      item.CREAT_DT ||
      item.SEND_DT ||
      item.RCV_DT ||
      item.date,
  );
}

async function checkSafetyMessages() {
  if (!ENV.SAFETY_KEY) {
    lastSafetyStatus = 'disabled: SAFETY_KEY is missing';
    return;
  }
  const items = await fetchApiPages('https://www.safetydata.go.kr/V2/api/DSSP-IF-00247', ENV.SAFETY_KEY, {
    returnType: 'json',
    numOfRows: 100,
    pageNo: 1,
    crtDt: getKmaRange().fromTmFc,
  });
  let sent = 0;
  const failures = [];

  for (const item of items) {
    const message = safetyMessage(item);
    if (!message) continue;

    const id = safetyId(item);
    if (wasSent(id)) continue;

    const messageTime = safetyTime(item);
    if (!isRecentAlert(messageTime) || (firstSafetyCheck && !isWithinLastFiveMinutes(messageTime))) {
      // Old items cannot become recent later; do not fill persistent storage with
      // an entire day of stale notifications. Future items remain retryable.
      if (firstSafetyCheck && isRecentAlert(messageTime) && messageTime <= Date.now()) await remember(id);
      continue;
    }

    try {
      await enqueuePriorityDiscordMessage(ENV.CHANNEL_ID, {
        content: ENV.ALERT_MENTION_EVERYONE ? T.safetyContent : T.safetyContent.replace('@everyone ', ''),
        embeds: [
          {
            title: sanitize(safetyTitle(item), 100),
            color: 0xffcc00,
            description: sanitize(message, 1800),
            fields: [{ name: T.area, value: sanitize(safetyArea(item), 200), inline: false }],
            timestamp: messageTime ? new Date(messageTime).toISOString() : nowIso(),
          },
        ],
        allowed_mentions: { parse: ENV.ALERT_MENTION_EVERYONE ? ['everyone'] : [] },
      });

      await remember(id);
      sent++;
    } catch (error) {
      failures.push(redact(error.message));
    }
  }

  firstSafetyCheck = false;
  if (failures.length) throw new Error(`Safety delivery failed=${failures.length}, sent=${sent}: ${failures[0]}`);
  lastSafetyStatus = `ok: fetched=${items.length}, sent=${sent}`;
  await log('INFO', `Safety check complete (${lastSafetyStatus})`);
}

async function runChecks() {
  if (checksRunning) {
    rerunRequested = true;
    return;
  }

  checksRunning = true;

  do {
    rerunRequested = false;
    lastCheckAt = nowIso();

    const [kmaResult, safetyResult] = await Promise.allSettled([
      checkKmaEarthquakes(),
      checkSafetyMessages(),
    ]);

    if (kmaResult.status === 'rejected') {
      const error = kmaResult.reason;
      lastKmaStatus = `error: ${redact(error?.message || error)}`;
      await log('ERROR', 'KMA earthquake API check failed', error);
    }

    if (safetyResult.status === 'rejected') {
      const error = safetyResult.reason;
      const previousStatus = lastSafetyStatus;
      lastSafetyStatus = `error: ${redact(error?.message || error)}`;
      if (error?.code !== 'SAFETY_IP_NOT_ALLOWED' || previousStatus !== lastSafetyStatus) {
        await log('ERROR', 'Safety API check failed', error);
      }
    }
  } while (rerunRequested);

  checksRunning = false;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (ENV.TRUST_PROXY && typeof forwarded === 'string' && /^[\da-fA-F.:, ]{1,200}$/.test(forwarded)) return forwarded.split(',').at(-1).trim();
  return req.socket.remoteAddress || 'unknown';
}

function allowHttpRequest(ip) {
  const now = Date.now();
  if (!httpBuckets.has(ip) && httpBuckets.size >= CFG.HTTP_BUCKET_MAX) {
    for (const [key, value] of httpBuckets) if (now - value.at > 30 * 60_000) httpBuckets.delete(key);
    if (httpBuckets.size >= CFG.HTTP_BUCKET_MAX) return false;
  }
  const bucket = httpBuckets.get(ip) || { tokens: CFG.HTTP_RATE_BURST, at: now };
  const refill = ((now - bucket.at) / 1000) * CFG.HTTP_RATE_REFILL_PER_SEC;

  bucket.tokens = Math.min(CFG.HTTP_RATE_BURST, bucket.tokens + refill);
  bucket.at = now;

  if (bucket.tokens < 1) {
    httpBuckets.set(ip, bucket);
    return false;
  }

  bucket.tokens -= 1;
  httpBuckets.set(ip, bucket);

  if (httpBuckets.size > 1000) {
    for (const [key, value] of httpBuckets.entries()) {
      if (now - value.at > 30 * 60 * 1000) httpBuckets.delete(key);
    }
  }

  return true;
}

function isSuspiciousPath(pathname) {
  return /(?:\.env|wp-|php|admin|login|shell|cgi-bin|\.git|config|backup|passwd)/i.test(pathname);
}

function writeSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
}

function sendText(res, status, text) {
  writeSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, body) {
  writeSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function handleHttp(req, res) {
  const ip = clientIp(req);

  if (!allowHttpRequest(ip)) {
    blockedRequests++;
    return sendText(res, 429, 'rate limited');
  }

  if (!['GET', 'HEAD'].includes(req.method || '')) {
    blockedRequests++;
    return sendText(res, 405, 'method not allowed');
  }

  if (String(req.url || '').length > CFG.MAX_URL_LENGTH) {
    blockedRequests++;
    return sendText(res, 414, 'uri too long');
  }

  let url;
  let pathname;
  try {
    if (!String(req.url || '/').startsWith('/') || String(req.url || '/').startsWith('//')) throw new Error('Invalid target');
    url = new URL(req.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch { return sendText(res, 400, 'bad request'); }

  if (isSuspiciousPath(pathname)) {
    blockedRequests++;
    console.warn(`[BLOCKED HTTP] ip=${ip}`);
    return sendText(res, 403, 'forbidden');
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      lastCheckAt,
      kma: publicStatus(lastKmaStatus),
      safety: publicStatus(lastSafetyStatus),
      discord: publicStatus(lastDiscordStatus),
      discordConnection: discordRuntime?.health() || { gateway: 'starting', commands: 'pending', logs: 'pending' },
      queuedMessages: sendQueue.length,
      blockedRequests,
    });
  }

  if (url.pathname === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /\n');
  if (url.pathname === '/favicon.ico') return sendText(res, 204, '');

  blockedRequests++;
  return sendText(res, 404, 'not found');
}

function publicStatus(status) {
  if (status.startsWith('error:')) return 'error: see server logs or /status';
  return redact(status).slice(0, 200);
}

const server = http.createServer(handleHttp);
server.maxHeadersCount = 32;
server.requestTimeout = 5000;
server.headersTimeout = 6000;
server.keepAliveTimeout = 3000;

async function main() {
  stateStore = await new StateStore(ENV.DATA_DIR).init();
  const prefix = `${ENV.CHANNEL_ID}:`;
  for (const [key, at] of Object.entries(stateStore.read().alerts)) {
    if (key.startsWith(prefix) && Number.isFinite(at) && Date.now() - at <= CFG.SENT_TTL_MS) sentIds.set(key.slice(prefix.length), at);
  }
  discordRuntime = createDiscordRuntime({
    env: ENV, store: stateStore,
    getSourceStatus: () => ({ kma: lastKmaStatus, safety: lastSafetyStatus, discord: lastDiscordStatus }),
    reportError: (scope, error) => console.error(`[${scope}] ${redact(error?.message || error)}`),
  });
  let pollingTimer;
  server.on('error', error => { console.error(redact(error.message)); process.exitCode = 1; void discordRuntime.stop(); });
  server.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`Web server started on port ${ENV.PORT}`);
    // HTTP diagnostics remain available while the Gateway connects/reconnects.
    void discordRuntime.start().catch(error => console.error(redact(error.message)));
    void runChecks().catch(error => console.error(redact(error.message)));
    pollingTimer = setInterval(() => { void runChecks().catch(error => console.error(redact(error.message))); }, CFG.CHECK_MS);
  });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(pollingTimer);
    server.close();
    await discordRuntime.stop();
    await stateStore.pending;
    process.exit(0);
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch(error => {
  console.error(`Startup failed: ${redact(error?.message || error)}`);
  process.exitCode = 1;
});
