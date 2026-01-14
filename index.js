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

// ===== ENV =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID || !CHANNEL_ID) {
  console.error('ENV 누락');
  process.exit(1);
}

// ===== DISCORD =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== 상태 =====
let lastKMA = null;
let lastJMA = null;
let kmaFail = 0;
let jmaFail = 0;
let lastPing = Date.now();
let 장애알림보냄 = false;
let running = true;

// ===== 슬래시 명령 자동 등록 =====
const commands = [
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('봇 종료'),
  new SlashCommandBuilder()
    .setName('실시간정보')
    .setDescription('지진봇 실시간 상태 확인')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );
  console.log('슬래시 명령 등록 완료');
}

// ===== 유틸 =====
const yyyymmdd = d => d.toISOString().slice(0,10).replace(/-/g,'');

// ===== KMA =====
function kmaUrl() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 3);

  return `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg`
    + `?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40`
    + `&numOfRows=5&pageNo=1`
    + `&fromTmFc=${yyyymmdd(from)}`
    + `&toTmFc=${yyyymmdd(now)}`
    + `&dataType=JSON`;
}

async function fetchKMA() {
  try {
    const r = await axios.get(kmaUrl(), { timeout: 5000 });
    if (String(r.data.response.header.resultCode) !== '0') throw 1;
    kmaFail = 0;

    const item = r.data.response.body.items?.item;
    return item ? (Array.isArray(item) ? item[0] : item) : null;
  } catch {
    kmaFail++;
    return null;
  }
}

// ===== JMA =====
async function fetchJMA() {
  try {
    const r = await axios.get(
      'https://www.jma.go.jp/bosai/quake/data/list.json',
      { timeout: 5000 }
    );
    jmaFail = 0;
    return r.data[0];
  } catch {
    jmaFail++;
    return null;
  }
}

// ===== 장애 감지 =====
async function 장애체크(channel) {
  if (장애알림보냄) return;

  if (
    kmaFail >= 3 ||
    jmaFail >= 3 ||
    Date.now() - lastPing > 120000
  ) {
    장애알림보냄 = true;

    const e = new EmbedBuilder()
      .setTitle('⚠️ 지진봇 장애 감지')
      .setDescription(
        `KMA 실패: ${kmaFail}\nJMA 실패: ${jmaFail}\nPing 지연`
      )
      .setColor(0xff0000)
      .setTimestamp();

    await channel.send({ embeds: [e] });
  }
}

// ===== 메인 루프 =====
async function mainLoop() {
  if (!running) return;

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const kma = await fetchKMA();
  const jma = await fetchJMA();

  // KMA 알림
  if (kma && kma.eqkNo !== lastKMA) {
    lastKMA = kma.eqkNo;
    const mention = Number(kma.mag) >= 4 ? '@everyone ' : '';

    const e = new EmbedBuilder()
      .setTitle('🇰🇷 지진 발생')
      .setDescription(kma.loc)
      .addFields(
        { name: '규모', value: String(kma.mag), inline: true },
        { name: '최대진도', value: kma.maxInt || '정보없음', inline: true }
      )
      .setFooter({ text: '출처: 기상청(KMA)' })
      .setTimestamp();

    await channel.send({ content: mention, embeds: [e] });
  }

  // JMA 알림
  if (jma && jma.time !== lastJMA) {
    lastJMA = jma.time;
    const mention = jma.maxInt >= 5 ? '@everyone ' : '';

    const e = new EmbedBuilder()
      .setTitle('🇯🇵 지진 발생')
      .setDescription(jma.place)
      .addFields(
        { name: '규모', value: String(jma.mag), inline: true },
        { name: '최대진도', value: String(jma.maxInt), inline: true }
      )
      .setFooter({ text: '출처: 일본기상청(JMA)' })
      .setTimestamp();

    await channel.send({ content: mention, embeds: [e] });
  }

  await 장애체크(channel);
  setTimeout(mainLoop, 20000);
}

// ===== Ping =====
setInterval(() => {
  lastPing = Date.now();
  console.log('PING OK');
}, 60000);

// ===== Slash 처리 (수정 핵심) =====
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === 'stop') {
      await i.deferReply({ ephemeral: true });
      await i.editReply('봇 종료');
      process.exit(0);
    }

    if (i.commandName === '실시간정보') {
      await i.deferReply({ ephemeral: true });

      const e = new EmbedBuilder()
        .setTitle('📡 실시간 상태')
        .addFields(
          { name: 'KMA 실패', value: String(kmaFail), inline: true },
          { name: 'JMA 실패', value: String(jmaFail), inline: true },
          { name: 'Ping', value: new Date(lastPing).toLocaleString('ko-KR') }
        )
        .setTimestamp();

      await i.editReply({ embeds: [e] });
    }
  } catch (err) {
    console.error('Slash 처리 오류:', err);
    if (!i.replied && !i.deferred) {
      await i.reply({ content: '명령 처리 중 오류 발생', ephemeral: true });
    }
  }
});

// ===== 시작 =====
client.once('ready', async () => {
  console.log('봇 로그인 완료');
  await registerCommands();
  mainLoop();
});

client.login(TOKEN);