/*************************************************
 * Earthquake Alert Discord Bot
 * - File-only persistence (sent-kma.json / sent-jma.json)
 * - 임베드 전송 성공 후에만 전송 이력 저장
 * - 시작 시 sent 파일이 없으면 빈 배열로 자동 생성
 * - KMA 키는 환경변수 KMA_KEY 사용
 * - KMA: 오늘(00:00~23:59 KST) 조회, 최근 N분(기본 30분) 필터
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
  CHANNEL_IDS, // optional: comma separated channel IDs
  POLL_INTERVAL_MS,
  KMA_RECENT_MINUTES,
  NUM_ROWS,
  SENT_DIR,
  KMA_KEY
} = process.env;

const CONFIG = {
  PORT: Number(PORT) || 3000,
  POLL_INTERVAL_MS: Number(POLL_INTERVAL_MS) || 60_000,
  KMA_RECENT_MINUTES: Number(KMA_RECENT_MINUTES) || 30,
  NUM_ROWS: Number(NUM_ROWS) || 50,
  SENT_DIR: SENT_DIR || path.resolve(process.cwd(), 'sent-state'),
  PERSIST_INTERVAL_MS: 60_000
};

if (!DISCORD_TOKEN || !APPLICATION_ID || !OWNER_ID) {
  console.error('[ENV] DISCORD_TOKEN, APPLICATION_ID, OWNER_ID are required');
  process.exit(1);
}

/* =========================
   HTTP (health)
========================= */
const app = express();
let lastPollAt = null;
let lastPollStatus = 'idle';

