/************************************************************
 * Earthquake & Disaster Unified Alert Bot
 * ULTRA FINAL PRODUCTION BUILD
 *
 * Data Sources
 *  - KMA  : Korea Meteorological Administration (Earthquake)
 *  - JMA  : Japan Meteorological Agency (Earthquake)
 *  - MOIS : Ministry of Interior and Safety (Disaster Message)
 *
 * Design Goals
 *  - Zero crash (process never dies)
 *  - 1-minute polling fixed
 *  - Duplicate suppression (strong)
 *  - Render Free port binding
 *  - Global slash commands
 *  - Single-owner control
 *  - Instant stop (<1s)
 *  - Cache cleanup command
 *  - Real-time health monitor
 ************************************************************/

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes
} = require('discord.js');

const axios = require('axios');
const express = require('express');

/* =========================================================
   ENV VALIDATION (FAIL FAST)
========================================================= */
const ENV = {
  TOKEN: process.env.TOKEN,
  APP_ID: process.env.APPLICATION_ID,
  CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
  OWNER_ID: process.env.OWNER_ID,
  DISASTER_KEY: process.env.DISASTER_API_KEY,
  PORT: process.env.PORT || 3000
};

for (const [k, v] of Object.entries(ENV)) {
  if (!v) {
    console.error(`[ENV] Missing ${k}`);
    process.exit(1);
  }
}

/* =========================================================
   EXPRESS (RENDER KEEP-ALIVE)
========================================================= */
const app = express();
app.get('/', (_, res) => res.status(200).send('BOT ALIVE'));
app.listen(ENV.PORT);

/* =========================================================
   DISCORD CLIENT
========================================================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =========================================================
   GLOBAL STATE (HARD ISOLATED)
========================================================= */
const STATE = {
  running: true,

  health: {
    kma: { ok: false, fail: 0 },
    jma: { ok: false, fail: 0 },
    disaster: { ok: false, fail: 0 }
  },

  cache: {
    kma: new Set(),
    jma: new Set(),
    disaster: new Set()
  }
};

/* =========================================================
   TIME UTIL (KST FIXED)
========================================================= */
const KST_OFFSET = 9 * 60 * 60 * 1000;

const nowKST = () => new Date(Date.now() + KST_OFFSET);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const daysAgo = n => ymd(new Date(Date.now() - n * 86400000 + KST_OFFSET));

/* =========================================================
   SAFE HTTP WRAPPER
========================================================= */
async function safeGET(url, params = {}) {
  try {
    const res = await axios.get(url, {
      params,
      timeout: 7000,
      validateStatus: s => s === 200
    });
    return res.data;
  } catch {
    return null;
  }
}

/* =========================================================
   API ENDPOINTS
========================================================= */
const API = {
  KMA:
    'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg' +
    '?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40' +
    '&numOfRows=20&pageNo=1&dataType=JSON',

  JMA: 'https://www.jma.go.jp/bosai/quake/data/list.json',

  DISASTER:
    'https://apis.data.go.kr/1741000/DisasterMsg2/getDisasterMsgList'
};

/* =========================================================
   DISCORD SEND CORE
========================================================= */
async function sendEmbed(embed, everyone = false) {
  try {
    const ch = await client.channels.fetch(ENV.CHANNEL_ID);
    await ch.send({
      content: everyone ? '@everyone' : undefined,
      embeds: [embed]
    });
  } catch {}
}

/* =========================================================
   FETCH KMA
========================================================= */
async function fetchKMA() {
  const data = await safeGET(API.KMA, {
    fromTmFc: daysAgo(3),
    toTmFc: ymd(nowKST())
  });

  const items = data?.response?.body?.items?.item;
  if (!Array.isArray(items)) {
    STATE.health.kma.fail++;
    STATE.health.kma.ok = false;
    return [];
  }

  STATE.health.kma.ok = true;
  return items;
}

/* =========================================================
   FETCH JMA
========================================================= */
async function fetchJMA() {
  const data = await safeGET(API.JMA);
  if (!Array.isArray(data)) {
    STATE.health.jma.fail++;
    STATE.health.jma.ok = false;
    return [];
  }

  STATE.health.jma.ok = true;
  return data;
}

