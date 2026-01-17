/*************************************************
 * Earthquake & Disaster Alert Discord Bot
 * FINAL STABLE VERSION
 * - KMA (Korea Earthquake)
 * - JMA (Japan Earthquake)
 * - MOIS Disaster RSS (SafeKorea)
 * - Render Free compatible
 * - 5 minute interval
 *************************************************/

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');

/* =========================
   ENV VALIDATION
========================= */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const APPLICATION_ID = process.env.APPLICATION_ID;

if (!TOKEN || !CHANNEL_ID || !APPLICATION_ID) {
  console.error('[ENV] Missing required environment variable');
  process.exit(1);
}

/* =========================
   EXPRESS (PORT BIND)
========================= */
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('WEB OK', PORT));

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
  'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg' +
  '?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40' +
  '&numOfRows=10&pageNo=1&dataType=JSON';

const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';

const MOIS_RSS = 'https://www.safekorea.go.kr/idsiSFK/neo/rss/neo_rss.xml';

/* =========================
   GLOBAL STATE
========================= */
const state = {
  running: true,
  sent: {
    kma: new Set(),
    jma: new Set(),
    disaster: new Set()
  },
  status: {
    kma: false,
    jma: false,
    disaster: false
  }
};

/* =========================
   TIME UTIL
========================= */
function kstNow() {
  return new Date(Date.now() + 9 * 3600000);
}
function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function daysAgo(n) {
  return ymd(new Date(Date.now() - n * 86400000));
}

/* =========================
   SAFE HTTP
========================= */
async function safeGet(url, opts = {}) {
  try {
    const r = await axios.get(url, { timeout: 8000, ...opts });
    return r.data;
  } catch (e) {
    return null;
  }
}

/* =========================
   DISCORD SEND
========================= */
async function sendEmbed(embed, everyone = false) {
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    await ch.send({
      content: everyone ? '@everyone' : undefined,
      embeds: [embed]
    });
  } catch (e) {
    console.error('SEND FAIL', e.message);
  }
}

/* =========================
   KMA EARTHQUAKE
========================= */
async function handleKMA() {
  const data = await safeGet(KMA_URL, {
    params: {
      fromTmFc: daysAgo(3),
      toTmFc: ymd()
    }
  });

  const items = data?.response?.body?.items?.item;
  if (!Array.isArray(items)) {
    state.status.kma = false;
    return;
  }
  state.status.kma = true;

  for (const e of items) {
    if (!e.eqkNo || state.sent.kma.has(e.eqkNo)) continue;
    state.sent.kma.add(e.eqkNo);

    const mag = Number(e.mag || 0);

    const embed = new EmbedBuilder()
      .setTitle('지진 정보 (대한민국)')
      .setDescription(
        `📍 위치: ${e.loc}\n` +
        `🕒 발생시각: ${e.tmEqk}\n` +
        `📏 규모: ${mag}\n` +
        `${e.rem || ''}`
      )
      .setFooter({ text: '기상청 KMA' });

    await sendEmbed(embed, mag >= 4.0);
  }
}

/* =========================
   JMA EARTHQUAKE
========================= */
async function handleJMA() {
  const list = await safeGet(JMA_URL);
  if (!Array.isArray(list)) {
    state.status.jma = false;
    return;
  }
  state.status.jma = true;

  const now = Date.now();

  for (const e of list) {
    const t = new Date(e.time).getTime();
    if (!t || now - t > 15 * 60 * 1000) continue;

    const id = `${e.time}_${e.lat}_${e.lon}`;
    if (state.sent.jma.has(id)) continue;
    state.sent.jma.add(id);

    const embed = new EmbedBuilder()
      .setTitle('일본 지진 감지')
      .setDescription(
        `📍 ${e.place || '일본 인근'}\n` +
        `🕒 ${e.time}\n` +
        `📏 규모 ${e.mag}`
      )
      .setFooter({ text: 'JMA' });

    await sendEmbed(embed, false);
  }
}

/* =========================
   MOIS RSS PARSER
========================= */
function parseRSS(xml) {
  const items = [];
  const blocks = xml.split('<item>').slice(1);
  for (const b of blocks) {
    const title = (b.match(/<title>(.*?)<\/title>/) || [])[1];
    const desc = (b.match(/<description>(.*?)<\/description>/) || [])[1];
    const guid = (b.match(/<guid>(.*?)<\/guid>/) || [])[1];
    if (guid) items.push({ title, desc, guid });
  }
  return items;
}

async function handleDisaster() {
  const xml = await safeGet(MOIS_RSS);
  if (typeof xml !== 'string') {
    state.status.disaster = false;
    return;
  }
  state.status.disaster = true;

  const list = parseRSS(xml);

  for (const e of list) {
    if (state.sent.disaster.has(e.guid)) continue;
    state.sent.disaster.add(e.guid);

    const embed = new EmbedBuilder()
      .setTitle('재난·안전 안내')
      .setDescription(e.desc || e.title)
      .setFooter({ text: '행정안전부 SafeKorea' });

    await sendEmbed(embed, true);
  }
}

/* =========================
   SCHEDULER (5 MIN)
========================= */
setInterval(async () => {
  if (!state.running) return;
  await handleKMA();
  await handleJMA();
  await handleDisaster();
}, 5 * 60 * 1000);

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  { name: 'stop', description: '봇 즉시 종료' },
  { name: '청소', description: '캐시 초기화' },
  { name: '실시간정보', description: 'API 상태 확인' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(APPLICATION_ID),
    { body: commands }
  );
  console.log('Slash command registered');
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
        `KMA ${state.status.kma ? '🟢' : '🔴'}\n` +
        `JMA ${state.status.jma ? '🟢' : '🔴'}\n` +
        `재난문자 ${state.status.disaster ? '🟢' : '🔴'}`
      );
    await i.reply({ embeds: [embed] });
  }
});

/* =========================
   READY & ERROR
========================= */
client.once('ready', () => {
  console.log('DISCORD LOGIN OK', client.user.tag);
});

process.on('unhandledRejection', e => console.error(e));
process.on('uncaughtException', e => console.error(e));

client.login(TOKEN);