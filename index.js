// ===== 환경변수 로드 =====
require('dotenv').config();

// ===== 즉시 검증 =====
console.log('TOKEN 존재:', !!process.env.TOKEN);
console.log('DISCORD_CHANNEL_ID:', process.env.DISCORD_CHANNEL_ID);
console.log('JMA_API_KEY 존재:', !!process.env.JMA_API_KEY);

// ===== 라이브러리 =====
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ===== 환경변수 =====
const BOT_TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const JMA_KEY = process.env.JMA_API_KEY;

// ===== Discord Client =====
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

let running = true;
let lastKMAEqkNo = null;

// ===== 날짜 포맷 =====
function yyyymmdd(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// ===== KMA URL =====
function getKMAUrl() {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 3);

    return `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg`
        + `?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40`
        + `&numOfRows=10`
        + `&pageNo=1`
        + `&fromTmFc=${yyyymmdd(from)}`
        + `&toTmFc=${yyyymmdd(now)}`
        + `&dataType=JSON`;
}

// ===== KMA 조회 =====
async function fetchKMA() {
    try {
        const res = await axios.get(getKMAUrl(), { timeout: 5000 });
        const header = res.data?.response?.header;

        if (String(header?.resultCode) !== '0') {
            console.error('KMA API 오류:', header?.resultMsg);
            return [];
        }

        const items = res.data.response.body.items?.item;
        return items ? (Array.isArray(items) ? items : [items]) : [];
    } catch (e) {
        console.error('KMA fetch 실패:', e.message);
        return [];
    }
}

// ===== JMA 조회 (환경변수 사용) =====
async function fetchJMA() {
    try {
        // JMA는 보통 공개 JSON 엔드포인트 + 키 헤더 방식
        const res = await axios.get('JMA_ENDPOINT', {
            headers: {
                'Authorization': `Bearer ${JMA_KEY}`
            },
            timeout: 5000
        });
        return res.data || [];
    } catch (e) {
        console.error('JMA fetch 실패:', e.message);
        return [];
    }
}

// ===== 지진 체크 (현재는 KMA만 알림) =====
async function checkEarthquake() {
    if (!running) return;

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const list = await fetchKMA();
    if (list.length === 0) return;

    const latest = list[0];
    if (latest.eqkNo === lastKMAEqkNo) return;
    lastKMAEqkNo = latest.eqkNo;

    const embed = new EmbedBuilder()
        .setTitle('📢 지진 발생')
        .setDescription(latest.loc || '위치 정보 없음')
        .addFields(
            { name: '규모', value: String(latest.mag || '?'), inline: true },
            { name: '최대진도', value: latest.maxInt || '정보 없음', inline: true },
            { name: '발생시각', value: latest.tm || '알 수 없음' }
        )
        .setFooter({ text: '출처: 기상청(KMA)' })
        .setTimestamp();

    channel.send({ embeds: [embed] });
}

// ===== 루프 =====
function earthquakeLoop() {
    if (!running) return;
    checkEarthquake();
    setTimeout(earthquakeLoop, 20 * 1000);
}

function pingLoop() {
    if (!running) return;
    console.log('PING OK', new Date().toISOString());
    setTimeout(pingLoop, 60 * 1000);
}

// ===== /stop =====
client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === 'stop') {
        running = false;
        await i.reply('봇 종료');
        process.exit(0);
    }
});

// ===== 시작 =====
client.once('ready', () => {
    console.log('봇 로그인 완료:', client.user.tag);
    pingLoop();
    earthquakeLoop();
});

client.login(BOT_TOKEN);