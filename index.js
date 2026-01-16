/*************************************************
 * Earthquake & Disaster Alert Discord Bot
 * FINAL PRODUCTION VERSION
 * - KMA (Korea)
 * - JMA (Japan)
 * - Emergency Disaster Message (MOIS)
 * - Render Free compatible
 *************************************************/

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');

/* =========================
   ENV
========================= */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const APPLICATION_ID = process.env.APPLICATION_ID;
const DISASTER_KEY = process.env.DISASTER_API_KEY;

/* =========================
   EXPRESS (PORT BINDING)
========================= */
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT);

/* =========================
   API ENDPOINTS
========================= */
const KMA_URL =
  'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg' +
  '?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40' +
  '&numOfRows=10&pageNo=1&dataType=JSON';

const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';

const DISASTER_URL =
  'https://apis.data.go.kr/1741000/DisasterMsg2/getDisasterMsgList' +
  '?numOfRows=10&pageNo=1&type=json';

/* =========================
   GLOBAL STATE
========================= */
const state = {
  running: true,
  kma: { ok: false, fail: 0 },
  jma: { ok: false, fail: 0 },
  disaster: { ok: false, fail: 0 },
  sent: {
    kma: new Set(),
    jma: new Set(),
    disaster: new Set()
  }
};

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =========================
   TIME (KST SAFE)
========================= */
function kst(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600000);
}
function ymd(d = new Date()) {
  return kst(d).toISOString().slice(0, 10).replace(/-/g, '');
}
function daysAgo(n) {
  return ymd(new Date(Date.now() - n * 86400000));
}

/* =========================
   SAFE HTTP
========================= */
async function safeGet(url, params = {}) {
  try {
    const res = await axios.get(url, { params, timeout: 5000 });
    return res.data;
  } catch {
    return null;
  }
}

/* =========================
   FETCH: KMA
========================= */
async function fetchKMA() {
  const data = await safeGet(KMA_URL, {
    fromTmFc: daysAgo(3),
    toTmFc: ymd()
  });

  const items = data?.response?.body?.items?.item;
  if (!Array.isArray(items)) {
    state.kma.ok = false;
    state.kma.fail++;
    return [];
  }
  state.kma.ok = true;
  return items;
}

/* =========================
   FETCH: JMA
========================= */
async function fetchJMA() {
  const data = await safeGet(JMA_URL);
  if (!Array.isArray(data)) {
    state.jma.ok = false;
    state.jma.fail++;
    return [];
  }
  state.jma.ok = true;
  return data;
}

/* =========================
   FETCH: DISASTER MSG
========================= */
async function fetchDisaster() {
  const data = await safeGet(DISASTER_URL, {
    serviceKey: DISASTER_KEY
  });

  const items = data?.DisasterMsg?.[1]?.row;
  if (!Array.isArray(items)) {
    state.disaster.ok = false;
    state.disaster.fail++;
    return [];
  }
  state.disaster.ok = true;
  return items;
}

/* =========================
   DISCORD SEND
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
      .setTitle('지진 정보')
      .setDescription(
        `📍 ${e.loc}\n🕒 ${e.tmEqk}\n📏 규모 ${mag}\n${e.rem || ''}`
      )
      .setFooter({ text: '출처: 기상청(KMA)' });

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
      .setTitle('일본 지진 감지')
      .setDescription(
        `📍 ${e.place || '일본 인근'}\n🕒 ${e.time}\n📏 규모 ${e.mag}`
      )
      .setFooter({ text: '출처: 일본기상청(JMA)' });

    await send(embed, false);
  }
}

/* =========================
   HANDLE DISASTER
========================= */
async function handleDisaster() {
  for (const e of await fetchDisaster()) {
    if (!e.md101_sn || state.sent.disaster.has(e.md101_sn)) continue;
    state.sent.disaster.add(e.md101_sn);

    const embed = new EmbedBuilder()
      .setTitle('긴급재난문자')
      .setDescription(
        `📍 ${e.location_name}\n🕒 ${e.create_date}\n\n${e.msg}`
      )
      .setFooter({ text: '출처: 행정안전부' });

    await send(embed, true);
  }
}

/* =========================
   SCHEDULER (1 MIN)
========================= */
setInterval(async () => {
  if (!state.running) return;
  await handleKMA();
  await handleJMA();
  await handleDisaster();
}, 60_000);

/* =========================
   SLASH COMMANDS (GLOBAL)
========================= */
const commands = [
  { name: 'stop', description: '봇 즉시 종료' },
  { name: '청소', description: '모든 캐시 초기화' },
  { name: '실시간정보', description: '시스템 상태 확인' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationCommands(APPLICATION_ID),
      { body: commands }
    );
  } catch {}
})();

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'stop') {
    await i.reply('봇 종료');
    process.exit(0);
  }

  if (i.commandName === '청소') {
    Object.values(state.sent).forEach(s => s.clear());
    await i.reply('캐시 초기화 완료');
  }

  if (i.commandName === '실시간정보') {
    const embed = new EmbedBuilder()
      .setTitle('실시간 상태')
      .setDescription(
        `KMA ${state.kma.ok ? '🟢' : '🔴'} (fail ${state.kma.fail})\n` +
        `JMA ${state.jma.ok ? '🟢' : '🔴'} (fail ${state.jma.fail})\n` +
        `재난문자 ${state.disaster.ok ? '🟢' : '🔴'} (fail ${state.disaster.fail})`
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