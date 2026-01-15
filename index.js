require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');

// ================= 환경변수 =================
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const KMA_KEY = process.env.KMA_KEY;
const JMA_KEY = process.env.JMA_API_KEY;
const DISASTER_KEY = process.env.DISASTER_KEY;
const PORT = process.env.PORT || 3000;

// ================= Discord Client =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

let pingerOK = false;
let KMA_OK = false;
let JMA_OK = false;
let disasterOK = false;
let stopFlag = false;

// ================= KMA 날짜 자동 갱신 =================
let kmaFromDate = new Date(); // 오늘 기준
let kmaToDate = new Date(kmaFromDate);
kmaToDate.setDate(kmaFromDate.getDate() + 1);

function formatDateYMD(date) {
  return date.toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD
}

// ================= KMA/JMA/재난문자 API =================
async function fetchKMA() {
  try {
    const fromTmFc = formatDateYMD(kmaFromDate);
    const toTmFc = formatDateYMD(kmaToDate);
    const url = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40&numOfRows=10&pageNo=1&fromTmFc=20260112&toTmFc=20260115`;
    const res = await axios.get(url, {
      params: {
        serviceKey: KMA_KEY,
        numOfRows: 10,
        pageNo: 1,
        fromTmFc,
        toTmFc,
        dataType: 'JSON'
      },
      timeout: 15000
    });
    KMA_OK = true;
    // 날짜 갱신: 다음 날
    const today = new Date();
    if (kmaToDate <= today) {
      kmaFromDate.setDate(kmaFromDate.getDate() + 1);
      kmaToDate.setDate(kmaToDate.getDate() + 1);
    }
    return res.data?.response?.body?.items?.item || [];
  } catch(e) {
    KMA_OK = false;
    console.error("KMA fetch failed:", e.message);
    return [];
  }
}

async function fetchJMA() {
  try {
    const res = await axios.get('https://www.jma.go.jp/bosai/quake/data/list.json', {
      headers: { 'Authorization': `Bearer ${JMA_KEY}` },
      timeout: 15000
    });
    JMA_OK = true;
    return res.data?.items || [];
  } catch(e) {
    JMA_OK = false;
    console.error("JMA fetch failed:", e.message);
    return [];
  }
}

const DISASTER_URL = 'https://www.safetydata.go.kr//V2/api/DSSP-IF-00247?serviceKey=65H684WY1VX42LFO';
async function fetchDisaster() {
  try {
    const r = await axios.get(DISASTER_URL, {
      params: { serviceKey: DISASTER_KEY, returnType: 'JSON' },
      timeout: 15000
    });
    disasterOK = true;
    return r.data?.body?.items || [];
  } catch(e) {
    disasterOK = false;
    console.error("Disaster fetch failed:", e.message);
    return [];
  }
}

// ================= Discord 전송 =================
async function sendEmbed(title, description) {
  if (!CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
  } catch(e) {
    console.error("Embed send failed:", e.message);
  }
}

// ================= Pinger =================
async function pingLoop() {
  while(!stopFlag) {
    try {
      await client.user.setActivity('실시간 지진 정보', { type: 3 });
      pingerOK = true;
      console.log(`[Pinger] 정상작동: ${new Date().toLocaleTimeString()}`);
    } catch {
      pingerOK = false;
    }
    await new Promise(r=>setTimeout(r, 60_000));
  }
}

// ================= 조회 루프 =================
async function checkLoop() {
  while(!stopFlag) {
    const kma = await fetchKMA();
    const jma = await fetchJMA();
    const disaster = await fetchDisaster();

    const events = [];
    kma?.forEach(i => events.push(`[KMA] ${i.title || i}`));
    jma?.forEach(i => events.push(`[JMA] ${i.title || i}`));
    disaster?.forEach(i => {
      const level = i.alarmLevel || '';
      const title = level.includes('위급') ? `@everyone ${i.title}` : i.title;
      events.push(`[DISASTER] ${title}\n${i.contents}`);
    });

    for (const ev of events) {
      await sendEmbed('실시간 정보', ev);
    }

    await new Promise(r=>setTimeout(r, 20_000));
  }
}

// ================= 슬래쉬 명령어 =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'stop') {
    stopFlag = true;
    await interaction.reply('봇 작동 중지됨.');
    process.exit(0);
  }
  if (interaction.commandName === '실시간정보') {
    const embed = new EmbedBuilder()
      .setTitle('실시간 상태')
      .addFields(
        { name: 'Pinger', value: pingerOK ? '🟢 정상' : '🔴 실패', inline: true },
        { name: 'KMA 연결', value: KMA_OK ? '🟢 정상' : '🔴 실패', inline: true },
        { name: 'JMA 연결', value: JMA_OK ? '🟢 정상' : '🔴 실패', inline: true },
        { name: '재난문자 연결', value: disasterOK ? '🟢 정상' : '🔴 실패', inline: true }
      )
      .setTimestamp(new Date());
    await interaction.reply({ embeds: [embed] });
  }
});

// ================= 슬래쉬 명령어 등록 =================
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: [
        { name: 'stop', description: '봇 작동 중지' },
        { name: '실시간정보', description: '현재 상태 확인' }
      ] }
    );
    console.log('슬래쉬 명령어 등록 완료');
  } catch(e) { console.error(e); }

  pingLoop();
  checkLoop();
});

client.login(TOKEN).catch(e=>console.error("Discord login failed:", e.message));

// ================= 서버 포트 바인딩 (Render용) =================
const app = express();
app.get('/', (req,res)=>res.send('봇 실행중'));
app.listen(PORT, ()=>console.log(`서버 포트 ${PORT} 바인딩 완료`));