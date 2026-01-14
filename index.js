require('dotenv').config();
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');

/* ===== ENV ===== */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const APPLICATION_ID = process.env.APPLICATION_ID;
const RENDER_URL = process.env.RENDER_URL;

/* ===== API ===== */
const KMA_SERVICE_KEY = '24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40';
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';

/* ===== CLIENT ===== */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ===== STATE ===== */
const sentKMA = new Set();
const sentJMA = new Set();
let running = true;
let lastLoop = null;

/* ===== UTIL ===== */
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,'');

/* ===== KMA ===== */
function kmaUrl() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 3);

  return (
    'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg'
    + `?serviceKey=${KMA_SERVICE_KEY}`
    + '&numOfRows=10&pageNo=1'
    + `&fromTmFc=${ymd(from)}`
    + `&toTmFc=${ymd(now)}`
    + '&dataType=JSON'
  );
}

async function fetchKMA() {
  try {
    const r = await axios.get(kmaUrl(), { timeout: 10000 });
    if (String(r.data?.response?.header?.resultCode) !== '0') return [];
    const items = r.data.response.body.items?.item;
    return items ? (Array.isArray(items) ? items : [items]) : [];
  } catch (e) {
    console.error('[KMA ERROR]', e.message);
    return [];
  }
}

/* ===== JMA ===== */
async function fetchJMA() {
  try {
    const r = await axios.get(JMA_URL, { timeout: 10000 });
    return r.data || [];
  } catch (e) {
    console.error('[JMA ERROR]', e.message);
    return [];
  }
}

/* ===== MAIN LOOP (1분) ===== */
async function loop() {
  if (!running) return;
  lastLoop = Date.now();

  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch {
    console.error('[CHANNEL FETCH FAILED]');
    return;
  }

  /* ---- KMA ---- */
  for (const q of await fetchKMA()) {
    if (!q.eqkNo || sentKMA.has(q.eqkNo)) continue;
    sentKMA.add(q.eqkNo);

    const mag = Number(q.mag || 0);
    const mention = mag >= 4 ? '@everyone ' : '';

    const embed = new EmbedBuilder()
      .setTitle('🇰🇷 지진 발생')
      .setDescription(
        `📍 **위치**\n${q.loc || '정보없음'}\n\n` +
        `📏 **규모**\nM${q.mag ?? '정보없음'}\n\n` +
        `📐 **깊이**\n${q.dep ?? '정보없음'} km\n\n` +
        `🟦 **최대진도**\n${q.maxInt ?? '정보없음'}`
      )
      .setFooter({ text: '출처: 기상청(KMA)' })
      .setTimestamp();

    try {
      await channel.send({ content: mention, embeds: [embed] });
    } catch (e) {
      console.error('[DISCORD SEND ERROR]', e.message);
    }
  }

  /* ---- JMA ---- */
  for (const q of (await fetchJMA()).slice(0, 5)) {
    if (!q.time || !q.lat || !q.lon) continue;
    const id = `${q.time}_${q.lat}_${q.lon}`;
    if (sentJMA.has(id)) continue;

    const t = new Date(q.time).getTime();
    if (Date.now() - t > 10 * 60 * 1000) continue;
    sentJMA.add(id);

    const embed = new EmbedBuilder()
      .setTitle('🇯🇵 지진 발생')
      .setDescription(
        `${q.time}\n\n` +
        `📍 **위치**\n${q.place || '정보없음'}\n\n` +
        `📏 **규모**\nM${q.mag ?? '정보없음'}\n\n` +
        `📐 **깊이**\n${q.depth ?? '정보없음'} km\n\n` +
        `🟦 **최대진도**\n${q.maxInt ?? '정보없음'}`
      )
      .setFooter({ text: '출처: 일본기상청(JMA)' })
      .setTimestamp();

    try {
      await channel.send({ embeds: [embed] });
    } catch (e) {
      console.error('[DISCORD SEND ERROR]', e.message);
    }
  }
}

/* ===== PINGER ===== */
if (RENDER_URL) {
  setInterval(() => {
    axios.get(RENDER_URL).catch(() => {});
  }, 60_000);
}

/* ===== SLASH COMMANDS ===== */
const commands = [
  { name: 'stop', description: '봇 중지' },
  { name: '실시간정보', description: '봇 상태 확인' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

/* ===== READY ===== */
client.once('ready', async () => {
  try {
    await rest.put(
      Routes.applicationCommands(APPLICATION_ID),
      { body: commands }
    );
  } catch (e) {
    console.error('[COMMAND REGISTER ERROR]', e.message);
  }

  setInterval(loop, 60_000);
  console.log('지진봇 정상 가동');
});

/* ===== INTERACTION ===== */
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === 'stop') {
      running = false;
      await i.reply('봇 중지됨');
      process.exit(0);
    }

    if (i.commandName === '실시간정보') {
      const e = new EmbedBuilder()
        .setTitle('📡 실시간 상태')
        .addFields(
          { name: '상태', value: running ? '작동 중' : '중지', inline: true },
          { name: '마지막 조회', value: lastLoop ? new Date(lastLoop).toLocaleString() : '없음', inline: true }
        )
        .setTimestamp();

      await i.reply({ embeds: [e], ephemeral: true });
    }
  } catch (e) {
    console.error('[INTERACTION ERROR]', e.message);
  }
});

/* ===== SAFETY NET (핵심) ===== */
client.on('error', err => {
  console.error('[DISCORD ERROR]', err.message);
});

process.on('unhandledRejection', err => {
  console.error('[UNHANDLED REJECTION]', err);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

/* ===== LOGIN ===== */
client.login(TOKEN);