'use strict';

/* =========================
   기본 모듈
========================= */
const express = require('express');
const axios = require('axios');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder
} = require('discord.js');

/* =========================
   환경변수
========================= */
const {
  TOKEN,
  APPLICATION_ID,
  DISCORD_CHANNEL_ID,
  ADMIN_USER_ID,
  KMA_API_KEY,
  JMA_API_KEY,
  DISASTER_API_KEY,
  PORT
} = process.env;

/* =========================
   기본 검증
========================= */
if (!TOKEN || !APPLICATION_ID || !DISCORD_CHANNEL_ID || !ADMIN_USER_ID) {
  console.error('필수 환경변수 누락');
  process.exit(1);
}

/* =========================
   Express (Render 포트 바인딩)
========================= */
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT || 3000, () => {
  console.log('Express alive');
});

/* =========================
   Discord Client
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =========================
   상태 관리
========================= */
const state = {
  running: true,
  lastCheck: null,
  sentIds: new Set(),
  fail: {
    kma: false,
    jma: false,
    disaster: false
  }
};

/* =========================
   유틸
========================= */
const kstNow = () =>
  new Date(Date.now() + 9 * 60 * 60 * 1000);

const todayYmd = () =>
  kstNow().toISOString().slice(0, 10).replace(/-/g, '');

/* =========================
   KMA 지진 조회
========================= */
async function fetchKMA() {
  try {
    const ymd = todayYmd();
    const res = await axios.get(
      'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg',
      {
        params: {
          serviceKey: KMA_API_KEY,
          numOfRows: 10,
          pageNo: 1,
          fromTmFc: ymd,
          toTmFc: ymd,
          dataType: 'JSON'
        },
        timeout: 8000
      }
    );
    state.fail.kma = false;
    return res.data?.response?.body?.items?.item || [];
  } catch (e) {
    state.fail.kma = true;
    return [];
  }
}

/* =========================
   JMA 보조 (일본)
========================= */
async function fetchJMA() {
  try {
    const res = await axios.get(
      'https://www.jma.go.jp/bosai/quake/data/list.json',
      { timeout: 8000 }
    );
    state.fail.jma = false;
    return res.data || [];
  } catch (e) {
    state.fail.jma = true;
    return [];
  }
}

/* =========================
   재난문자 (전국)
========================= */
async function fetchDisaster() {
  try {
    const ymd = todayYmd();
    const res = await axios.get(
      'https://apis.data.go.kr/1741000/DisasterMsg3/getDisasterMsgList3',
      {
        params: {
          serviceKey: DISASTER_API_KEY,
          pageNo: 1,
          numOfRows: 5,
          type: 'json',
          fromTmFc: ymd,
          toTmFc: ymd
        },
        timeout: 8000
      }
    );
    state.fail.disaster = false;
    return res.data?.DisasterMsg?.row || [];
  } catch {
    state.fail.disaster = true;
    return [];
  }
}

/* =========================
   알림 전송
========================= */
async function sendEmbed(title, desc) {
  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: '출처: KMA / JMA / 행안부' })
    .setTimestamp();
  await ch.send({ embeds: [embed] });
}

/* =========================
   지진 체크 루프 (1분)
========================= */
async function checkLoop() {
  if (!state.running) return;

  state.lastCheck = new Date();

  const kma = await fetchKMA();
  for (const e of kma) {
    const id = e.tmEqk + e.lat + e.lon;
    if (state.sentIds.has(id)) continue;
    state.sentIds.add(id);

    await sendEmbed(
      '지진 발생',
      `${e.loc}\n규모 ${e.mag}`
    );
  }

  await fetchJMA();        // 보조 수집
  await fetchDisaster();   // 재난문자 병합
}

setInterval(checkLoop, 60 * 1000);

/* =========================
   슬래시 명령어
========================= */
const commands = [
  { name: 'stop', description: '봇 즉시 종료' },
  { name: '청소', description: '캐시 초기화' },
  { name: '실시간정보', description: '상태 확인' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(APPLICATION_ID),
    { body: commands }
  );
})();

/* =========================
   명령어 처리 (관리자 제한)
========================= */
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (i.user.id !== ADMIN_USER_ID) {
    return i.reply({ content: '권한 없음', ephemeral: true });
  }

  if (i.commandName === 'stop') {
    await i.reply('봇 종료');
    process.exit(0);
  }

  if (i.commandName === '청소') {
    state.sentIds.clear();
    await i.reply('캐시 초기화 완료');
  }

  if (i.commandName === '실시간정보') {
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('실시간 상태')
          .setDescription(
            `KMA: ${state.fail.kma ? '🔴' : '🟢'}\n` +
            `JMA: ${state.fail.jma ? '🔴' : '🟢'}\n` +
            `재난문자: ${state.fail.disaster ? '🔴' : '🟢'}`
          )
          .setTimestamp()
      ]
    });
  }
});

/* =========================
   로그인
========================= */
client.login(TOKEN);