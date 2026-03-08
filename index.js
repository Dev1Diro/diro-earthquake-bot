/*************************************************
 * Earthquake Alert Discord Bot (완전판)
 * - 기상청(KMA) / 일본기상청(JMA) / 안전안내문자(NDMS V2) 통합
 * - KMA <rem> 분석을 통한 국가별 임베드 분기
 * - Render 아웃바운드 IP 확인 지원 (/health)
 *************************************************/

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes
} from 'discord.js';

/* =========================
   CONFIG
========================= */
const {
  DISCORD_TOKEN,
  APPLICATION_ID,
  OWNER_ID,
  PORT,
  CHANNEL_ID,
  CHANNEL_IDS,
  POLL_INTERVAL_MS,
  KMA_RECENT_MINUTES,
  NUM_ROWS,
  SENT_DIR,
  KMA_KEY,
  SAFETY_KEY, // 국민재난안전포털 API 키
  SEND_MAX_RETRIES,
  SEND_RETRY_BASE_MS,
  ROLLBACK_ON_FAILURE
} = process.env;

const CONFIG = {
  PORT: Number(PORT) || 3000,
  POLL_INTERVAL_MS: Number(POLL_INTERVAL_MS) || 60_000,
  KMA_RECENT_MINUTES: Number(KMA_RECENT_MINUTES) || 30,
  NUM_ROWS: Number(NUM_ROWS) || 50,
  SENT_DIR: SENT_DIR || path.resolve(process.cwd(), 'sent-state'),
  PERSIST_INTERVAL_MS: 60_000,
  SEND_MAX_RETRIES: Number(SEND_MAX_RETRIES) || 3,
  SEND_RETRY_BASE_MS: Number(SEND_RETRY_BASE_MS) || 500,
  ROLLBACK_ON_FAILURE: (ROLLBACK_ON_FAILURE === undefined) ? true : (ROLLBACK_ON_FAILURE === 'true')
};

if (!DISCORD_TOKEN) {
  console.error('[ENV] DISCORD_TOKEN is required');
  process.exit(1);
}

/* =========================
   HTTP (health & IP check)
========================= */
const app = express();
let lastPollAt = null;
let lastPollStatus = 'idle';

app.get('/', (_, res) => res.status(200).send('Bot is running'));
app.get('/health', async (_, res) => {
  // Render 등의 서버에서 아웃바운드 IP를 확인하기 위한 로직
  const ipRes = await axios.get('https://api.ipify.org?format=json').catch(() => ({ data: { ip: 'unknown' } }));
  
  const payload = {
    status: 'ok',
    outbound_ip: ipRes.data.ip, // 공공데이터포털에 등록할 IP
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    last_poll_at: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    last_poll_status: lastPollStatus
  };
  return res.status(200).json(payload);
});

const server = app.listen(CONFIG.PORT, () => {
  console.info(`[HTTP] Listening on port ${CONFIG.PORT}`);
});

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* =========================
   STATE (file-based)
========================= */
const sent = { kma: new Set(), jma: new Set(), ndms: new Set() };
const SENT_KMA_PATH = path.join(CONFIG.SENT_DIR, 'sent-kma.json');
const SENT_JMA_PATH = path.join(CONFIG.SENT_DIR, 'sent-jma.json');
const SENT_NDMS_PATH = path.join(CONFIG.SENT_DIR, 'sent-ndms.json');

async function ensureSentDir() {
  try {
    await fs.mkdir(CONFIG.SENT_DIR, { recursive: true });
  } catch (e) {
    console.error('[STATE] ensureSentDir failed', e?.message || e);
  }
}

async function atomicWriteFile(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

async function ensureSentFilesExist() {
  await ensureSentDir();
  const files = [SENT_KMA_PATH, SENT_JMA_PATH, SENT_NDMS_PATH];
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await atomicWriteFile(file, JSON.stringify([], null, 2));
      console.info('[STATE] Created empty', file);
    }
  }
}

async function loadSentStateFromFiles() {
  await ensureSentFilesExist();
  
  const loadState = async (path, key, name) => {
    try {
      const raw = await fs.readFile(path, 'utf8').catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) parsed.forEach(id => sent[key].add(id));
        console.info(`[STATE] Loaded ${name} sent IDs`);
      }
    } catch (e) { console.warn(`[STATE] load ${name} failed`, e?.message || e); }
  };

  await loadState(SENT_KMA_PATH, 'kma', 'KMA');
  await loadState(SENT_JMA_PATH, 'jma', 'JMA');
  await loadState(SENT_NDMS_PATH, 'ndms', 'NDMS');
}

