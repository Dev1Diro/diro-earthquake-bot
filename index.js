require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

const KMA_BASE_URL = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${process.env.KMA_API_KEY}&numOfRows=10&pageNo=1`;
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
const DISASTER_URL = 'https://www.safetydata.go.kr//V2/api/DSSP-IF-00247?serviceKey=65H684WY1VX42LFO';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(TOKEN);

const commands = [
    new SlashCommandBuilder().setName('stop').setDescription('봇 종료'),
    new SlashCommandBuilder().setName('실시간정보').setDescription('봇 실시간 상태 조회'),
].map(cmd => cmd.toJSON());

let pingFailures = 0;
let sentKMA = new Set();
let sentJMA = new Set();
let currentKmaFrom = new Date('2026-01-15'); // 시작 날짜
let currentKmaTo = new Date('2027-01-15'); // 종료 날짜

async function registerCommands() {
    await rest.put(Routes.applicationCommands(process.env.APPLICATION_ID), { body: commands });
}

client.once('ready', () => {
    console.log(`${client.user.tag} 봇 준비 완료`);
    startPingLoop();
    startEarthquakeLoop();
    startDisasterLoop();
});

// ===== Pinger 1분 =====
function startPingLoop() {
    setInterval(async () => {
        try {
            await axios.get('https://www.google.com');
            console.log('Ping 성공');
            pingFailures = 0;
        } catch {
            pingFailures++;
            console.log(`Ping 실패 시도 ${pingFailures}`);
        }
    }, 60_000);
}

// ===== KMA 날짜 자동 이동 =====
function formatKmaDate(date) {
    return date.toISOString().slice(0, 10).replace(/-/g,'');
}

function advanceKmaDay() {
    currentKmaFrom.setDate(currentKmaFrom.getDate() + 1);
    currentKmaTo.setDate(currentKmaTo.getDate() + 1);
}

// ===== KMA =====
async function fetchKMA() {
    try {
        const url = `${KMA_BASE_URL}&fromTmFc=${formatKmaDate(currentKmaFrom)}&toTmFc=${formatKmaDate(currentKmaTo)}`;
        const res = await axios.get(url, { params: { disp: 1, help: 0 } });
        return res.data?.response?.body?.items?.item || [];
    } catch(e) {
        console.error('KMA fetch 실패:', e.message);
        return [];
    }
}

// ===== JMA =====
async function fetchJMA() {
    try {
        const res = await axios.get(JMA_URL);
        return res.data || [];
    } catch(e) {
        console.error('JMA fetch 실패:', e.message);
        return [];
    }
}

// ===== 재난문자 =====
async function fetchDisaster() {
    try {
        const res = await axios.get(DISASTER_URL);
        return res.data?.response?.body?.items?.item || [];
    } catch(e) {
        console.error('재난문자 fetch 실패:', e.message);
        return [];
    }
}

// ===== 임베드 전송 =====
async function sendEmbed(title, description) {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if(!channel) return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch(e) {
        console.error('임베드 전송 실패:', e.message);
    }
}

// ===== 지진 루프 20초 =====
function startEarthquakeLoop() {
    setInterval(async () => {
        const kmaData = await fetchKMA();
        const jmaData = await fetchJMA();

        // KMA 지진 알람
        for(const eq of kmaData) {
            const key = eq.earthquakeNo || eq.id || JSON.stringify(eq);
            if(!sentKMA.has(key)) {
                sentKMA.add(key);
                const desc = `위치: ${eq.eqPlace}\n규모: ${eq.eqMagnitude || eq.magnitude}\n진도: ${eq.maxInten || eq.intensity}\n예상 피해: ${eq.damage || '없음'}`;
                await sendEmbed('KMA 지진 알림', desc);
            }
        }

        // JMA 지진 알람
        for(const eq of jmaData) {
            const key = eq.code || JSON.stringify(eq);
            if(!sentJMA.has(key)) {
                sentJMA.add(key);
                const desc = `위치: ${eq.place}\n규모: ${eq.magnitude}\n진도: ${eq.intensity}`;
                await sendEmbed('JMA 지진 알림', desc);
            }
        }

        // 날짜 자동 이동 (KMA)
        advanceKmaDay();

    }, 20_000);
}

// ===== 재난문자 루프 20초 =====
function startDisasterLoop() {
    setInterval(async () => {
        const data = await fetchDisaster();
        if(data.length) {
            for(const item of data) {
                let title = item.msgTitle || '재난 문자';
                let desc = item.msg || '';
                // 위급/에브리원 문자 조건
                if(item.level === '긴급' || item.level === '최상위') {
                    desc = `@everyone\n${desc}`;
                }
                await sendEmbed(title, desc);
            }
        }
    }, 20_000);
}

// ===== 슬래쉬 명령어 =====
client.on('interactionCreate', async interaction => {
    if(!interaction.isCommand()) return;
    if(interaction.commandName === 'stop') {
        await interaction.reply('봇 종료 중...');
        process.exit(0);
    }
    if(interaction.commandName === '실시간정보') {
        const status = `Ping 실패: ${pingFailures}\nKMA 연결: ${pingFailures===0?'🟢':'🔴'}\nJMA 연결: 🟢`;
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle('실시간 정보').setDescription(status).setTimestamp()] });
    }
});

registerCommands().catch(console.error);
client.login(TOKEN);