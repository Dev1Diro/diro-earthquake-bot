require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const axios = require('axios');

/* ===============================
   ENV
================================ */
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN || !OWNER_ID) {
  console.error('[ENV] Missing required environment variable');
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

/* ===============================
   재난문자 JSON (SafeKorea)
   5분 주기
================================ */
async function fetchDisasterJSON() {
  if (!running) return;

  try {
    const res = await axios.get(
      'https://www.safekorea.go.kr/idsiSFK/neo/ext/json/disasterData.json',
      { timeout: 10000 }
    );

    const list = res.data?.disasterData;
    if (!list || list.length === 0) return;

    const latest = list[0];
    const id = latest.md101_sn;

    if (id === lastDisasterId) return;
    lastDisasterId = id;

    const embed = new EmbedBuilder()
      .setTitle('📢 재난문자')
      .setDescription(latest.msg_cn)
      .addFields(
        { name: '지역', value: latest.rcptn_rgn_nm || '전국' },
        { name: '발표시각', value: latest.creat_dt }
      )
      .setColor(0xff0000)
      .setTimestamp();

    await sendToAllGuilds(embed);

  } catch (e) {
    console.error('[DISASTER JSON ERROR]', e.message);
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

    const list = res.data?.body;
    if (!list || list.length === 0) return;

    const latest = list[0];
    if (latest.tmFc === lastEarthquakeTime) return;
    lastEarthquakeTime = latest.tmFc;

    const mag = parseFloat(latest.mag);

    const embed = new EmbedBuilder()
      .setTitle('🌏 지진 발생')
      .setDescription(
        `위치: ${latest.loc}\n규모: **${mag}**`
      )
      .setColor(mag >= 4 ? 0xff0000 : 0xffff00)
      .setTimestamp();

    await sendToAllGuilds(embed);

  } catch (e) {
    console.error('[EARTHQUAKE ERROR]', e.message);
  }
}

/* ===============================
   COMMANDS
================================ */
client.on('messageCreate', async msg => {
  if (!msg.guild) return;
  if (!isOwner(msg.author.id)) return;

  if (msg.content === '!청소') {
    const msgs = await msg.channel.messages.fetch({ limit: 100 });
    await msg.channel.bulkDelete(msgs, true);
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
  console.log(`봇 온라인: ${client.user.tag}`);

  fetchDisasterJSON();
  fetchEarthquake();

  setInterval(fetchDisasterJSON, 5 * 60 * 1000);
  setInterval(fetchEarthquake, 60 * 1000);
});

client.login(TOKEN);