/* =========================================================
   FETCH DISASTER
========================================================= */
async function fetchDisaster() {
  const data = await safeGET(API.DISASTER, {
    serviceKey: ENV.DISASTER_KEY,
    numOfRows: 20,
    pageNo: 1,
    type: 'json'
  });

  const items = data?.DisasterMsg?.[1]?.row;
  if (!Array.isArray(items)) {
    STATE.health.disaster.fail++;
    STATE.health.disaster.ok = false;
    return [];
  }

  STATE.health.disaster.ok = true;
  return items;
}

/* =========================================================
   HANDLE KMA
========================================================= */
async function handleKMA() {
  for (const e of await fetchKMA()) {
    if (!e.eqkNo || STATE.cache.kma.has(e.eqkNo)) continue;
    STATE.cache.kma.add(e.eqkNo);

    const mag = Number(e.mag || 0);
    const embed = new EmbedBuilder()
      .setTitle('🇰🇷 국내 지진 정보')
      .setDescription(
        `📍 ${e.loc}\n🕒 ${e.tmEqk}\n📏 규모 ${mag}\n${e.rem || ''}`
      )
      .setFooter({ text: 'KMA' });

    await sendEmbed(embed, mag >= 4.0);
  }
}

/* =========================================================
   HANDLE JMA
========================================================= */
async function handleJMA() {
  const now = Date.now();
  for (const e of await fetchJMA()) {
    const t = new Date(e.time).getTime();
    if (!t || now - t > 10 * 60 * 1000) continue;

    const id = `${e.time}_${e.lat}_${e.lon}`;
    if (STATE.cache.jma.has(id)) continue;
    STATE.cache.jma.add(id);

    const embed = new EmbedBuilder()
      .setTitle('🇯🇵 일본 지진 감지')
      .setDescription(
        `📍 ${e.place || 'Japan'}\n🕒 ${e.time}\n📏 규모 ${e.mag}`
      )
      .setFooter({ text: 'JMA' });

    await sendEmbed(embed, false);
  }
}

/* =========================================================
   HANDLE DISASTER (NATION MERGED)
========================================================= */
async function handleDisaster() {
  for (const e of await fetchDisaster()) {
    if (!e.md101_sn || STATE.cache.disaster.has(e.md101_sn)) continue;
    STATE.cache.disaster.add(e.md101_sn);

    const embed = new EmbedBuilder()
      .setTitle('🚨 긴급 재난문자')
      .setDescription(
        `📍 ${e.location_name}\n🕒 ${e.create_date}\n\n${e.msg}`
      )
      .setFooter({ text: '행정안전부' });

    await sendEmbed(embed, true);
  }
}

/* =========================================================
   SCHEDULER (EXACT 1 MIN)
========================================================= */
setInterval(async () => {
  if (!STATE.running) return;
  await handleKMA();
  await handleJMA();
  await handleDisaster();
}, 60_000);

/* =========================================================
   SLASH COMMANDS (GLOBAL)
========================================================= */
const commands = [
  { name: 'stop', description: '봇 즉시 종료' },
  { name: '청소', description: '모든 캐시 초기화' },
  { name: '실시간정보', description: 'API 상태 확인' }
];

const rest = new REST({ version: '10' }).setToken(ENV.TOKEN);
rest.put(Routes.applicationCommands(ENV.APP_ID), { body: commands }).catch(() => {});

/* =========================================================
   INTERACTION HANDLER
========================================================= */
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (i.user.id !== ENV.OWNER_ID) {
    return i.reply({ content: '권한 없음', ephemeral: true });
  }

  if (i.commandName === 'stop') {
    STATE.running = false;
    await i.reply('봇 종료');
    process.exit(0);
  }

  if (i.commandName === '청소') {
    Object.values(STATE.cache).forEach(s => s.clear());
    await i.reply('모든 캐시 초기화 완료');
  }

  if (i.commandName === '실시간정보') {
    const embed = new EmbedBuilder()
      .setTitle('실시간 상태')
      .setDescription(
        `KMA ${STATE.health.kma.ok ? '🟢' : '🔴'} (${STATE.health.kma.fail})\n` +
        `JMA ${STATE.health.jma.ok ? '🟢' : '🔴'} (${STATE.health.jma.fail})\n` +
        `재난문자 ${STATE.health.disaster.ok ? '🟢' : '🔴'} (${STATE.health.disaster.fail})`
      );
    await i.reply({ embeds: [embed] });
  }
});

/* =========================================================
   SAFETY NET (ABSOLUTE)
========================================================= */
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

/* =========================================================
   LOGIN
========================================================= */
client.login(ENV.TOKEN);