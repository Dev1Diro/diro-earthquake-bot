require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ===== Discord 클라이언트 =====
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ===== 환경변수 =====
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const KMA_API = process.env.KMA_API_KEY; // “주소+키” 형식으로 env에 넣는 값
const JMA_API = process.env.JMA_API_KEY; // “주소+키” 형식
const PINGER_URL = process.env.PINGER_URL;
const PORT = process.env.PORT || 3000;

// ===== 내부 상태 저장 =====
let lastKMA = new Set();
let lastJMA = new Set();

// ===== KMA 지진 조회 =====
async function fetchKMA() {
    try {
        // API가 env에 “https://...eqk_now.php?authkey=실제키”처럼 들어 있음
        const response = await axios.get(KMA_API, { timeout: 10000 });
        return Array.isArray(response.data) ? response.data : [];
    } catch (err) {
        console.error("KMA fetch error:", err.message);
        return [];
    }
}

// ===== JMA 지진 조회 =====
async function fetchJMA() {
    try {
        // JMA_API도 env에 주소+키 형태로 들어 있음
        const response = await axios.get(JMA_API, { timeout: 10000 });
        return Array.isArray(response.data) ? response.data : [];
    } catch (err) {
        console.error("JMA fetch error:", err.message);
        return [];
    }
}

// ===== 임베드 메시지 =====
async function sendEmbed(channel, source, place, magnitude, time) {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`${source} 지진 발생`)
            .addFields(
                { name: '장소', value: place || '없음', inline: true },
                { name: '규모', value: magnitude?.toString() || '없음', inline: true },
                { name: '시간', value: time || '없음', inline: true }
            )
            .setFooter({
                text: `출처: ${source === 'KMA' ? '한국기상청' : '일본기상청(JMA)'}`
            })
            .setColor(source === 'KMA' ? 0x1E90FF : 0xFF4500);

        await channel.send({ content: '@everyone', embeds: [embed] });
    } catch (err) {
        console.error("Embed send error:", err.message);
    }
}

// ===== 지진 체크 =====
async function checkQuakes(channel) {
    try {
        // KMA
        const kmaData = await fetchKMA();
        const currentKMA = new Set(kmaData.map(e => e.index));
        for (const e of kmaData) {
            if (!lastKMA.has(e.index)) {
                await sendEmbed(channel, 'KMA', e.place, e.magnitude, e.time);
            }
        }
        lastKMA = currentKMA;

        // JMA
        const jmaData = await fetchJMA();
        const currentJMA = new Set(jmaData.map(e => e.index));
        for (const e of jmaData) {
            if (!lastJMA.has(e.index)) {
                await sendEmbed(channel, 'JMA', e.place, e.magnitude, e.time);
            }
        }
        lastJMA = currentJMA;
    } catch (err) {
        console.error("checkQuakes error:", err.message);
    }
}

// ===== Ping 유지 =====
async function sendPing() {
    if (!PINGER_URL) return;
    try {
        await axios.get(PINGER_URL, { timeout: 10000 });
        console.log("Ping OK");
    } catch (err) {
        console.error("Ping failed:", err.message);
    }
}

// ===== Schedule =====
function startLoop(channel) {
    // 30초마다 지진 체크
    setInterval(() => checkQuakes(channel), 30 * 1000);

    // 1분마다 Ping
    setInterval(sendPing, 60 * 1000);

    // 시작 직후 즉시 실행
    sendPing();
    checkQuakes(channel);
}

// ===== Express 포트 바인딩 (Render 무료 플랜) =====
const app = express();
app.get('/', (req, res) => res.send('Bot Active'));
app.listen(PORT, () => console.log(`Web on port ${PORT}`));

// ===== 예외 처리 =====
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

// ===== Discord 시작 =====
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) {
            console.error("채널을 찾을 수 없습니다. ID 확인");
            return;
        }
        startLoop(channel);
    } catch (err) {
        console.error("Channel fetch error:", err.message);
    }
});

client.login(TOKEN);