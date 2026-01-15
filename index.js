const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');

/* ===== 설정 ===== */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

/* ===== API URL 하드코딩 ===== */
const KMA_URL = 'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40&numOfRows=10&pageNo=1&fromTmFc=20260115&toTmFc=20270115';
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
const DISASTER_URL = 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=65H684WY1VX42LFO';

/* ===== 디스코드 클라이언트 ===== */
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

/* ===== 상태 ===== */
let sentKMA = new Set();
let sentJMA = new Set();
let sentDisaster = new Set();
let pingFailures = 0;

/* ===== 임베드 전송 ===== */
async function sendEmbed(title, desc, color='#FFFF00') {
    if(!desc || desc.trim() === '') return;
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if(!channel) return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(desc)
            .setColor(color)
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch(e) { console.error('임베드 전송 실패:', e.message); }
}

/* ===== fetch 함수 ===== */
async function fetchKMA(){ try{ const res = await axios.get(KMA_URL); return res.data?.response?.body?.items?.item || []; }catch{return [];} }
async function fetchJMA(){ try{ const res = await axios.get(JMA_URL); return res.data || []; }catch{return [];} }
async function fetchDisaster(){ try{ const res = await axios.get(DISASTER_URL); return res.data?.response?.body?.items?.item || []; }catch{return [];} }

/* ===== Ping 루프 1분 ===== */
function startPingLoop(){
    setInterval(async ()=>{
        try{
            await axios.get('https://www.google.com');
            pingFailures = 0;
        }catch{
            pingFailures++;
        }
    }, 60_000);
}

/* ===== 메인 루프 20초 ===== */
function startLoop(){
    setInterval(async()=>{

        /* KMA 4 이상 */
        const kmaData = await fetchKMA();
        for(const eq of kmaData){
            const key = `${eq.earthquakeNo||''}-${eq.eqPlace||''}`;
            if(sentKMA.has(key)) continue;
            if(!eq.eqPlace || !eq.maxInten) continue;
            if(Number(eq.maxInten) < 4) continue;
            sentKMA.add(key);
            const desc = `위치: ${eq.eqPlace}\n규모: ${eq.eqMagnitude||'정보없음'}\n진도: ${eq.maxInten}`;
            await sendEmbed('🇰🇷 KMA 지진 🔶', desc, '#FFA500');
        }

        /* JMA 5+ */
        const jmaData = await fetchJMA();
        for(const eq of jmaData){
            const key = `${eq.code||''}-${eq.place||''}`;
            if(sentJMA.has(key)) continue;
            if(!eq.place || !eq.intensity || !eq.magnitude) continue;
            sentJMA.add(key);
            const is5Plus = eq.intensity.includes('5+');
            if(!is5Plus) continue;
            const desc = `@everyone\n위치: ${eq.place}\n규모: ${eq.magnitude}\n최대진도: ${eq.intensity}`;
            await sendEmbed('🇯🇵 JMA 지진 🔴', desc, '#FF0000');
        }

        /* 재난문자 (긴급, 위급만) */
        const disasterData = await fetchDisaster();
        for(const d of disasterData){
            const key = `${d.msgNo||''}`;
            if(sentDisaster.has(key)) continue;
            if(!d.msg || !d.level) continue;
            if(d.level!=='긴급' && d.level!=='위급') continue;
            sentDisaster.add(key);
            const msg = `@everyone\n${d.msg}`;
            await sendEmbed('⚠️ 재난 알림', msg, '#1E90FF');
        }

    }, 20_000);
}

/* ===== 슬래시 명령어 처리 (청소, stop, 실시간정보) ===== */
client.on('interactionCreate', async interaction=>{
    if(!interaction.isCommand()) return;

    if(interaction.commandName==='청소'){
        const n = interaction.options.getInteger('수량');
        if(n<1 || n>100) return interaction.reply({content:'1~100만 가능합니다.', ephemeral:true});
        try{
            const msgs = await interaction.channel.messages.fetch({limit:n});
            await interaction.channel.bulkDelete(msgs,true);
            return interaction.reply({content:`${n}개 메시지 삭제 완료`, ephemeral:true});
        }catch{return interaction.reply({content:'메시지 삭제 실패', ephemeral:true});}
    }

    if(interaction.commandName==='stop'){
        await interaction.reply('봇 종료 중');
        process.exit(0);
    }

    if(interaction.commandName==='실시간정보'){
        const statusText = `Ping 실패: ${pingFailures}\nKMA 알람 전송 수: ${sentKMA.size}\nJMA 알람 전송 수: ${sentJMA.size}\n재난문자 전송 수: ${sentDisaster.size}`;
        return interaction.reply({
            embeds:[new EmbedBuilder().setTitle('실시간 정보').setDescription(statusText).setColor('#00FF00').setTimestamp()],
            ephemeral:true
        });
    }
});

/* ===== 시작 ===== */
client.once('ready', async()=>{
    console.log(`${client.user.tag} 온라인`);
    startPingLoop();
    startLoop();
});

client.login(TOKEN);