let persistTimer = null;
async function persistSentStateToFiles() {
  await ensureSentDir();
  try {
    await atomicWriteFile(SENT_KMA_PATH, JSON.stringify(Array.from(sent.kma), null, 2));
    await atomicWriteFile(SENT_JMA_PATH, JSON.stringify(Array.from(sent.jma), null, 2));
    await atomicWriteFile(SENT_NDMS_PATH, JSON.stringify(Array.from(sent.ndms), null, 2));
    console.info('[STATE] Persisted sent-state to disk');
  } catch (e) {
    console.error('[STATE] persist failed', e?.message || e);
  }
}

function schedulePeriodicPersist() {
  if (persistTimer) return;
  persistTimer = setInterval(() => {
    persistSentStateToFiles().catch(e => console.error('[STATE] periodic persist error', e?.message || e));
  }, CONFIG.PERSIST_INTERVAL_MS);
}

/* =========================
   UTIL
========================= */
const isOwner = id => Boolean(OWNER_ID) && id === OWNER_ID;

const api = axios.create({
  timeout: 10_000,
  validateStatus: status => status >= 200 && status < 600
});

const DEFAULT_CHANNEL_IDS = [
  '1460620799055495352',
  '1468559204217520150'
];

function parseChannelIds(value) {
  if (!value) return [];
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

const parsedChannelIds = parseChannelIds(CHANNEL_IDS);
const parsedLegacyChannelId = parseChannelIds(CHANNEL_ID);
const CHANNEL_IDS_LIST = (
  parsedChannelIds.length > 0
    ? parsedChannelIds
    : parsedLegacyChannelId.length > 0
      ? parsedLegacyChannelId
      : DEFAULT_CHANNEL_IDS
);

const channelCache = new Map();

async function getChannel(channelId) {
  const now = Date.now();
  const cached = channelCache.get(channelId);
  if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
    return cached.channel;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    channelCache.set(channelId, { channel: channel ?? null, fetchedAt: now });
    return channel ?? null;
  } catch (err) {
    console.error('[DISCORD ERROR] 채널 조회 실패', channelId, err?.message || err);
    return null;
  }
}

/* =========================
   TIME PARSERS
========================= */
function parseKmaTime(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  if (/^\d{14}$/.test(s)) {
    const yyyy = Number(s.slice(0, 4));
    const MM = Number(s.slice(4, 6)) - 1;
    const dd = Number(s.slice(6, 8));
    const hh = Number(s.slice(8, 10));
    const mm = Number(s.slice(10, 12));
    const ss = Number(s.slice(12, 14));
    const dt = new Date(yyyy, MM, dd, hh, mm, ss);
    return Number.isFinite(dt.getTime()) ? dt.getTime() : NaN;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function parseGenericTime(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/* =========================
   MARK & SEND 로직
========================= */
async function markSentImmediate(kind, uniqueId) {
  try {
    sent[kind].add(uniqueId);
    await persistSentStateToFiles();
    console.info(`[STATE] Marked ${kind} as sent (immediate): ${uniqueId}`);
  } catch (e) {
    console.error('[STATE] markSentImmediate failed', e?.message || e);
  }
}

async function sendToChannelWithRetries(channel, payload, maxRetries = CONFIG.SEND_MAX_RETRIES) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      if (!channel) throw new Error('채널 없음');
      if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
        throw new Error('텍스트 전송 불가 채널');
      }
      await channel.send(payload);
      return { ok: true };
    } catch (err) {
      attempt += 1;
      const msg = err?.message || String(err);
      const isRateLimit = /429|rate limit/i.test(msg);
      const backoff = CONFIG.SEND_RETRY_BASE_MS * Math.pow(2, attempt - 1) * (isRateLimit ? 2 : 1);
      console.warn(`[DISCORD SEND] 채널 전송 실패 (attempt ${attempt}/${maxRetries})`, msg);
      if (attempt > maxRetries) return { ok: false, error: msg };
      await new Promise(res => setTimeout(res, backoff));
    }
  }
  return { ok: false, error: 'unknown' };
}