app.get('/', (_, res) => res.status(200).send('Bot is running'));
app.get('/health', (_, res) => {
  const payload = {
    status: 'ok',
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
   - sent-kma.json, sent-jma.json
   - 시작 시 파일이 없으면 빈 배열로 생성
========================= */
const sent = { kma: new Set(), jma: new Set() };
const SENT_KMA_PATH = path.join(CONFIG.SENT_DIR, 'sent-kma.json');
const SENT_JMA_PATH = path.join(CONFIG.SENT_DIR, 'sent-jma.json');

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
  try {
    await fs.access(SENT_KMA_PATH).catch(async () => {
      await atomicWriteFile(SENT_KMA_PATH, JSON.stringify([], null, 2));
      console.info('[STATE] Created empty', SENT_KMA_PATH);
    });
    await fs.access(SENT_JMA_PATH).catch(async () => {
      await atomicWriteFile(SENT_JMA_PATH, JSON.stringify([], null, 2));
      console.info('[STATE] Created empty', SENT_JMA_PATH);
    });
  } catch (e) {
    console.error('[STATE] ensureSentFilesExist error', e?.message || e);
  }
}

async function loadSentStateFromFiles() {
  await ensureSentFilesExist();
  try {
    const rawKma = await fs.readFile(SENT_KMA_PATH, 'utf8').catch(() => null);
    if (rawKma) {
      const parsed = JSON.parse(rawKma);
      if (Array.isArray(parsed)) parsed.forEach(id => sent.kma.add(id));
      console.info('[STATE] Loaded KMA sent IDs', SENT_KMA_PATH);
    }
  } catch (e) {
    console.warn('[STATE] load KMA failed', e?.message || e);
  }

  try {
    const rawJma = await fs.readFile(SENT_JMA_PATH, 'utf8').catch(() => null);
    if (rawJma) {
      const parsed = JSON.parse(rawJma);
      if (Array.isArray(parsed)) parsed.forEach(id => sent.jma.add(id));
      console.info('[STATE] Loaded JMA sent IDs', SENT_JMA_PATH);
    }
  } catch (e) {
    console.warn('[STATE] load JMA failed', e?.message || e);
  }
}

let persistTimer = null;
async function persistSentStateToFiles() {
  await ensureSentDir();
  try {
    await atomicWriteFile(SENT_KMA_PATH, JSON.stringify(Array.from(sent.kma), null, 2));
    await atomicWriteFile(SENT_JMA_PATH, JSON.stringify(Array.from(sent.jma), null, 2));
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
const isOwner = id => id === OWNER_ID;

const api = axios.create({
  timeout: 10_000,
  validateStatus: status => status >= 200 && status < 600
});

const DEFAULT_CHANNEL_IDS = [
  '1460620799055495352',
  '1468559204217520150'
];
const CHANNEL_IDS_LIST = (CHANNEL_IDS && CHANNEL_IDS.split(',').map(s => s.trim()).filter(Boolean)) || DEFAULT_CHANNEL_IDS;

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

async function sendEmbed(embed, everyone = false) {
  await Promise.all(
    CHANNEL_IDS_LIST.map(async channelId => {
      const channel = await getChannel(channelId);
      if (!channel) {
        console.warn('[DISCORD] 채널 없음', channelId);
        return;
      }
      if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
        console.warn('[DISCORD] 텍스트 전송 불가 채널, 스킵', channelId);
        return;
      }
      await channel.send({
        content: everyone ? '@everyone' : undefined,
        embeds: [embed],
        allowedMentions: { parse: everyone ? ['everyone'] : [] }
      });
      console.info('[DISCORD] 메시지 전송 완료', channelId);
    })
  );
}

// 전송 성공 후에만 마킹하고 파일에 저장
async function sendEmbedAndPersist(kind, uniqueId, embed, everyone = false) {
  try {
    await sendEmbed(embed, everyone);
    // 전송 성공 시 메모리 마킹
    sent[kind].add(uniqueId);
    // 즉시 원자적 저장 (await 하여 보장)
    await persistSentStateToFiles();
    console.info(`[SEND] ${kind} sent and persisted: ${uniqueId}`);
    return true;
  } catch (err) {
    console.error('[SEND] embed send failed, not persisting', err?.message || err);
    return false;
  }
}

/* =========================
   DATE HELPERS
========================= */
function pad(n) { return String(n).padStart(2, '0'); }

// KMA expects YYYYMMDD in KST
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

function nowMs() { return Date.now(); }

/* =========================
   MAP LINK HELPER
========================= */
function getMapLink(lat, lon, place) {
  if (lat != null && lon != null && lat !== '' && lon !== '') {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
  }
  if (place) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  }
  return null;
}

/* =========================
   KMA FETCH (KMA_KEY from env)
========================= */
const KMA_URL_BASE = 'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg';
const KMA_RECENT_WINDOW_MS = CONFIG.KMA_RECENT_MINUTES * 60 * 1000;

async function fetchKMA() {
  if (!KMA_KEY) {
    console.info('[KMA] KMA_KEY not provided, skipping KMA fetch');
    return;
  }

  const { from, to } = getTodayRangeKMA();

  try {
    const r = await api.get(KMA_URL_BASE, {
      params: {
        serviceKey: KMA_KEY,
        numOfRows: CONFIG.NUM_ROWS,
        pageNo: 1,
        dataType: 'JSON',
        fromTmFc: from,
        toTmFc: to
      }
    });

    if (r.status === 429) {
      console.warn('[KMA] 429 Too Many Requests, skipping this poll');
      return;
    }
    if (r.status < 200 || r.status >= 300) {
      console.warn('[KMA] unexpected status', r.status);
      return;
    }

    const items = r.data?.response?.body?.items?.item;
    if (!Array.isArray(items)) {
      console.info('[KMA] No items in response');
      return;
    }

    const now = nowMs();

    for (const e of items) {
      try {
        if (!e?.tmEqk || !e?.loc) continue;

        const uniqueId = `${String(e.tmEqk)}|${String(e.loc)}|${String(e.mt ?? '')}`;
        if (sent.kma.has(uniqueId)) continue;

        const t = Date.parse(String(e.tmEqk));
        if (!Number.isFinite(t)) {
          console.warn('[KMA] 발생시각 파싱 실패, 스킵:', e.tmEqk);
          continue;
        }
        if (now - t > KMA_RECENT_WINDOW_MS) continue;

        const mag = Number(e.mt);
        const color = mag >= 5 ? 0xd32f2f : mag >= 4 ? 0xf57c00 : 0x1976d2;
        const embed = new EmbedBuilder()
          .setTitle('🌏 지진 발생 (대한민국)')
          .setColor(color)
          .addFields(
            { name: '📍 위치', value: String(e.loc), inline: false },
            { name: '📏 규모', value: Number.isFinite(mag) ? `**${mag.toFixed(1)}**` : '정보 없음', inline: true },
            { name: '🕒 발생시각', value: String(e.tmEqk), inline: true }
          )
          .setFooter({ text: 'KMA / 기상청' });

        embed.setTimestamp(new Date(t));

        const lat = e.lat ?? e.latitude ?? null;
        const lon = e.lon ?? e.longitude ?? null;
        const mapLink = getMapLink(lat, lon, e.loc);
        if (mapLink) embed.addFields({ name: '🗺️ 지도', value: `[지도 보기](${mapLink})`, inline: false });

        const mentionEveryone = Number.isFinite(mag) && mag >= 4.0;
        // 전송 성공 시에만 저장
        await sendEmbedAndPersist('kma', uniqueId, embed, mentionEveryone);
      } catch (innerErr) {
        console.error('[KMA ITEM ERROR]', innerErr?.message || innerErr);
      }
    }
  } catch (err) {
    console.error('[KMA ERROR]', err?.message || err);
  }
}

/* =========================
   JMA FETCH
========================= */
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
const JMA_RECENT_WINDOW_MS = CONFIG.KMA_RECENT_MINUTES * 60 * 1000;

async function fetchJMA() {
  try {
    const r = await api.get(JMA_URL);

    if (r.status === 429) {
      console.warn('[JMA] 429 Too Many Requests, skipping this poll');
      return;
    }
    if (r.status < 200 || r.status >= 300) {
      console.warn('[JMA] unexpected status', r.status);
      return;
    }

    if (!Array.isArray(r.data)) {
      console.info('[JMA] No items in response');
      return;
    }

    const now = nowMs();

    for (const e of r.data) {
      try {
        if (!e?.time || !e?.place) continue;
        const id = `${e.time}-${e.lat ?? ''}-${e.lon ?? ''}-${e.place}`;
        if (sent.jma.has(id)) continue;

        const t = Date.parse(e.time);
        if (!Number.isFinite(t)) {
          console.warn('[JMA] 발생시각 파싱 실패, 스킵:', e.time);
          continue;
        }
        if (now - t > JMA_RECENT_WINDOW_MS) continue;

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
            { name: '🕒 발생시각', value: String(e.time), inline: true }
          )
          .setFooter({ text: 'JMA / Japan Meteorological Agency' });

        embed.setTimestamp(new Date(t));

        const mapLink = getMapLink(e.lat ?? null, e.lon ?? null, e.place);
        if (mapLink) embed.addFields({ name: '🗺️ 지도', value: `[지도 보기](${mapLink})`, inline: false });

        const mentionEveryone = intensity >= 5;
        await sendEmbedAndPersist('jma', id, embed, mentionEveryone);
      } catch (innerErr) {
        console.error('[JMA ITEM ERROR]', innerErr?.message || innerErr);
      }
    }
  } catch (err) {
    console.error('[JMA ERROR]', err?.message || err);
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
    await Promise.allSettled([fetchKMA(), fetchJMA()]);
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
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: '권한 없음', ephemeral: true });

    if (interaction.commandName === '상태') {
      const uptime = Math.floor(process.uptime());
      await interaction.reply(`🟢 정상 작동 중\nuptime: ${uptime}s\nlast poll: ${lastPollAt ? new Date(lastPollAt).toISOString() : 'N/A'}`);
      return;
    }

    if (interaction.commandName === '청소') {
      sent.kma.clear();
      sent.jma.clear();
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
  await registerCommands();

  await loadSentStateFromFiles();
  schedulePeriodicPersist();

  try {
    await Promise.allSettled([fetchKMA(), fetchJMA()]);
  } catch (e) {
    console.error('[STARTUP FETCH ERROR]', e?.message || e);
  }

  startPolling();
});

/* =========================
   GLOBAL ERROR HANDLING
========================= */
process.on('unhandledRejection', err => {
  console.error('[UNHANDLED REJECTION]', err?.stack || err);
});
process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err?.stack || err);
});

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
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    await persistSentStateToFiles();
  } catch (e) {
    console.warn('[SHUTDOWN] Error persisting state', e?.message || e);
  }

  try {
    if (client && client.destroy) {
      await client.destroy();
      console.info('[SHUTDOWN] Discord client destroyed');
    }
  } catch (e) {
    console.error('[SHUTDOWN] Error destroying Discord client', e?.message || e);
  }

  try {
    server.close(() => {
      console.info('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('[SHUTDOWN] Forcing exit');
      process.exit(0);
    }, 5000);
  } catch (e) {
    console.error('[SHUTDOWN] Error closing server', e?.message || e);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));