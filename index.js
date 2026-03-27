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
   1. 설정 및 상태 추적
========================= */
const {
  DISCORD_TOKEN, APPLICATION_ID, OWNER_ID, PORT, CHANNEL_IDS,
  KMA_KEY, SAFETY_KEY
} = process.env;

// ✅ 토큰 검증
if (!DISCORD_TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN 없음');
  process.exit(1);
}

const CONFIG = {
  PORT: Number(PORT) || 3000,
  SENT_DIR: path.resolve(process.cwd(), 'data'),
  CHANNELS: (CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  MS_FAIL: 2 * 60 * 60 * 1000,    // 2시간
  MS_NDMS: 5 * 60 * 1000,        // 5분
  MS_EQ: 10 * 60 * 1000          // 10분
};

const stats = {
  kma: { attempts: 0, status: 'idle' },
  jma: { attempts: 0, status: 'idle' },
  ndms: { attempts: 0, status: 'idle' }
};

/* =========================
   2. 유틸
========================= */
const truncate = (str, max) => (str && str.length > max)
  ? str.slice(0, max - 3) + '...'
  : (str || '내용 없음');

function createGoogleMapLink(lat, lon, query) {
  if (lat && lon) return `https://www.google.com/maps?q=${lat},${lon}`;
  if (query) return `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  return null;
}

process.on('uncaughtException', err => console.error('[FATAL]', err));
process.on('unhandledRejection', err => console.error('[FATAL]', err));

/* =========================
   3. 저장소
========================= */
const sent = { kma: new Set(), jma: new Set(), ndms: new Set() };

const FILE_PATHS = {
  kma: path.join(CONFIG.SENT_DIR, 'kma.json'),
  jma: path.join(CONFIG.SENT_DIR, 'jma.json'),
  ndms: path.join(CONFIG.SENT_DIR, 'ndms.json')
};

let isSaving = { kma: false, jma: false, ndms: false };

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true }).catch(() => {});
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const data = await fs.readFile(p, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) list.forEach(id => sent[key].add(id));
    } catch {
      await fs.writeFile(p, '[]', 'utf8').catch(() => {});
    }
  }
}

async function saveStateSafe(key) {
  if (isSaving[key]) return;
  isSaving[key] = true;
  try {
    const tmp = `${FILE_PATHS[key]}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...sent[key]]));
    await fs.rename(tmp, FILE_PATHS[key]);
  } finally {
    isSaving[key] = false;
  }
}

/* =========================
   4. 웹 서버
========================= */
const app = express();

app.get('/', (_, res) => res.send('Bot Status: Online'));

app.get('/health', async (_, res) => {
  try {
    const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
    res.json({ outbound_ip: ipRes.data.ip, stats, uptime: Math.floor(process.uptime()) });
  } catch {
    res.json({ outbound_ip: 'unknown', stats, uptime: Math.floor(process.uptime()) });
  }
});

const server = app.listen(CONFIG.PORT);

/* =========================
   5. 디스코드
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

async function broadcast(payload) {
  for (const channelId of CONFIG.CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send(payload);
    } catch (e) {
      console.error('[SEND ERROR]', e.message);
    }
  }
}

/* =========================
   6. API
========================= */
const api = axios.create({ timeout: 8000 });

// KMA
async function fetchKMA() {
  if (!KMA_KEY) return false;
  stats.kma.attempts++;

  try {
    const kstDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

    const res = await api.get('http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg', {
      params: { serviceKey: KMA_KEY, numOfRows: 10, pageNo: 1, dataType: 'JSON', fromTmFc: kstDate, toTmFc: kstDate }
    });

    const rawItems = res.data?.response?.body?.items?.item;
    const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);

    let hasNew = false;

    for (const e of items) {
      if (!e.tmEqk) continue;
      const id = `${e.tmEqk}_${e.loc}`;
      if (sent.kma.has(id)) continue;

      sent.kma.add(id);
      hasNew = true;

      const mag = Number(e.mt) || 0;
      const mapUrl = createGoogleMapLink(null, null, e.loc);

      const embed = new EmbedBuilder()
        .setTitle('🌏 지진 발생 (KMA)')
        .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
        .addFields([
          { name: '📍 위치', value: truncate(e.loc, 1024) },
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true },
          mapUrl ? { name: '🗺️ 지도', value: `[구글 지도 보기](${mapUrl})` } : null
        ].filter(Boolean))
        .setTimestamp();

      await broadcast({ embeds: [embed] });
    }

    if (hasNew) await saveStateSafe('kma');
    stats.kma.status = 'ok';
    return true;
  } catch {
    stats.kma.status = 'error';
    return false;
  }
}

