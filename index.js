/*************************************************
 * DISCORD EARTHQUAKE + DISASTER ALERT BOT
 * FINAL ABSOLUTE VERSION
 * - KMA (Korea Earthquake)
 * - JMA (Japan Earthquake)
 * - SafeKorea RSS (Disaster / Emergency Message)
 * - 5 minute polling
 * - No API Key required for disaster messages
 *************************************************/

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');
const xml2js = require('xml2js');

/* =========================
   ENV VALIDATION
========================= */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const APP_ID = process.env.APPLICATION_ID;

if (!TOKEN || !CHANNEL_ID || !APP_ID) {
  console.error('[ENV] Missing required variables');
  process.exit(1);
}

/* =========================
   EXPRESS KEEP-ALIVE
========================= */
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000);

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =========================
   API ENDPOINTS
========================= */
const KMA_URL =
  'https://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg' +
  '?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40' +
  '&numOfRows=10&pageNo=1&dataType=JSON';

const JMA_URL =
  'https://www.jma.go.jp/bosai/quake/data/list.json';

const SAFEKOREA_RSS =
  'https://www.safekorea.go.kr/idsiSFK/neo/rss/neo_rss.xml';

/* =========================
   GLOBAL STATE
========================= */
const state = {
  sent: {
    kma: new Set(),
    jma: new Set(),
    disaster: new Set()
  },
  status: {
    kma: true,
    jma: true,
    disaster: true
  }
};

/* =========================
   SAFE HTTP
========================= */
async function safeGet(url, type = 'json') {
  try {
    const res = await axios.get(url, { timeout: 7000 });
    return type === 'xml' ? res.data : res.data;
  } catch {
    return null;
  }
}

/* =========================
   FETCH KMA
========================= */
async function fetchKMA() {
  const data = await safeGet(KMA_URL);
  const items = data?.response?.body?.items?.item;
  if (!Array.isArray(items)) {
    state.status.kma = false;
    return [];
  }
  state.status.kma = true;
  return items;
}

/* =========================
   FETCH JMA
========================= */
async function fetchJMA() {
  const data = await safeGet(JMA_URL);
  if (!Array.isArray(data)) {
    state.status.jma = false;
    return [];
  }
  state.status.jma = true;
  return data;
}

/* =========================
   FETCH SAFEKOREA RSS
========================= */
async function fetchDisasterRSS() {
  const xml = await safeGet(SAFEKOREA_RSS, 'xml');
  if (!xml) {
    state.status.disaster = false;
    return [];
  }

  try {
    const parsed = await xml2js.parseStringPromise(xml);
    const items = parsed?.rss?.channel?.[0]?.item;
    if (!Array.isArray(items)) return [];
    state.status.disaster = true;
    return items;
  } catch {
    state.status.disaster = false;
    return [];
  }
}

/* =========================
   SEND MESSAGE
========================= */
async function send(embed, everyone = false) {
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    await ch.send({
      content: everyone ? '@everyone' : undefined,
      embeds: [embed]
    });
  } catch {}
}

/* =========================
   HANDLE KMA
========================= */
async function handleKMA() {
  for (const e of await fetchKMA()) {
    if (!e.eqkNo || state.sent.kma.has(e.eqkNo)) continue;
    state.sent.kma.add(e.eqkNo);

    const mag = Number(e.mag || 0);
    const embed = new EmbedBuilder()
      .setTitle('🇰🇷 국내 지진 정보')
      .setDescription(
        `📍 위치: ${e.loc}\n🕒 시각: ${e.tmEqk}\n📏 규모: ${mag}\n${e.rem || ''}`
      )
      .setFooter({ text: '기상청 KMA' });

    await send(embed, mag >= 4.0);
  }
}

/* =========================
   HANDLE JMA
========================= */
async function handleJMA() {
  const now = Date.now();
  for (const e of await fetchJMA()) {
    const t = new Date(e.time).getTime();
    if (!t || now - t > 10 * 60 * 1000) continue;

    const id = `${e.time}_${e.lat}_${e.lon}`;
    if (state.sent.jma.has(id)) continue;
    state.sent.jma.add(id);

    const embed = new EmbedBuilder()
      .setTitle('🇯🇵 일본 지진 정보')
      .setDescription(
        `📍 위치: ${e.place}\n🕒 시각: ${e.time}\n📏 규모: ${e.mag}`
      )
      .setFooter({ text: '일본기상청 JMA' });

    await send(embed, false);
  }
}

/* =========================
   HANDLE DISASTER RSS
========================= */
async function handleDisaster() {
  for (const e of await fetchDisasterRSS()) {
    const id = e.guid?.[0] || e.link?.[0];
    if (!id || state.sent.disaster.has(id)) continue;
    state.sent.disaster.add(id);

    const embed = new EmbedBuilder()
      .setTitle('📢 안전 · 재난 안내')
      .setDescription(
        `🕒 ${e.pubDate?.[0]}\n\n${e.description?.[0]}`
      )
      .setFooter({ text: 'SafeKorea 행정안전부' });

    await send(embed, true);
  }
}

/* =========================
   SCHEDULER (5 MIN)
========================= */
setInterval(async () => {
  await handleKMA();
  await handleJMA();
  await handleDisaster();
}, 300_000);

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  { name: '청소', description: '모든 캐시 초기화' },
  { name: '실시간정보', description: 'API 상태 확인' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
rest.put(Routes.applicationCommands(APP_ID), { body: commands });

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === '청소') {
    Object.values(state.sent).forEach(s => s.clear());
    await i.reply('캐시 초기화 완료');
  }

  if (i.commandName === '실시간정보') {
    const embed = new EmbedBuilder()
      .setTitle('시스템 상태')
      .setDescription(
        `KMA: ${state.status.kma ? '🟢' : '🔴'}\n` +
        `JMA: ${state.status.jma ? '🟢' : '🔴'}\n` +
        `재난문자: ${state.status.disaster ? '🟢' : '🔴'}`
      );
    await i.reply({ embeds: [embed] });
  }
});

/* =========================
   SAFETY
========================= */
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

client.login(TOKEN);