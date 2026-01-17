require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const xml2js = require('xml2js');

/* =========================
   ENV CHECK
========================= */
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN || !OWNER_ID) {
  console.error('[ENV] Missing DISCORD_TOKEN or OWNER_ID');
  process.exit(1);
}

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* =========================
   GLOBAL STATE
========================= */
let running = true;
let lastDisasterId = null;
let lastEarthquakeTime = null;

/* =========================
   UTIL
========================= */
function isOwner(id) {
  return id === OWNER_ID;
}

async function sendToAllGuilds(embed) {
  for (const guild of client.guilds.cache.values()) {
    const channel =
      guild.systemChannel ||
      guild.channels.cache.find(
        c =>
          c.isTextBased() &&
          c.permissionsFor(guild.members.me)
            ?.has(PermissionsBitField.Flags.SendMessages)
      );
    if (!channel) continue;
    try {
      await channel.send({ embeds: [embed] });
    } catch {}
  }
}

/* =========================
   DISASTER JSON (PRIMARY)
========================= */
async function fetchDisasterJSON() {
  const urls = [
    'https://www.safekorea.go.kr/idsiSFK/neo/ext/json/disasterData.json',
    'https://www.safekorea.go.kr/idsiSFK/neo/ext/json/disasterMsgList.json'
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (DisasterBot)'
        }
      });

      const list =
        res.data?.disasterData ||
        res.data?.disasterMsg ||
        res.data?.row;

      if (!Array.isArray(list) || list.length === 0) continue;

      const latest = list[0];
      const id =
        latest.md101_sn ||
        latest.msg_sn ||
        latest.SN;

      if (id === lastDisasterId) return true;
      lastDisasterId = id;

      const embed = new EmbedBuilder()
        .setTitle('📢 재난문자')
        .setDescription(latest.msg_cn || latest.MSG_CN || '내용 없음')
        .setColor(0xff0000)
        .setTimestamp();

      await sendToAllGuilds(embed);
      return true;

    } catch (e) {
      console.error('[DISASTER JSON FAIL]', url, e.message);
    }
  }
  return false;
}

/* =========================
   DISASTER RSS (FALLBACK)
========================= */
async function fetchDisasterRSS() {
  try {
    const res = await axios.get(
      'https://www.safekorea.go.kr/idsiSFK/neo/rss/neo_rss.xml',
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    const parsed = await xml2js.parseStringPromise(res.data);
    const items = parsed?.rss?.channel?.[0]?.item;
    if (!items || items.length === 0) return;

    const latest = items[0];
    const guid = latest.guid?.[0];
    if (guid === lastDisasterId) return;
    lastDisasterId = guid;

    const embed = new EmbedBuilder()
      .setTitle('📢 재난문자 (RSS)')
      .setDescription(latest.description?.[0] || '')
      .setColor(0xff0000)
      .setTimestamp();

    await sendToAllGuilds(embed);

  } catch (e) {
    console.error('[RSS FAIL]', e.message);
  }
}

/* =========================
   EARTHQUAKE (KMA JSON)
========================= */
async function fetchEarthquake() {
  try {
    const res = await axios.get(
      'https://www.weather.go.kr/w/eqk-vol/search/korea.json',
      { timeout: 10000 }
    );

    const list = res.data?.body;
    if (!Array.isArray(list) || list.length === 0) return;

    const latest = list[0];
    if (latest.tmFc === lastEarthquakeTime) return;
    lastEarthquakeTime = latest.tmFc;

    const mag = Number(latest.mag);
    const embed = new EmbedBuilder()
      .setTitle('🌏 지진 발생')
      .setDescription(`위치: ${latest.loc}\n규모: **${mag}**`)
      .setColor(mag >= 4 ? 0xff0000 : 0xffff00)
      .setTimestamp();

    await sendToAllGuilds(embed);

  } catch (e) {
    console.error('[EQ FAIL]', e.message);
  }
}

/* =========================
   LOOP
========================= */
async function disasterLoop() {
  if (!running) return;
  const ok = await fetchDisasterJSON();
  if (!ok) await fetchDisasterRSS();
}

/* =========================
   COMMANDS
========================= */
client.on('messageCreate', async msg => {
  if (!msg.guild) return;
  if (!isOwner(msg.author.id)) return;

  if (msg.content === '!stop') {
    running = false;
    await msg.reply('⛔ 중지됨');
  }

  if (msg.content === '!start') {
    running = true;
    await msg.reply('✅ 재개됨');
  }

  if (msg.content === '!청소') {
    const msgs = await msg.channel.messages.fetch({ limit: 100 });
    await msg.channel.bulkDelete(msgs, true);
    await msg.channel.send('🧹 완료');
  }
});

/* =========================
   READY
========================= */
client.once('ready', () => {
  console.log(`ONLINE: ${client.user.tag}`);

  disasterLoop();
  fetchEarthquake();

  setInterval(disasterLoop, 5 * 60 * 1000);
  setInterval(fetchEarthquake, 60 * 1000);
});

client.login(TOKEN);