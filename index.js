import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
  PORT: Number(process.env.PORT) || 3000,
});

for (const name of ['DISCORD_TOKEN', 'KMA_KEY', 'SAFETY_KEY', 'CHANNEL_ID']) {
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
  CHECK_MS: FIVE_MINUTES_MS,
  API_TIMEOUT_MS: 8000,
  DISCORD_TIMEOUT_MS: 7000,
  SENT_TTL_MS: ONE_DAY_MS,
  DISCORD_QUEUE_MAX: 40,
  DISCORD_DELAY_MS: 250,
  HTTP_RATE_BURST: 24,
  HTTP_RATE_REFILL_PER_SEC: 0.5,
  MAX_URL_LENGTH: 240,
});

const sentIds = new Map();
const sendQueue = [];
const httpBuckets = new Map();

let queueRunning = false;
let firstSafetyCheck = true;
let lastKmaStatus = 'booting';
let lastSafetyStatus = 'booting';
let lastCheckAt = null;
let blockedRequests = 0;
let checksRunning = false;
let rerunRequested = false;

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
  const text = String(value ?? '').replace(/[<>"'`\x00-\x1f]/g, '').trim();
  return text.slice(0, max) || T.noInfo;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function remember(id) {
  const now = Date.now();
  sentIds.set(id, now);

  for (const [key, at] of sentIds.entries()) {
    if (now - at > CFG.SENT_TTL_MS) sentIds.delete(key);
  }
}

function wasSent(id) {
  return sentIds.has(id);
}

async function log(level, message, error) {
  const line = `[${nowIso()}] [${level}] ${message}${error ? ` - ${error?.message || error}` : ''}`;
  console.log(line);

  if (!ENV.LOGS || !isSnowflake(ENV.LOGS)) return;

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
  });
}

async function enqueueDiscordMessage(channelId, payload) {
  if (!channelId) return;

  if (sendQueue.length >= CFG.DISCORD_QUEUE_MAX) {
    console.warn(`[DISCORD QUEUE DROP] channel=${channelId}`);
    return;
  }

  sendQueue.push({ channelId, payload });
  if (!queueRunning) processDiscordQueue();
}

async function enqueuePriorityDiscordMessage(channelId, payload) {
  if (!channelId) return;

  if (sendQueue.length >= CFG.DISCORD_QUEUE_MAX) {
    console.warn(`[DISCORD QUEUE DROP] channel=${channelId}`);
    return;
  }

  sendQueue.unshift({ channelId, payload });
  if (!queueRunning) processDiscordQueue();
}

async function processDiscordQueue() {
  queueRunning = true;

  while (sendQueue.length) {
    const { channelId, payload } = sendQueue.shift();
    await sendDiscordMessage(channelId, payload);
    await sleep(CFG.DISCORD_DELAY_MS);
  }

  queueRunning = false;
}

async function sendDiscordMessage(channelId, payload) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

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
        const retryAfterMs = Math.ceil(Number(body?.retry_after || 1) * 1000);
        await sleep(Math.min(retryAfterMs, 5000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Discord HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      return;
    } catch (error) {
      if (attempt === 2) {
        console.error(`[DISCORD SEND ERROR] channel=${channelId}`, error?.message || error);
      } else {
        await sleep(500 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function verifyDiscordToken() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.DISCORD_TIMEOUT_MS);

  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      signal: controller.signal,
      headers: { Authorization: `Bot ${ENV.DISCORD_TOKEN}` },
    });

    if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
    const me = await res.json();
    await log('INFO', `Discord REST connected: ${me.username || me.id}`);
  } catch (error) {
    await log('ERROR', 'Discord REST connection failed', error);
  } finally {
    clearTimeout(timer);
  }
}

