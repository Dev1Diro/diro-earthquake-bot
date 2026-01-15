require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const axios = require('axios');

/* ===== 기본 설정 ===== */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const APPLICATION_ID = process.env.APPLICATION_ID;

/* ===== KMA 하드코딩 ===== */
const KMA_API_KEY = '24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40';

let currentKmaFrom = new Date('2026-01-12');
let currentKmaTo   = new Date('2026-01-15');

function formatKmaDate(d) {
    return d.toISOString().slice(0,10).replace(/-/g,'');
}

function advanceKmaDay() {
    currentKmaFrom.setDate(currentKmaFrom.getDate() + 1);
    currentKmaTo.setDate(currentKmaTo.getDate() + 1);
}

function getKmaUrl() {
    return `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${KMA_API_KEY}&numOfRows=10&pageNo=1&fromTmFc=${formatKmaDate(currentKmaFrom)}&toTmFc=${formatKmaDate(currentKmaTo)}`;
}

/* ===== 기타 API ===== */
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
const DISASTER_URL = 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=65H684WY1VX42LFO';

/* ===== 디스코드 ===== */
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
const rest = new REST({ version: '10' }).setToken(TOKEN);

/* ===== 슬래시 명령어 ===== */
const commands = [
    new SlashCommandBuilder()
        .setName('청소')
        .setDescription('메시지 삭제')
        .addIntegerOption(o =>
            o.setName('수량').setDescription('1~100').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('실시간정보')
        .setDescription('봇 상태 조회'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('봇 종료')
].map(c => c.toJSON());

async function registerCommands() {
    await rest.put(
        Routes.applicationCommands(APPLICATION_ID),
        { body: commands }
    );
}

/* ===== 상태 ===== */
let sentKMA = new Set();
let sentJMA = new Set();
let sentDisaster = new Set();
let pingFailures = 0;

/* ===== 임베드 ===== */
async function sendEmbed(title, description) {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

    await channel.send({ embeds: [embed] });
}

/* ===== fetch ===== */
async function fetchKMA() {
    try {
        const res = await axios.get(getKmaUrl(), { params: { disp: 1, help: 0 } });
        return res.data?.response?.body?.items?.item || [];
    } catch {
        pingFailures++;
        return [];
    }
}

async function fetchJMA() {
    try {
        const res = await axios.get(JMA_URL);
        return res.data || [];
    } catch {
        pingFailures++;
        return [];
    }
}

async function fetchDisaster() {
    try {
        const res = await axios.get(DISASTER_URL);
        return res.data?.response?.body?.items?.item || [];
    } catch {
        pingFailures++;
        return [];
    }
}

/* ===== 메인 루프 (60초) ===== */
function startLoop() {
    setInterval(async () => {

        /* KMA */
        const kma = await fetchKMA();
        for (const eq of kma) {
            const key = eq.earthquakeNo || JSON.stringify(eq);
            if (sentKMA.has(key)) continue;
            sentKMA.add(key);

            const desc =
`위치: ${eq.eqPlace}
규모: ${eq.eqMagnitude}
진도: ${eq.maxInten || '정보없음'}`;

            await sendEmbed('🇰🇷 KMA 지진 알림', desc);
        }
        advanceKmaDay();

        /* JMA */
        const jma = await fetchJMA();
        for (const eq of jma) {
            const key = eq.code || JSON.stringify(eq);
            if (sentJMA.has(key)) continue;
            sentJMA.add(key);

            let desc =
`위치: ${eq.place}
규모: ${eq.magnitude}
최대진도: ${eq.intensity}`;

            if (Number(eq.intensity) >= 5) {
                desc = `@everyone\n${desc}`;
            }

            await sendEmbed('🇯🇵 JMA 지진 알림', desc);
        }

        /* 재난문자 */
        const dis = await fetchDisaster();
        for (const d of dis) {
            const key = d.msgNo || JSON.stringify(d);
            if (sentDisaster.has(key)) continue;
            sentDisaster.add(key);

            let msg = d.msg || '';
            if (d.level === '긴급' || d.level === '최상위') {
                msg = `@everyone\n${msg}`;
            }

            await sendEmbed(d.msgTitle || '재난 문자', msg);
        }

    }, 60_000);
}

/* ===== 슬래시 처리 ===== */
client.on('interactionCreate', async i => {
    if (!i.isCommand()) return;

    if (i.commandName === '청소') {
        const n = i.options.getInteger('수량');
        if (n < 1 || n > 100) {
            return i.reply({ content: '1~100만 가능', ephemeral: true });
        }
        const msgs = await i.channel.messages.fetch({ limit: n });
        await i.channel.bulkDelete(msgs);
        return i.reply({ content: `${n}개 삭제 완료`, ephemeral: true });
    }

    if (i.commandName === '실시간정보') {
        const status =
`Ping 실패: ${pingFailures}
KMA/JMA 상태: ${pingFailures === 0 ? '🟢 정상' : '🔴 불안정'}`;
        return i.reply({
            embeds: [new EmbedBuilder().setTitle('실시간 정보').setDescription(status).setTimestamp()],
            ephemeral: true
        });
    }

    if (i.commandName === 'stop') {
        await i.reply('봇 종료');
        process.exit(0);
    }
});

/* ===== 시작 ===== */
client.once('ready', async () => {
    console.log(`${client.user.tag} 온라인`);
    await registerCommands();
    startLoop();
});

client.login(TOKEN);