require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const xml2js = require('xml2js');

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN || !OWNER_ID) {
  console.error('[ENV] Missing required environment variable');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ===============================
   전역 상태
================================ */
let running = true;
let lastDisasterId = null;
let lastEarthquakeTime = null;

/* ===============================
   유틸
================================ */
function isOwner(userId) {
  return userId === OWNER_ID;
}

async function sendToAllGuilds(embed) {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.systemChannel
      || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages));
    if (!channel) continue;
    try {
      await channel.send({ embeds: [embed] });
    } catch {}
  }
}

/* ===============================
   재난문자 RSS (행안부 SafeKorea)
   5분 주기
================================ */
async function fetchDisasterRSS() {
  if (!running) return;

  try {
    const res = await axios.get(
      'https://www.safekorea.go.kr/idsiSFK/neo/rss/neo_rss.xml',
      { timeout: 10000 }
    );

    const parsed = await xml2js.parseStringPromise(res.data);
    const items = parsed.rss.channel[0].item;
    if (!items || items.length === 0) return;

    const latest = items[0];
    const guid = latest.guid[0];

    if (guid === lastDisasterId) return;
    lastDisasterId = guid;

    const title = latest.title[0];
    const desc = latest.description[0];
    const pubDate = latest.pubDate[0];

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
   지진 정보 (기상청 공개 JSON)
   1분 주기
================================ */
async function fetchEarthquake() {
  if (!running) return;

  try {
    const res = await axios.get(
      'https://www.weather.go.kr/w/eqk-vol/search/korea.json',
      { timeout: 10000 }
    );

    const data = res.data;
    if (!data || !data.body || data.body.length === 0) return;

    const latest = data.body[0];
    const time = latest.tmFc;

    if (time === lastEarthquakeTime) return;
    lastEarthquakeTime = time;

    const mag = parseFloat(latest.mag);
    const loc = latest.loc;

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
   명령어
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
   봇 준비
================================ */
client.once('ready', () => {
  console.log(`봇 로그인 완료: ${client.user.tag}`);

  // 즉시 실행
  fetchDisasterRSS();
  fetchEarthquake();

  // 주기 실행
  setInterval(fetchDisasterRSS, 5 * 60 * 1000);
  setInterval(fetchEarthquake, 60 * 1000);
});

client.login(TOKEN);