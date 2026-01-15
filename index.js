require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const axios = require('axios');

/* ===== 설정 ===== */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const APPLICATION_ID = process.env.APPLICATION_ID;

/* ===== KMA API ===== */
const KMA_API_KEY = '24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40';
let currentKmaFrom = new Date('2026-01-12');
let currentKmaTo = new Date('2026-01-12');

function formatKmaDate(d){ return d.toISOString().slice(0,10).replace(/-/g,''); }
function advanceKmaDay(){ currentKmaFrom.setDate(currentKmaFrom.getDate()+1); currentKmaTo.setDate(currentKmaTo.getDate()+1); }
function getKmaUrl(){ 
    return `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${KMA_API_KEY}&numOfRows=10&pageNo=1&fromTmFc=${formatKmaDate(currentKmaFrom)}&toTmFc=${formatKmaDate(currentKmaTo)}`; 
}

/* ===== 기타 API ===== */
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
const rest = new REST({ version: '10' }).setToken(TOKEN);

/* ===== 슬래시 명령어 등록 ===== */
const commands = [
    new SlashCommandBuilder()
        .setName('청소')
        .setDescription('메시지 삭제')
        .addIntegerOption(o=>o.setName('수량').setDescription('1~100').setRequired(true)),
    new SlashCommandBuilder()
        .setName('실시간정보')
        .setDescription('봇 상태 조회'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('봇 종료')
].map(c=>c.toJSON());

async function registerCommands(){
    try{
        await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: commands });
        console.log('슬래시 명령어 등록 완료');
    }catch(e){ console.error('슬래시 등록 실패', e); }
}

/* ===== 상태 ===== */
let sentKMA = new Set();
let sentJMA = new Set();
let sentDisaster = new Set();
let pingFailures = 0;

/* ===== 임베드 전송 ===== */
async function sendEmbed(title, desc, color='#FFFF00') {
    if(!desc || desc.trim()==='') return;
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if(!channel) return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(desc)
            .setColor(color)
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch(e) { console.error('임베드 전송 실패', e.message); }
}

/* ===== API fetch ===== */
async function fetchKMA(){ try{ const res = await axios.get(getKmaUrl(), { params:{disp:1, help:0} }); return res.data?.response?.body?.items?.item||[]; }catch(e){ pingFailures++; return []; } }
async function fetchJMA(){ try{ const res = await axios.get(JMA_URL); return res.data||[]; }catch(e){ pingFailures++; return []; } }
async function fetchDisaster(){ try{ const res = await axios.get(DISASTER_URL); return res.data?.response?.body?.items?.item||[]; }catch(e){ pingFailures++; return []; } }

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

/* ===== 메인 루프 60초 ===== */
function startLoop(){
    setInterval(async()=>{

        /* KMA 4 이상 */
        const kmaData = await fetchKMA();
        for(const eq of kmaData){
            const key = `${eq.earthquakeNo||''}-${eq.eqPlace||''}`;
            if(sentKMA.has(key)) continue;
            if(!eq.eqPlace || !eq.maxInten) continue;
            if(Number(eq.maxInten)<4) continue;
            sentKMA.add(key);
            const desc = `위치: ${eq.eqPlace}\n규모: ${eq.eqMagnitude||'정보없음'}\n진도: ${eq.maxInten}`;
            await sendEmbed('🇰🇷 KMA 지진 🔶', desc, '#FFA500');
        }
        advanceKmaDay();

        /* JMA 5+ */
        const jmaData = await fetchJMA();
        for(const eq of jmaData){
            const key = `${eq.code||''}-${eq.place||''}`;
            if(sentJMA.has(key)) continue;
            if(!eq.place || !eq.intensity || !eq.magnitude) continue;
            sentJMA.add(key);
            const is5Plus = eq.intensity.includes('5+');
            let desc = `위치: ${eq.place}\n규모: ${eq.magnitude}\n최대진도: ${eq.intensity}`;
            const title = is5Plus ? '🇯🇵 JMA 지진 🔴' : '🇯🇵 JMA 지진 ⚪';
            if(is5Plus) desc = `@everyone\n${desc}`;
            await sendEmbed(title, desc, is5Plus ? '#FF0000' : '#FFFFFF');
        }

        /* 재난문자 (긴급, 위급만) */
        const disasterData = await fetchDisaster();
        for(const d of disasterData){
            const key = `${d.msgNo||''}`;
            if(sentDisaster.has(key)) continue;
            if(!d.msg || !d.level) continue;
            if(d.level!=='긴급' && d.level!=='위급') continue;
            sentDisaster.add(key);
            const title = '⚠️ 재난 알림';
            const msg = `@everyone\n${d.msg}`;
            await sendEmbed(title, msg, '#1E90FF');
        }

    }, 60_000);
}

/* ===== 슬래시 처리 ===== */
client.on('interactionCreate', async interaction=>{
    if(!interaction.isCommand()) return;

    if(interaction.commandName==='청소'){
        const n = interaction.options.getInteger('수량');
        if(n<1||n>100) return interaction.reply({content:'1~100만 가능합니다.', ephemeral:true});
        try{
            const msgs = await interaction.channel.messages.fetch({limit:n});
            await interaction.channel.bulkDelete(msgs,true);
            return interaction.reply({content:`${n}개 메시지 삭제 완료`, ephemeral:true});
        }catch{
            return interaction.reply({content:'메시지 삭제 실패', ephemeral:true});
        }
    }

    if(interaction.commandName==='실시간정보'){
        const statusText = `Ping 실패: ${pingFailures}\nKMA 연결: 정상\nJMA 연결: 정상`;
        return interaction.reply({embeds:[new EmbedBuilder().setTitle('실시간 정보').setDescription(statusText).setColor('#00FF00').setTimestamp()], ephemeral:true});
    }

    if(interaction.commandName==='stop'){
        await interaction.reply('봇 종료 중');
        process.exit(0);
    }
});

/* ===== 시작 ===== */
client.once('ready', async()=>{
    console.log(`${client.user.tag} 온라인`);
    await registerCommands();
    startPingLoop();
    startLoop();
});

client.login(TOKEN);