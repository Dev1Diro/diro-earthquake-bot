require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ===== Discord 클라이언트 =====
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ===== 환경변수 =====
const CHANNEL_ID = process.env.CHANNEL_ID;       // 숫자 ID
const TOKEN = process.env.DISCORD_TOKEN;
const KMA_API = process.env.KMA_API_KEY;
const JMA_API = process.env.JMA_API_KEY;
const PINGER_URL = process.env.PINGER_URL;
const GUILD_ID = process.env.GUILD_ID;          // 테스트용 서버 ID
const PORT = process.env.PORT || 3000;

// ===== 이전 지진 기록 =====
let lastKMA = new Set();
let lastJMA = new Set();

// ===== KMA/JMA 조회 =====
async function fetchKMA() {
    try {
        const res = await axios.get(KMA_API, { timeout: 10000 });
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error("KMA fetch error:", err.message);
        return [];
    }
}

async function fetchJMA() {
    try {
        const res = await axios.get(JMA_API, { timeout: 10000 });
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error("JMA fetch error:", err.message);
        return [];
    }
}

// ===== 임베드 전송 =====
async function sendEmbed(channel, source, place, magnitude, time) {
    if (!channel || !channel.isTextBased()) {
        console.error("sendEmbed: 유효하지 않은 채널");
        return;
    }
    try {
        const embed = new EmbedBuilder()
            .setTitle(`${source} 지진 발생`)
            .addFields(
                { name: '장소', value: place || '정보 없음', inline: true },
                { name: '규모', value: magnitude?.toString() || '정보 없음', inline: true },
                { name: '시간', value: time || '정보 없음', inline: true }
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
        const currentK = new Set(kmaData.map(e => e.index));
        for (const e of kmaData) {
            if (!lastKMA.has(e.index)) {
                await sendEmbed(channel, 'KMA', e.place, e.magnitude, e.time);
            }
        }
        lastKMA = currentK;

        // JMA
        const jmaData = await fetchJMA();
        const currentJ = new Set(jmaData.map(e => e.index));
        for (const e of jmaData) {
            if (!lastJMA.has(e.index)) {
                await sendEmbed(channel, 'JMA', e.place, e.magnitude, e.time);
            }
        }
        lastJMA = currentJ;

    } catch (err) {
        console.error("checkQuakes error:", err.message);
    }
}

// ===== Ping 유지 =====
async function sendPing() {
    if (!PINGER_URL) return;
    try {
        await axios.get(PINGER_URL, { timeout: 10000 });
        console.log("Ping OK - 정상작동 확인");
    } catch (err) {
        console.error("Ping failed:", err.message);
    }
}

// ===== 루프 시작 =====
function startLoop(channel) {
    setInterval(() => checkQuakes(channel), 20 * 1000); // 20초마다 지진 조회
    setInterval(sendPing, 60 * 1000);                   // 1분마다 Ping
    sendPing();                                         // 즉시 Ping
    checkQuakes(channel);                               // 즉시 지진 체크
}

// ===== Express 서버 =====
const app = express();
app.get('/', (req, res) => res.send('Bot Active'));
app.listen(PORT, () => console.log(`Web server on port ${PORT}`));

// ===== Discord 로그인 & Slash Command 등록 =====
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
            console.error("유효한 텍스트 채널이 아님");
            return;
        }

        // Guild Command 등록 → 바로 서버에 반영
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        const commands = [
            new SlashCommandBuilder()
                .setName('stop')
                .setDescription('봇 종료')
        ].map(cmd => cmd.toJSON());

        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
        console.log("Slash Command 등록 완료");

        startLoop(channel);

    } catch (err) {
        console.error("Channel fetch error:", err.message);
    }
});

// ===== Slash Command 처리 =====
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'stop') {
        await interaction.reply('봇을 종료합니다...');
        console.log("Stop 명령어 수신, 봇 종료");
        client.destroy();
        process.exit(0);
    }
});

client.login(TOKEN);

// ===== 예외 처리 =====
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));