// JMA
async function fetchJMA() {
  stats.jma.attempts++;

  try {
    const res = await api.get('https://www.jma.go.jp/bosai/quake/data/list.json');
    let hasNew = false;

    for (const e of res.data.slice(0, 5)) {
      const id = `${e.time}_${e.place}`;
      if (sent.jma.has(id)) continue;

      sent.jma.add(id);
      hasNew = true;

      const mag = Number(e.mag) || 0;
      const mapUrl = createGoogleMapLink(null, null, e.place);

      const embed = new EmbedBuilder()
        .setTitle('🌋 일본 지진 (JMA)')
        .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
        .addFields([
          { name: '📍 위치', value: truncate(e.place, 1024) },
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true },
          mapUrl ? { name: '🗺️ 지도', value: `[구글 지도 보기](${mapUrl})` } : null
        ].filter(Boolean));

      await broadcast({ embeds: [embed] });
    }

    if (hasNew) await saveStateSafe('jma');
    stats.jma.status = 'ok';
    return true;
  } catch {
    stats.jma.status = 'error';
    return false;
  }
}

// NDMS
async function fetchNDMS() {
  if (!SAFETY_KEY) return false;
  stats.ndms.attempts++;

  try {
    const res = await api.get('https://safetydata.go.kr/V2/api/DSSP-IF-00247', {
      params: { serviceKey: SAFETY_KEY, returnType: 'json', numOfRows: 5, pageNo: 1 }
    });

    const items = res.data?.body?.[0]?.data || [];
    if (!Array.isArray(items)) throw new Error();

    let hasNew = false;

    for (const e of items) {
      const id = String(e.MD101_SN || e.SN);
      if (!id || sent.ndms.has(id)) continue;

      const timeStr = String(e.CRT_DT || '').replace(/\//g, '-') + '+09:00';
      const timeMs = new Date(timeStr).getTime();
      if (isNaN(timeMs) || Date.now() - timeMs > CONFIG.MS_NDMS) continue;

      sent.ndms.add(id);
      hasNew = true;

      const embed = new EmbedBuilder()
        .setTitle('📢 안전 안내 문자')
        .setDescription(truncate(e.MSG_CN, 4000));

      await broadcast({ embeds: [embed] });
    }

    if (hasNew) await saveStateSafe('ndms');
    stats.ndms.status = 'ok';
    return true;
  } catch {
    stats.ndms.status = 'error';
    return false;
  }
}

// NDMS LOOP
async function ndmsLoop() {
  const success = await fetchNDMS();
  setTimeout(ndmsLoop, success ? CONFIG.MS_NDMS : CONFIG.MS_FAIL);
}

// KMA LOOP
async function kmaLoop() {
  const success = await fetchKMA();
  setTimeout(kmaLoop, success ? CONFIG.MS_EQ : CONFIG.MS_FAIL);
}

// JMA LOOP
async function jmaLoop() {
  const success = await fetchJMA();
  setTimeout(jmaLoop, success ? CONFIG.MS_EQ : CONFIG.MS_FAIL);
}

/* =========================
   7. 실행
========================= */
client.once('ready', async () => {
  console.log(`[SYSTEM] Bot Online: ${client.user.tag}`);
  await initStorage();

  ndmsLoop();
  kmaLoop();
  jmaLoop();

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(APPLICATION_ID), {
      body: [
        { name: '상태', description: 'API 연결 상태 확인' },
        { name: '청소', description: '기록 캐시 초기화' }
      ]
    });
    console.log('[SYSTEM] Global commands registered.');
  } catch (err) {
    console.error('[SYSTEM] Command registration failed:', err);
  }
});

// 슬래시 명령어
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (OWNER_ID && i.user.id !== OWNER_ID)
    return i.reply({ content: '권한 없음', ephemeral: true });

  if (i.commandName === '상태') {
    const embed = new EmbedBuilder()
      .setTitle('📊 상태')
      .addFields(
        { name: 'KMA', value: stats.kma.status },
        { name: 'JMA', value: stats.jma.status },
        { name: 'NDMS', value: stats.ndms.status }
      );
    await i.reply({ embeds: [embed] });
  }

  if (i.commandName === '청소') {
    sent.kma.clear();
    sent.jma.clear();
    sent.ndms.clear();
    await Promise.all([
      saveStateSafe('kma'),
      saveStateSafe('jma'),
      saveStateSafe('ndms')
    ]);
    await i.reply('초기화 완료');
  }
});

/* =========================
   8. 종료
========================= */
async function shutdown() {
  await Promise.all([
    saveStateSafe('kma'),
    saveStateSafe('jma'),
    saveStateSafe('ndms')
  ]);
  client.destroy();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 로그인
async function startBot() {
  try {
    await client.login(DISCORD_TOKEN);
    console.log('[LOGIN SUCCESS]');
  } catch (err) {
    console.error('[LOGIN ERROR FULL]', err);
  }
}

startBot();