/*************************************************
 * Earthquake Alert Discord Bot
 * FINAL STABLE + SLASH COMMANDS
 * KMA (Korea) + JMA (Japan)
 *************************************************/

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes
} = require('discord.js');
const axios = require('axios');

/* ===============================
   ENV
================================ */
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const KMA_KEY = process.env.KMA_API_KEY;

if (!TOKEN || !OWNER_ID || !KMA_KEY) {
  console.error('[ENV] Missing required environment variable');
  process.exit(1);
}

/* ===============================
   CLIENT
================================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* ===============================
   STATE
================================ */
let running = true;
const sent = {
  kma: new Set(),
  jma: new Set()
};

/* ===============================
   TIME UTIL (KST)
================================ */
function ymd(daysAgo = 0) {
  const d = new Date(Date.now() + 9 * 3600000 - daysAgo * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/* ===============================
   SAFE GET
================================ */
async function safeGet(url, params = {}) {
  try {
    const res = await axios.get(url, {
      params,
      timeout: 8000
    });
    return res.data;
  } catch {
    return null;
  }
}

/* ===============================
   KMA FETCH
================================ */
async function fetchKMA() {
  const data = await safeGet(
    'https://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg',
    {
      serviceKey: KMA_KEY,
      numOfRows: 5,
      pageNo: 1,
      dataType: 'JSON',
      fromTmFc: ymd(3),
      toTmFc: ymd(0)
    }
  );

  return data?.response?.body?.items?.item ?? [];
}

/* ===============================
   JMA FETCH
================================ */
async function fetchJMA() {
  const data = await safeGet(
    'https://www.jma.go.jp/bosai/quake/data/list.json'
  );
  if (!Array.isArray(data)) return [];

  const now = Date.now();
  return data.filter(e => {
    const t = new Date(e.time).getTime();
    return t && now - t < 10 * 60 * 1000;
  });
}

/* ===============================
   BROADCAST
================================ */
async function broadcast(embed, everyone = false) {
  for (const guild of client.guilds.cache.values()) {
    const channel =
      guild.systemChannel ||
      guild.channels.cache.find(c => c.isTextBased());

    if (!channel) continue;

    try {
      await channel.send({
        content: everyone ? '@everyone' : undefined,
        embeds: [embed]
      });
    } catch {}
  }
}

/* ===============================
   HANDLE KMA
================================ */
async function handleKMA() {
  for (const e of await fetchKMA()) {
    if (!e.eqkNo || sent.kma.has(e.eqkNo)) continue;
    sent.kma.add(e.eqkNo);

    const mag = Number(e.mag || 0);
    const everyone = mag >= 4.0;

    const embed = new EmbedBuilder()
      .setTitle('🇰🇷 국내 지진 발생')
      .setDescription(
        `📍 위치: ${e.loc}\n🕒 시각: ${e.tmEqk}\n📏 규모: **${mag}**`
      )
      .setFooter({ text: '기상청(KMA)' })
      .setTimestamp();

    await broadcast(embed, everyone);
  }
}

/* ===============================
   HANDLE JMA
================================ */
async function handleJMA() {
  for (const e of await fetchJMA()) {
    const id = `${e.time}_${e.lat}_${e.lon}`;
    if (sent.jma.has(id)) continue;
    sent.jma.add(id);

    const scale = Number(e.maxScale || 0);
    const everyone = scale >= 55; // 진도 5+

    const embed = new EmbedBuilder()
      .setTitle('🇯🇵 일본 지진 감지')
      .setDescription(
        `📍 위치: ${e.place || '일본 인근'}\n🕒 시각: ${e.time}\n📏 규모: ${e.mag}\n📊 최대진도: ${scale}`
      )
      .setFooter({ text: '일본기상청(JMA)' })
      .setTimestamp();

    await broadcast(embed, everyone);
  }
}

/* ===============================
   SCHEDULER (1 MIN)
================================ */
setInterval(async () => {
  if (!running) return;
  await handleKMA();
  await handleJMA();
}, 60_000);

/* ===============================
   SLASH COMMANDS
================================ */
const commands = [
  { name: 'status', description: '지진 감시 상태 확인' },
  { name: 'stop', description: '지진 감시 중지 (관리자)' },
  { name: 'start', description: '지진 감시 재개 (관리자)' },
  { name: 'clear', description: '지진 캐시 초기화 (관리자)' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationCommands(client.application?.id || '@me'),
      { body: commands }
    );
  } catch {}
})();

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'status') {
    await i.reply(
      `상태: ${running ? '🟢 작동중' : '🔴 중지됨'}\nKMA 캐시: ${sent.kma.size}\nJMA 캐시: ${sent.jma.size}`
    );
  }

  if (i.user.id !== OWNER_ID) {
    await i.reply({ content: '권한 없음', ephemeral: true });
    return;
  }

  if (i.commandName === 'stop') {
    running = false;
    await i.reply('⛔ 지진 감시 중지');
  }

  if (i.commandName === 'start') {
    running = true;
    await i.reply('✅ 지진 감시 재개');
  }

  if (i.commandName === 'clear') {
    sent.kma.clear();
    sent.jma.clear();
    await i.reply('🧹 캐시 초기화 완료');
  }
});

/* ===============================
   READY
================================ */
client.once('ready', () => {
  console.log(`지진봇 온라인: ${client.user.tag}`);
});

client.login(TOKEN);