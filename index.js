/*************************************************
 * Earthquake Alert Discord Bot
 * STABLE VERSION (with health & graceful shutdown)
 *************************************************/

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes
} from 'discord.js';

/* =========================
   ENV VALIDATION
========================= */
const {
  DISCORD_TOKEN,
  APPLICATION_ID,
  OWNER_ID,
  PORT,
  KMA_KEY,
  CHANNEL_IDS // optional: comma separated channel IDs
} = process.env;

if (!DISCORD_TOKEN || !APPLICATION_ID || !OWNER_ID) {
  console.error('[ENV] Missing required environment variable: DISCORD_TOKEN, APPLICATION_ID, or OWNER_ID');
  process.exit(1);
}

/* =========================
   EXPRESS (health)
========================= */
const app = express();

// 기본 루트: 간단한 확인용
app.get('/', (_, res) => res.status(200).send('Bot is running'));

// 헬스체크 엔드포인트: UptimeRobot에 등록할 URL
app.get('/health', (_, res) => {
  const payload = {
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };
  console.log('[HTTP] /health checked');
  return res.status(200).json(payload);
});

const LISTEN_PORT = Number(PORT) || 3000;
const server = app.listen(LISTEN_PORT, () => {
  console.log(`[HTTP] Listening on port ${LISTEN_PORT}`);
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
   STATE
========================= */
const sent = {
  kma: new Set(),
  jma: new Set()
};
let running = true;

/* =========================
   UTIL
========================= */
const isOwner = id => id === OWNER_ID;

const api = axios.create({
  timeout: 8000,
  validateStatus: status => status >= 200 && status < 300
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
  try {
    await Promise.all(
      CHANNEL_IDS_LIST.map(async channelId => {
        const channel = await getChannel(channelId);
        if (!channel) return;
        await channel.send({
          content: everyone ? '@everyone' : undefined,
          embeds: [embed]
        });
      })
    );
  } catch (err) {
    console.error('[DISCORD ERROR] 메시지 전송 실패', err?.message || err);
  }
}

/* =========================
   KMA (Korea)
========================= */
const KMA_URL = 'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg';

async function fetchKMA() {
  if (!KMA_KEY) {
    // KMA key optional; skip if not provided
    return;
  }

  try {
    const res = await api.get(KMA_URL, {
      params: {
        serviceKey: KMA_KEY,
        numOfRows: 10,
        pageNo: 1,
        dataType: 'JSON',
        // These date params are examples; consider making dynamic if needed
        fromTmFc: '20260115',
        toTmFc: '20280115'
      }
    });

    const items = res.data?.response?.body?.items?.item;
    if (!Array.isArray(items)) return;

    for (const e of items) {
      if (!e?.tmEqk || !e?.loc) continue;
      if (sent.kma.has(e.tmEqk)) continue;
      sent.kma.add(e.tmEqk);

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

      const t = Date.parse(e.tmEqk);
      if (!Number.isNaN(t)) embed.setTimestamp(new Date(t));

      await sendEmbed(embed, mag >= 4.0);
    }
  } catch (err) {
    console.error('[KMA ERROR]', err?.message || err);
  }
}

/* =========================
   JMA (Japan)
========================= */
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';

async function fetchJMA() {
  try {
    const res = await api.get(JMA_URL);
    if (!Array.isArray(res.data)) return;

    const now = Date.now();

    for (const e of res.data) {
      if (!e?.time || !e?.place) continue;
      const id = `${e.time}-${e.lat ?? ''}-${e.lon ?? ''}-${e.place}`;
      if (sent.jma.has(id)) continue;

      const t = Date.parse(e.time);
      if (!Number.isFinite(t) || now - t > 10 * 60 * 1000) continue;

      sent.jma.add(id);

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

      await sendEmbed(embed, intensity >= 5);
    }
  } catch (err) {
    console.error('[JMA ERROR]', err?.message || err);
  }
}

/* =========================
   SCHEDULER (start after ready)
========================= */
let pollInFlight = false;
const POLL_INTERVAL_MS = 60_000;
let pollIntervalHandle = null;

function startPolling() {
  if (pollIntervalHandle) return;
  pollIntervalHandle = setInterval(async () => {
    if (!running || pollInFlight) return;
    pollInFlight = true;
    try {
      await Promise.allSettled([fetchKMA(), fetchJMA()]);
    } finally {
      pollInFlight = false;
    }
  }, POLL_INTERVAL_MS);
  console.log('[SCHEDULER] Polling started');
}

function stopPolling() {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
    console.log('[SCHEDULER] Polling stopped');
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
    console.log('[DISCORD] Slash commands registered');
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
      await interaction.reply('🟢 정상 작동 중');
      return;
    }

    if (interaction.commandName === '청소') {
      sent.kma.clear();
      sent.jma.clear();
      channelCache.clear();
      await interaction.reply('🧹 캐시 초기화 완료');
      return;
    }

    if (interaction.commandName === 'stop') {
      await interaction.reply('⛔ 봇 종료 중');
      running = false;
      // give some time for reply to send
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
  console.log(`로그인 완료: ${client.user.tag}`);
  await registerCommands();

  // initial fetch on startup (non-blocking)
  try {
    await Promise.allSettled([fetchKMA(), fetchJMA()]);
  } catch (e) {
    console.error('[STARTUP FETCH ERROR]', e?.message || e);
  }

  // start scheduler only after client is ready
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
  console.log(`[SHUTDOWN] Received ${signal}, shutting down...`);
  running = false;
  stopPolling();

  try {
    if (client && client.destroy) {
      await client.destroy();
      console.log('[SHUTDOWN] Discord client destroyed');
    }
  } catch (e) {
    console.error('[SHUTDOWN] Error destroying Discord client', e?.message || e);
  }

  try {
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
    // force exit if not closed in time
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