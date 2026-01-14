require('dotenv').config();
const axios = require('axios');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} = require('discord.js');

/* ===== ENV ===== */
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID || !CHANNEL_ID) {
  console.error('ENV 누락');
  process.exit(1);
}

/* ===== CLIENT ===== */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ===== STATE ===== */
let lastKMA = null;
let lastJMA = null;
let kmaFail = 0;
let jmaFail = 0;
let lastPing = Date.now();
let 장애알림보냄 = false;
let running = true;

/* ===== SLASH ===== */
const commands = [
  new SlashCommandBuilder().setName('stop').setDescription('봇 종료'),
  new SlashCommandBuilder().setName('실시간정보').setDescription('지진봇 상태')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

/* ===== UTIL ===== */
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

/* ===== KMA ===== */
function kmaUrl() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 3);

  return (
    'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg'
    + '?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40'
    + '&numOfRows=5&pageNo=1'
    + `&fromTmFc=${ymd(from)}`
    + `&toTmFc=${ymd(now)}`
    + '&dataType=JSON'
  );
}

async function fetchKMA() {
  try {
    const r = await axios.get(kmaUrl(), { timeout: 10000 });
    if (String(r.data?.response?.header?.resultCode) !== '0') throw 1;
    kmaFail = 0;
    const item = r.data.response.body.items?.item;
    return item ? (Array.isArray(item) ? item[0] : item) : null;
  } catch {
    kmaFail++;
    return null;
  }
}

/* ===== JMA ===== */
async function fetchJMA() {
  try {
    const r = await axios.get(
      'https://www.jma.go.jp/bosai/quake/data/list.json',
      { timeout: 10000 }
    );
    jmaFail = 0;
    return r.data?.[0] || null;
  } catch {
    jmaFail++;
    return null;
  }
}

/* ===== MAIN LOOP (1분) ===== */
async function mainLoop() {
  if (!running) return;

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const kma = await fetchKMA();
  const jma = await fetchJMA();

  /* KMA */
  if (kma && kma.eqkNo && kma.eqkNo !== lastKMA) {
    lastKMA = kma.eqkNo;
    const mag = kma.mag != null ? String(kma.mag) : '정보없음';
    const maxInt = kma.maxInt != null ? String(kma.maxInt) : '정보없음';
    const loc = kma.loc || '위치 정보 없음';
    const mention = Number(kma.mag) >= 4 ? '@everyone ' : '';

    const e = new EmbedBuilder()
      .setTitle('🇰🇷 지진 발생')
      .setDescription(loc)
      .addFields(
        { name: '규모', value: mag, inline: true },
        { name: '최대진도', value: maxInt, inline: true }
      )
      .setFooter({ text: '출처: 기상청(KMA)' })
      .setTimestamp();

    await channel.send({ content: mention, embeds: [e] });
  }

  /* JMA */
  if (jma && jma.time && jma.time !== lastJMA) {
    lastJMA = jma.time;
    const mag = jma.mag != null ? String(jma.mag) : '정보없음';
    const maxInt = jma.maxInt != null ? String(jma.maxInt) : '정보없음';
    const place = jma.place || '위치 정보 없음';
    const mention = Number(jma.maxInt) >= 5 ? '@everyone ' : '';

    const e = new EmbedBuilder()
      .setTitle('🇯🇵 지진 발생')
      .setDescription(place)
      .addFields(
        { name: '규모', value: mag, inline: true },
        { name: '최대진도', value: maxInt, inline: true }
      )
      .setFooter({ text: '출처: 일본기상청(JMA)' })
      .setTimestamp();

    await channel.send({ content: mention, embeds: [e] });
  }

  /* 장애 */
  if (!장애알림보냄 && (kmaFail >= 10 || jmaFail >= 10)) {
    장애알림보냄 = true;
    const e = new EmbedBuilder()
      .setTitle('⚠️ 지진봇 장애 감지')
      .setDescription(`KMA 실패 ${kmaFail}\nJMA 실패 ${jmaFail}`)
      .setColor(0xff0000)
      .setTimestamp();
    await channel.send({ embeds: [e] });
  }

  /* 복구 */
  if (장애알림보냄 && kmaFail === 0 && jmaFail === 0) {
    장애알림보냄 = false;
    const e = new EmbedBuilder()
      .setTitle('✅ 지진봇 장애 복구')
      .setColor(0x00ff00)
      .setTimestamp();
    await channel.send({ embeds: [e] });
  }
}

/* ===== INTERVALS ===== */
setInterval(() => {
  lastPing = Date.now();
  console.log('PING OK');
}, 60000);

setInterval(mainLoop, 60000);

/* ===== SLASH HANDLER ===== */
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'stop') {
    await i.reply({ content: '봇 종료', ephemeral: true });
    process.exit(0);
  }

  if (i.commandName === '실시간정보') {
    const e = new EmbedBuilder()
      .setTitle('📡 실시간 상태')
      .addFields(
        { name: 'KMA 실패', value: String(kmaFail), inline: true },
        { name: 'JMA 실패', value: String(jmaFail), inline: true },
        { name: 'Ping', value: new Date(lastPing).toLocaleString('ko-KR') }
      )
      .setTimestamp();
    await i.reply({ embeds: [e], ephemeral: true });
  }
});

/* ===== START ===== */
client.once('ready', async () => {
  await registerCommands();
  console.log('봇 준비 완료');
});

client.login(TOKEN);