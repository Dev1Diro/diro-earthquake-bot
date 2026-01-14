require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ===== Discord 클라이언트 =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ===== 환경변수 =====
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const KMA_KEY = process.env.KMA_API_KEY;
const JMA_KEY = process.env.JMA_API_KEY;
const PINGER_URL = process.env.PINGER_URL;

// ===== 새 이벤트 추적 =====
let lastIndicesKMA = new Set();
let lastIndicesJMA = new Set();

// ===== KMA 조회 =====
async function fetchKMA() {
    try {
        const nowTm = new Date().toISOString().slice(0,16).replace(/[-T:]/g,"");
        const res = await axios.get(process.env.KMA_API_URL, { // URL도 env에서
            params: { tm: nowTm, disp: 1, help: 0, authkey: KMA_KEY }
        });
        return res.data || [];
    } catch(e) {
        console.error("KMA fetch failed:", e.message);
        return [];
    }
}

// ===== JMA 조회 =====
async function fetchJMA() {
    try {
        const res = await axios.get(process.env.JMA_API_URL, { // URL env 처리
            headers: { 'Authorization': `Bearer ${JMA_KEY}` }
        });
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

    // KMA
    const kmaData = await fetchKMA();
    const currentKMA = new Set(kmaData.map(e => e.index));
    for (const e of kmaData) if (!lastIndicesKMA.has(e.index)) await sendEmbed(channel, 'KMA', e.place, e.magnitude, e.time);
    lastIndicesKMA = currentKMA;

    // JMA
    const jmaData = await fetchJMA();
    const currentJMA = new Set(jmaData.map(e => e.index));
    for (const e of jmaData) if (!lastIndicesJMA.has(e.index)) await sendEmbed(channel, 'JMA', e.place, e.magnitude, e.time);
    lastIndicesJMA = currentJMA;

    // Render 핑거
    if (PINGER_URL) try { await axios.get(PINGER_URL); } catch(e){ console.error("Ping failed:", e.message); }
}

// 반복
setInterval(checkQuakes, 30000);

// Render 상태 체크용 서버
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

// 예외 처리
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

// Discord 로그인
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    checkQuakes();
});
client.login(TOKEN);