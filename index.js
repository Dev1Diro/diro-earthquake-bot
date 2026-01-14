require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ===== Discord 클라이언트 =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ===== 환경변수 (Key만) =====
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const KMA_KEY = process.env.KMA_API_KEY;
const JMA_KEY = process.env.JMA_API_KEY;
const PINGER_URL = process.env.PINGER_URL;
const PORT = process.env.PORT || 3000;

// ===== 새 이벤트 추적 =====
let lastIndicesKMA = new Set();
let lastIndicesJMA = new Set();

// ===== KMA 지진 데이터 조회 =====
async function fetchKMA() {
    try {
        // tm 등 필요 인자 예시, 실제 API 문서 참고
        const nowTm = new Date().toISOString().slice(0,16).replace(/[-T:]/g,"");
        const res = await axios.get('', { params: { tm: nowTm, disp: 1, help: 0, authkey: KMA_KEY } });
        return res.data || [];
    } catch(e) {
        console.error("KMA fetch failed:", e.message);
        return [];
    }
}

// ===== JMA 지진 데이터 조회 =====
async function fetchJMA() {
    try {
        const res = await axios.get('', { headers: { 'Authorization': `Bearer ${JMA_KEY}` } });
        return res.data || [];
    } catch(e) {
        console.error("JMA fetch failed:", e.message);
        return [];
    }
}

// ===== 디스코드 임베드 전송 =====
async function sendEmbed(channel, source, place, magnitude, time) {
    const embed = new EmbedBuilder()
        .setTitle(`${source} 지진 발생`)
        .addFields(
            { name: '장소', value: place || '?', inline: true },
            { name: '규모', value: magnitude?.toString() || '?', inline: true },
            { name: '시간', value: time || '?', inline: true }
        )
        .setFooter({ text: `출처: ${source === 'KMA' ? '한국기상청' : '일본기상청(JMA)'}` })
        .setColor(source === 'KMA' ? 0x1E90FF : 0xFF4500);

    await channel.send({ content: '@everyone', embeds: [embed] });
}

// ===== 지진 체크 =====
async function checkQuakes() {
    const channel = client.channels.cache.get(CHANNEL_ID);
    if (!channel) return;

    const kmaData = await fetchKMA();
    const currentKMA = new Set(kmaData.map(e => e.index));
    for (const e of kmaData) if (!lastIndicesKMA.has(e.index)) await sendEmbed(channel, 'KMA', e.place, e.magnitude, e.time);
    lastIndicesKMA = currentKMA;

    const jmaData = await fetchJMA();
    const currentJMA = new Set(jmaData.map(e => e.index));
    for (const e of jmaData) if (!lastIndicesJMA.has(e.index)) await sendEmbed(channel, 'JMA', e.place, e.magnitude, e.time);
    lastIndicesJMA = currentJMA;
}

// ===== Pinger (Render 무료 플랜 활성화 유지) =====
async function sendPing(retries = 3) {
    if (!PINGER_URL) return;
    for (let i = 0; i < retries; i++) {
        try {
            await axios.get(PINGER_URL, { timeout: 5000 });
            console.log("Ping 성공:", PINGER_URL);
            break;
        } catch(e) {
            console.error(`Ping 실패 시도 ${i+1}:`, e.message);
            if (i === retries - 1) console.error("Ping 완전히 실패");
        }
    }
}

// ===== 반복 실행 =====
setInterval(checkQuakes, 30000);  // 30초마다 지진 체크
setInterval(sendPing, 5*60*1000); // 5분마다 Ping
sendPing();                        // 시작 직후 Ping

// ===== Render 상태 체크용 서버 =====
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

// ===== 예외 처리 =====
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

// ===== Discord 로그인 =====
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    checkQuakes();
});
client.login(TOKEN);