async function sendEmbedAfterMark(kind, uniqueId, embed, everyone = false) {
  await markSentImmediate(kind, uniqueId);

  const payload = {
    content: everyone ? '@everyone' : undefined,
    embeds: [embed],
    allowedMentions: { parse: everyone ? ['everyone'] : [] }
  };

  const results = await Promise.all(
    CHANNEL_IDS_LIST.map(async channelId => {
      const channel = await getChannel(channelId);
      if (!channel) return { channelId, ok: false, error: 'no-channel' };
      try {
        const res = await sendToChannelWithRetries(channel, payload);
        if (res.ok) {
          console.info(`[DISCORD] 메시지 전송 완료 (${kind})`, channelId);
          return { channelId, ok: true };
        } else {
          return { channelId, ok: false, error: res.error };
        }
      } catch (err) {
        return { channelId, ok: false, error: err?.message || err };
      }
    })
  );

  if (results.some(r => r.ok)) return true;

  if (CONFIG.ROLLBACK_ON_FAILURE) {
    try {
      sent[kind].delete(uniqueId);
      await persistSentStateToFiles();
      console.info(`[STATE] Rolled back ${kind} ${uniqueId} after send failure`);
    } catch (e) {
      console.error('[STATE] rollback failed', e?.message || e);
    }
  }
  return false;
}

/* =========================
   DATE & MAP HELPERS
========================= */
function pad(n) { return String(n).padStart(2, '0'); }

function getYYYYMMDDForKST(date = new Date()) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const kst = new Date(utc + 9 * 60 * 60 * 1000);
  const yyyy = kst.getFullYear();
  const mm = pad(kst.getMonth() + 1);
  const dd = pad(kst.getDate());
  return `${yyyy}${mm}${dd}`;
}

function getTodayRangeKMA() {
  const yyyyMMdd = getYYYYMMDDForKST(new Date());
  return { from: yyyyMMdd, to: yyyyMMdd };
}

function getMapLink(lat, lon, place) {
  if (lat != null && lon != null && lat !== '' && lon !== '') {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
  }
  if (place) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  return null;
}

/* =========================
   KMA FETCH (지진)
========================= */
const KMA_URL_BASE = 'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg';

async function fetchKMA() {
  if (!KMA_KEY) return;
  const { from, to } = getTodayRangeKMA();

  try {
    const r = await api.get(KMA_URL_BASE, {
      params: { serviceKey: KMA_KEY, numOfRows: CONFIG.NUM_ROWS, pageNo: 1, dataType: 'JSON', fromTmFc: from, toTmFc: to }
    });

    if (r.status === 429 || r.status >= 300) return;
    const items = r.data?.response?.body?.items?.item;
    if (!Array.isArray(items)) return;

    const now = Date.now();
    for (const e of items) {
      try {
        if (!e?.tmEqk || !e?.loc) continue;

        const uniqueId = `${String(e.tmEqk)}|${String(e.loc)}|${String(e.mt ?? '')}`;
        if (sent.kma.has(uniqueId)) continue;

        const t = parseKmaTime(String(e.tmEqk));
        if (!Number.isFinite(t) || (now - t > CONFIG.KMA_RECENT_MINUTES * 60 * 1000)) continue;

        const mag = Number(e.mt);
        const rem = e.rem ? String(e.rem) : '';
        
        // 국가별 임베드 분기 처리 로직
        let isJapan = rem.includes('일본기상청') || rem.includes('JMA');
        let isForeign = !isJapan && (rem.includes('미국지질조사소') || rem.includes('USGS') || rem.includes('국외') || rem.includes('해외'));

        let embedTitle = '🌏 지진 발생 (대한민국)';
        let embedColor = mag >= 5 ? 0xd32f2f : mag >= 4 ? 0xf57c00 : 0x1976d2; // 기본: 붉은색/주황색/파란색
        let embedFooter = 'KMA / 기상청';

        if (isJapan) {
          embedTitle = '🌋 지진 발생 (일본)';
          embedFooter = 'KMA (일본기상청 분석 결과)';
        } else if (isForeign) {
          embedTitle = '🌍 국외 지진 발생';
          embedColor = 0x607d8b; // 회청색 (국외 지진 범용)
          embedFooter = 'KMA (국외 분석 기관 결과)';
        }

        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setColor(embedColor)
          .addFields(
            { name: '📍 위치', value: String(e.loc), inline: false },
            { name: '📏 규모', value: Number.isFinite(mag) ? `**${mag.toFixed(1)}**` : '정보 없음', inline: true },
            { name: '🕒 발생시각', value: new Date(t).toISOString(), inline: true }
          )
          .setFooter({ text: embedFooter })
          .setTimestamp(new Date(t));

        if (rem) {
          embed.addFields({ name: '📝 참고사항', value: rem, inline: false });
        }

        const mapLink = getMapLink(e.lat ?? e.latitude ?? null, e.lon ?? e.longitude ?? null, e.loc);
        if (mapLink) embed.addFields({ name: '🗺️ 지도', value: `[지도 보기](${mapLink})`, inline: false });

        const mentionEveryone = Number.isFinite(mag) && mag >= 4.0;
        await sendEmbedAfterMark('kma', uniqueId, embed, mentionEveryone);
      } catch (innerErr) {
        console.error('[KMA ITEM ERROR]', innerErr?.message || innerErr);
      }
    }
  } catch (err) {
    console.error('[KMA ERROR]', err?.message || err);
  }
}

