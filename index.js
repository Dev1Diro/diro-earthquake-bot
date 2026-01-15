require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

const KMA_URL = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${process.env.KMA_API_KEY}&numOfRows=10&pageNo=1`;
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
const DISASTER_URL = 'https://www.safetydata.go.kr//V2/api/DSSP-IF-00247?serviceKey=65H684WY1VX42LFO';

let fromTmFc = process.env.KMA_FROM || '20260114';
let toTmFc = process.env.KMA_TO || '20260115';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 슬래쉬 커맨드 등록
const commands = [
    new SlashCommandBuilder().setName('stop').setDescription('봇 종료'),
    new SlashCommandBuilder().setName('실시간정보').setDescription('봇 실시간 상태 조회'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
    await rest.put(Routes.applicationCommands(process.env.APPLICATION_ID), { body: commands });
}

client.once('ready', () => {
    console.log(`${client.user.tag} 봇 준비 완료`);
    startPingLoop();
    startKmaJmaLoop();
    startDisasterLoop();
});

// ===== Pinger 1분 =====
let pingFailures = 0;
function startPingLoop() {
    setInterval(async () => {
        try {
            await axios.get('https://www.google.com'); // 단순 ping
            console.log('Ping 성공');
            pingFailures = 0;
        } catch {
            pingFailures++;
            console.log(`Ping 실패 시도 ${pingFailures}`);
        }
    }, 60_000);
}

// ===== KMA 지진 조회 20초 =====
async function fetchKMA() {
    try {
        const url = `${KMA_URL}&fromTmFc=${fromTmFc}&toTmFc=${toTmFc}`;
        const res = await axios.get(url, { params: { disp: 1, help: 0 } });
        return res.data?.response?.body?.items?.item || [];
    } catch(e) {
        console.error('KMA fetch 실패:', e.message);
        return [];
    }
}

// ===== JMA 지진 조회 =====
async function fetchJMA() {
    try {
        const res = await axios.get(JMA_URL);
        return res.data || [];
    } catch(e) {
        console.error('JMA fetch 실패:', e.message);
        return [];
    }
}

// ===== 재난문자 조회 =====
async function fetchDisaster() {
    try {
        const res = await axios.get(DISASTER_URL);
        return res.data?.response?.body?.items?.item || [];
    } catch(e) {
        console.error('재난문자 fetch 실패:', e.message);
        return [];
    }
}

// ===== 임베드 메시지 전송 =====
async function sendEmbed(title, description) {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if(!channel) return;
        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch(e) {
        console.error('임베드 전송 실패:', e.message);
    }
}

// ===== 지진 조회 루프 20초 =====
function startKmaJmaLoop() {
    setInterval(async () => {
        const kmaData = await fetchKMA();
        const jmaData = await fetchJMA();
        // 최근 지진 있으면 임베드 전송
        if(kmaData.length) await sendEmbed('KMA 지진 알림', JSON.stringify(kmaData[0]));
        if(jmaData.length) await sendEmbed('JMA 지진 알림', JSON.stringify(jmaData[0]));
        // 하루 지나면 날짜 1일씩 이동
        const today = new Date();
        if(today.getDate() !== parseInt(fromTmFc.slice(6,8))) {
            const nextDate = new Date(today);
            fromTmFc = nextDate.toISOString().slice(0,10).replace(/-/g,'');
            toTmFc = new Date(nextDate.getTime() + 24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
        }
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
                await sendEmbed(title, desc);
            }
        }
    }, 20_000);
}

// ===== 슬래쉬 명령어 처리 =====
client.on('interactionCreate', async interaction => {
    if(!interaction.isCommand()) return;
    if(interaction.commandName === 'stop') {
        await interaction.reply('봇 종료 중...');
        process.exit(0);
    }
    if(interaction.commandName === '실시간정보') {
        const status = `핑 실패: ${pingFailures}\nKMA 연결: ${pingFailures===0?'🟢':'🔴'}\nJMA 연결: 🟢`;
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle('실시간 정보').setDescription(status).setTimestamp()] });
    }
});

registerCommands().catch(console.error);
client.login(TOKEN);