require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const xml2js = require('xml2js');

/* ===============================
   ENV
================================ */
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN || !OWNER_ID) {
  console.error('[ENV] Missing DISCORD_TOKEN or OWNER_ID');
  process.exit(1);
}

/* ===============================
   CLIENT
================================ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ===============================
   STATE
================================ */
let running = true;
let lastDisasterId = null;
let lastEarthquakeTime = null;

/* ===============================
   UTIL
================================ */
const isOwner = (id) => id === OWNER_ID;

async function sendToAllGuilds(embed) {
  for (const guild of client.guilds.cache.values()) {
    const channel =
      guild.systemChannel ||
      guild.channels.cache.find(
        c =>
          c.isTextBased() &&
          c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
      );
    if (!channel) continue;
    try {
      await channel.send({ embeds: [embed] });
    } catch {}
  }
}

/* ===============================
   SAFEKOREA RSS (5분)
   UA 필수
================================ */
async function fetchDisasterRSS() {
  if (!running) return;

  try {
    const res = await axios.get(
      'https://www.safekorea.go.kr/idsiSFK/neo/rss/neo_rss.xml',
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/xml,text/xml'
        }
      }
    );

    const parsed = await xml2js.parseStringPromise(res.data);
    const items = parsed?.rss?.channel?.[0]?.item;
    if (!items || items.length === 0) return;

    const latest = items[0];
    const guid = latest.guid?.[0];
    if (!guid || guid === lastDisasterId) return;
    lastDisasterId = guid;

    const title = latest.title?.[0] || '재난문자';
    const desc = latest.description?.[0] || '';
    const pubDate = latest.pubDate?.[0] || '';

    const embed = new EmbedBuilder()
      .setTitle('📢 재난문자')
      .setDescription(desc)
      .addFields(
        { name: '제목', value: title },
        { name: '발표 시각', value: pubDate }
      )
      .setColor(0xff0000)
      .setTimestamp();

    await sendToAllGuilds(embed);
  } catch (err) {
    console.error('[RSS ERROR]', err.message);
  }
}

/* ===============================
   KMA EARTHQUAKE JSON (1분)
================================ */
async function fetchEarthquake() {
  if (!running) return;

  try {
    const res = await axios.get(
      'https://www.weather.go.kr/w/eqk-vol/search/korea.json',
      { timeout: 10000 }
    );

    const body = res?.data?.body;
    if (!body || body.length === 0) return;

    const latest = body[0];
    const time = latest.tmFc;
    if (!time || time === lastEarthquakeTime) return;
    lastEarthquakeTime = time;

    const mag = parseFloat(latest.mag);
    const loc = latest.loc || '알 수 없음';

    const embed = new EmbedBuilder()
      .setTitle('🌏 지진 발생')
      .setDescription(`위치: ${loc}\n규모: **${mag}**`)
      .setColor(mag >= 4 ? 0xff0000 : 0xffff00)
      .setTimestamp();

    await sendToAllGuilds(embed);
  } catch (err) {
    console.error('[EQ ERROR]', err.message);
  }
}

/* ===============================
   COMMANDS (OWNER ONLY)
================================ */
client.on('messageCreate', async (msg) => {
  if (!msg.guild) return;
  if (!isOwner(msg.author.id)) return;

  if (msg.content === '!청소') {
    const messages = await msg.channel.messages.fetch({ limit: 100 });
    await msg.channel.bulkDelete(messages, true);
    await msg.channel.send('🧹 청소 완료');
  }

  if (msg.content === '!stop') {
    running = false;
    await msg.channel.send('⛔ 시스템 중지');
  }

  if (msg.content === '!start') {
    running = true;
    await msg.channel.send('✅ 시스템 재개');
  }
});

/* ===============================
   READY
================================ */
client.once('ready', () => {
  console.log(`봇 로그인 완료: ${client.user.tag}`);

  fetchDisasterRSS();
  fetchEarthquake();

  setInterval(fetchDisasterRSS, 5 * 60 * 1000);
  setInterval(fetchEarthquake, 60 * 1000);
});

client.login(TOKEN);