/* =========================
   JMA FETCH (일본 지진)
========================= */
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';

async function fetchJMA() {
  try {
    const r = await api.get(JMA_URL);
    if (r.status === 429 || r.status >= 300) return;
    if (!Array.isArray(r.data)) return;

    const now = Date.now();
    for (const e of r.data) {
      try {
        if (!e?.time || !e?.place) continue;
        const id = `${e.time}-${e.lat ?? ''}-${e.lon ?? ''}-${e.place}`;
        if (sent.jma.has(id)) continue;

        const t = parseGenericTime(e.time);
        if (!Number.isFinite(t) || (now - t > CONFIG.KMA_RECENT_MINUTES * 60 * 1000)) continue;

        const intensity = Number(e.maxi || 0);
        const mag = Number(e.mag);
        const color = intensity >= 5 ? 0xd32f2f : intensity >= 4 ? 0xf57c00 : 0x1976d2;
        
        const embed = new EmbedBuilder()
          .setTitle('🌋 지진 발생 (일본)')
          .setColor(color)
          .addFields(
            { name: '📍 위치', value: String(e.place), inline: false },
            { name: '📏 규모', value: Number.isFinite(mag) ? `**${mag.toFixed(1)}**` : '정보 없음', inline: true },
            { name: '💥 최대진도', value: e.maxi ? String(e.maxi) : '정보 없음', inline: true },
            { name: '🕒 발생시각', value: new Date(t).toISOString(), inline: true }
          )
          .setFooter({ text: 'JMA / Japan Meteorological Agency' })
          .setTimestamp(new Date(t));

        const mapLink = getMapLink(e.lat ?? null, e.lon ?? null, e.place);
        if (mapLink) embed.addFields({ name: '🗺️ 지도', value: `[지도 보기](${mapLink})`, inline: false });

        const mentionEveryone = intensity >= 5;
        await sendEmbedAfterMark('jma', id, embed, mentionEveryone);
      } catch (innerErr) {
        console.error('[JMA ITEM ERROR]', innerErr?.message || innerErr);
      }
    }
  } catch (err) {
    console.error('[JMA ERROR]', err?.message || err);
  }
}

/* =========================
   SAFETY DATA FETCH (안전안내문자 V2)
========================= */
const SAFETY_URL = 'https://safetydata.go.kr/V2/api/DSSP-IF-00247';

async function fetchSafetyAlerts() {
  if (!SAFETY_KEY) return;

  try {
    const r = await api.get(SAFETY_URL, {
      params: { serviceKey: SAFETY_KEY, returnType: 'json', numOfRows: 10, pageNo: 1 }
    });

    const items = r.data?.body?.[0]?.data || r.data?.body;
    if (!Array.isArray(items)) return;

    for (const e of items) {
      try {
        const uniqueId = String(e.MD101_SN || e.SN);
        if (!uniqueId || uniqueId === 'undefined') continue;
        if (sent.ndms.has(uniqueId)) continue;

        const msgCn = String(e.MSG_CN || e.msg || '내용 없음');
        
        // 안전안내문자는 멘션 X, 긴급/위급재난문자는 @everyone
        const isUrgent = msgCn.includes('긴급재난문자') || msgCn.includes('위급재난문자');
        const title = isUrgent ? '🚨 긴급/위급 재난 문자' : '📢 안전 안내 문자';
        const color = isUrgent ? 0xd32f2f : 0xFFB400; // 빨강(긴급) or 주황/노랑(안전)

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setColor(color)
          .setDescription(msgCn)
          .addFields(
            { name: '📍 수신 지역', value: String(e.RCPTN_RGN_NM || e.locationName || '전국'), inline: true },
            { name: '🕒 발송 시각', value: String(e.CRT_DT || e.create_date || '정보 없음'), inline: true }
          )
          .setFooter({ text: '행정안전부 국민재난안전포털' });

        await sendEmbedAfterMark('ndms', uniqueId, embed, isUrgent);
      } catch (innerErr) {
        console.error('[SAFETY ITEM ERROR]', innerErr?.message || innerErr);
      }
    }
  } catch (err) {
    console.error('[SAFETY ERROR]', err?.message || err);
  }
}