function keyCandidates(rawKey) {
  const set = new Set();
  const raw = String(rawKey || '').trim();
  if (!raw) return [];

  set.add(raw);
  set.add(encodeURIComponent(raw));

  try {
    const decoded = decodeURIComponent(raw);
    set.add(decoded);
    set.add(encodeURIComponent(decoded));
  } catch {
    // Keep original candidates when the key is not URI-encoded.
  }

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

      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = decodeResponseText(bytes, res.headers.get('content-type'));
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

      if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_KEY_IS_NOT_REGISTERED_ERROR|INVALID_REQUEST_PARAMETER_ERROR/i.test(text)) {
        lastError = new Error(text.slice(0, 300));
        continue;
      }

      return text;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('API request failed');
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
      return new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch {
      // Try the next encoding.
    }
  }

  return new TextDecoder().decode(bytes);
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseXmlRecords(xml) {
  const records = [];
  let blocks = [...xml.matchAll(/<(item|row)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

  if (!blocks.length) {
    blocks = [...xml.matchAll(/<data\b[^>]*>([\s\S]*?)<\/data>/gi)].map((match) => [match[0], 'data', match[1]]);
  }

  for (const [, , block] of blocks) {
    const record = {};
    for (const match of block.matchAll(/<([A-Za-z0-9_]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      record[match[1]] = decodeXml(match[2]);
    }
    if (Object.keys(record).length) records.push(record);
  }

  return records;
}

function extractJsonRecords(data) {
  const candidates = [
    data?.response?.body?.items?.item,
    data?.body?.items?.item,
    data?.body?.data,
    data?.items?.item,
    data?.item,
    data?.data,
    data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return [candidate];
  }

  return [];
}

function parseApiRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return extractJsonRecords(JSON.parse(trimmed));
  }

  return parseXmlRecords(trimmed);
}

function formatKstDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getKmaRange() {
  const yesterdayKst = new Date(Date.now() + KST_OFFSET_MS - ONE_DAY_MS);
  const oneYearAfterYesterdayKst = new Date(yesterdayKst);
  oneYearAfterYesterdayKst.setUTCFullYear(oneYearAfterYesterdayKst.getUTCFullYear() + 1);

  return {
    fromTmFc: formatKstDate(yesterdayKst),
    toTmFc: formatKstDate(oneYearAfterYesterdayKst),
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

  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 14) return parseKmaTime(digits.slice(0, 14));
  if (digits.length === 12) return parseKmaTime(`${digits}00`);

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+09:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinLastFiveMinutes(time) {
  const now = Date.now();
  return time && now - time <= FIVE_MINUTES_MS && time <= now + 60_000;
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
  const range = getKmaRange();
  const text = await fetchTextWithKeyFallback('https://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg', ENV.KMA_KEY, {
    numOfRows: 10,
    pageNo: 1,
    fromTmFc: range.fromTmFc,
    toTmFc: range.toTmFc,
  });

  const items = parseApiRecords(text);
  let sent = 0;

  for (const item of items) {
    const eventTime = parseKmaTime(item.tmEqk);
    if (!isWithinLastFiveMinutes(eventTime)) continue;

    const id = kmaId(item);
    if (wasSent(id)) continue;
    remember(id);

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

    if (item.img && /^https?:\/\//i.test(item.img)) {
      embed.image = { url: item.img };
    }

    await enqueuePriorityDiscordMessage(ENV.CHANNEL_ID, {
      content: T.earthquakeContent,
      embeds: [embed],
      allowed_mentions: { parse: ['everyone'] },
    });

    sent++;
  }

  lastKmaStatus = `ok: fetched=${items.length}, sent=${sent}`;
  await log('INFO', `KMA check complete (${lastKmaStatus})`);
}

function safetyMessage(item) {
  return item.MSG_CN || item.msgCn || item.message || item.CN || '';
}

function safetyArea(item) {
  return item.RCV_AREA_NM || item.areaNm || item.AREA_NM || item.region || T.nationwide;
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
  const text = await fetchTextWithKeyFallback('https://www.safetydata.go.kr//V2/api/DSSP-IF-00247', ENV.SAFETY_KEY);
  const items = parseApiRecords(text);
  let sent = 0;

  for (const item of items.slice(0, 30)) {
    const message = safetyMessage(item);
    if (!message) continue;

    const id = safetyId(item);
    if (wasSent(id)) continue;

    const messageTime = safetyTime(item);
    if (firstSafetyCheck && (!messageTime || Date.now() - messageTime > FIVE_MINUTES_MS)) {
      remember(id);
      continue;
    }

    remember(id);

    await enqueuePriorityDiscordMessage(ENV.CHANNEL_ID, {
      content: T.safetyContent,
      embeds: [
        {
          title: sanitize(safetyTitle(item), 100),
          color: 0xffcc00,
          description: sanitize(message, 1800),
          fields: [{ name: T.area, value: sanitize(safetyArea(item), 200), inline: false }],
          timestamp: messageTime ? new Date(messageTime).toISOString() : nowIso(),
        },
      ],
      allowed_mentions: { parse: ['everyone'] },
    });

    sent++;
  }

  firstSafetyCheck = false;
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
      lastKmaStatus = `error: ${error?.message || error}`;
      await log('ERROR', 'KMA earthquake API check failed', error);
    }

    if (safetyResult.status === 'rejected') {
      const error = safetyResult.reason;
      lastSafetyStatus = `error: ${error?.message || error}`;
      await log('ERROR', 'Safety API check failed', error);
    }
  } while (rerunRequested);

  checksRunning = false;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function allowHttpRequest(ip) {
  const now = Date.now();
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

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (isSuspiciousPath(url.pathname)) {
    blockedRequests++;
    console.warn(`[BLOCKED HTTP] ip=${ip} path=${url.pathname}`);
    return sendText(res, 403, 'forbidden');
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      lastCheckAt,
      kma: lastKmaStatus,
      safety: lastSafetyStatus,
      queuedMessages: sendQueue.length,
      blockedRequests,
    });
  }

  if (url.pathname === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /\n');
  if (url.pathname === '/favicon.ico') return sendText(res, 204, '');

  blockedRequests++;
  return sendText(res, 404, 'not found');
}

const server = http.createServer(handleHttp);
server.maxHeadersCount = 32;
server.requestTimeout = 5000;
server.headersTimeout = 6000;
server.keepAliveTimeout = 3000;

server.listen(ENV.PORT, '0.0.0.0', async () => {
  console.log(`Render web server started on port ${ENV.PORT}`);
  await verifyDiscordToken();
  await runChecks();
  setInterval(runChecks, FIVE_MINUTES_MS);
});