/* =========================
   SCHEDULER
========================= */
let pollInFlight = false;
let pollIntervalHandle = null;
let running = true;

async function pollOnce() {
  if (!running || pollInFlight) return;
  pollInFlight = true;
  lastPollAt = Date.now();
  lastPollStatus = 'running';
  try {
    // 세 가지 API 모두 동시 호출
    await Promise.allSettled([fetchKMA(), fetchJMA(), fetchSafetyAlerts()]);
    lastPollStatus = 'ok';
  } catch (err) {
    lastPollStatus = 'error';
    console.error('[POLL] unexpected error', err?.message || err);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollIntervalHandle) return;
  pollOnce().catch(e => console.error('[POLL] initial poll error', e?.message || e));
  pollIntervalHandle = setInterval(() => {
    pollOnce().catch(e => console.error('[POLL] poll error', e?.message || e));
  }, CONFIG.POLL_INTERVAL_MS);
  console.info('[SCHEDULER] Polling started', { interval_ms: CONFIG.POLL_INTERVAL_MS });
}

function stopPolling() {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
    console.info('[SCHEDULER] Polling stopped');
  }
}

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  { name: '상태', description: '봇 상태 확인' },
  { name: '청소', description: '캐시 초기화' },
  { name: 'stop', description: '봇 종료' }
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  if (!APPLICATION_ID) return;
  try {
    await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: commands });
    console.info('[DISCORD] Slash commands registered');
  } catch (err) {
    console.error('[DISCORD] Slash command registration failed', err?.message || err);
  }
}

/* =========================
   COMMAND HANDLER
========================= */
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!OWNER_ID) return interaction.reply({ content: 'OWNER_ID 미설정: 관리자 명령어를 사용할 수 없습니다.', ephemeral: true });
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: '권한 없음', ephemeral: true });

    if (interaction.commandName === '상태') {
      const uptime = Math.floor(process.uptime());
      await interaction.reply(`🟢 정상 작동 중\nuptime: ${uptime}s\nlast poll: ${lastPollAt ? new Date(lastPollAt).toISOString() : 'N/A'}`);
      return;
    }

    if (interaction.commandName === '청소') {
      sent.kma.clear();
      sent.jma.clear();
      sent.ndms.clear();
      channelCache.clear();
      await persistSentStateToFiles();
      await interaction.reply('🧹 캐시 초기화 완료');
      return;
    }

    if (interaction.commandName === 'stop') {
      await interaction.reply('⛔ 봇 종료 중');
      running = false;
      setTimeout(() => process.exit(0), 1000);
      return;
    }
  } catch (err) {
    console.error('[COMMAND HANDLER ERROR]', err?.message || err);
  }
});

/* =========================
   READY and START
========================= */
client.once('ready', async () => {
  console.info(`로그인 완료: ${client.user.tag}`);
  console.info('[DISCORD] target channels', CHANNEL_IDS_LIST);
  await registerCommands();

  await loadSentStateFromFiles();
  schedulePeriodicPersist();

  startPolling();
});

/* =========================
   GLOBAL ERROR HANDLING
========================= */
process.on('unhandledRejection', err => console.error('[UNHANDLED REJECTION]', err?.stack || err));
process.on('uncaughtException', err => console.error('[UNCAUGHT EXCEPTION]', err?.stack || err));

/* =========================
   LOGIN
========================= */
client.login(DISCORD_TOKEN).catch(err => {
  console.error('[DISCORD LOGIN FAILED]', err?.message || err);
  process.exit(1);
});

/* =========================
   GRACEFUL SHUTDOWN
========================= */
async function shutdown(signal) {
  console.info(`[SHUTDOWN] Received ${signal}, shutting down...`);
  running = false;
  stopPolling();

  try {
    if (persistTimer) { clearInterval(persistTimer); persistTimer = null; }
    await persistSentStateToFiles();
  } catch (e) { console.warn('[SHUTDOWN] Error persisting state', e?.message || e); }

  try {
    if (client && client.destroy) {
      await client.destroy();
      console.info('[SHUTDOWN] Discord client destroyed');
    }
  } catch (e) { console.error('[SHUTDOWN] Error destroying Discord client', e?.message || e); }

  try {
    server.close(() => {
      console.info('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  } catch (e) {
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));