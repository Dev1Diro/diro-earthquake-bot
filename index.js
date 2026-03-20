/*************************************************
 * Earthquake & Safety Alert Bot (Production Ready)
 * - 안정화 및 예외 처리 강화 버전
 *************************************************/

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  ActivityType
} from 'discord.js';

/* =========================
   CONFIG & ENV VALIDATION
========================= */
const {
  DISCORD_TOKEN, APPLICATION_ID, OWNER_ID, PORT, CHANNEL_IDS,
  KMA_KEY, SAFETY_KEY
} = process.env;

const CONFIG = {
  PORT: Number(PORT) || 3000,
  POLL_INTERVAL: 60_000, // 지진 체크 1분
  SENT_DIR: path.resolve(process.cwd(), 'data'),
  CHANNELS: (CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
};

// 서비스 상태 추적
const stats = {
  kma: { attempts: 0, status: 'idle', last_ok: null },
  jma: { attempts: 0, status: 'idle', last_ok: null },
  ndms: { attempts: 0, status: 'idle', last_ok: null }
};

/* =========================
   STATE MANAGEMENT (File)
========================= */
const sent = { kma: new Set(), jma: new Set(), ndms: new Set() };
const FILE_PATHS = {
  kma: path.join(CONFIG.SENT_DIR, 'kma.json'),
  jma: path.join(CONFIG.SENT_DIR, 'jma.json'),
  ndms: path.join(CONFIG.SENT_DIR, 'ndms.json')
};

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true });
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const data = await fs.readFile(p, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) list.forEach(id => sent[key].add(id));
    } catch {
      await fs.writeFile(p, '[]', 'utf8');
    }
  }
}

async function saveState(key) {
  try {
    const tmp = `${FILE_PATHS[key]}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...sent[key]]), 'utf8');
    await fs.rename(tmp, FILE_PATHS[key]);
  } catch (err) {
    console.error(`[STORAGE ERROR] ${key} 저장 실패:`, err.message);
  }
}

/* =========================
   HTTP SERVER (Health)
========================= */
const app = express();
app.get('/', (_, res) => res.send('Bot Status: Online'));
app.get('/health', async (_, res) => {
  const ip = await axios.get('https://api.ipify.org?format=json').then(r => r.data.ip).catch(() => 'unknown');
  res.json({ ip, stats, uptime: process.uptime() });
});
app.listen(CONFIG.PORT, () => console.log(`[HTTP] Server on ${CONFIG.PORT}`));

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  retryLimit: 5
});

async function sendToAll(payload, kind, id) {
  sent[kind].add(id);
  await saveState(kind);

  for (const channelId of CONFIG.CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send(payload);
    } catch (e) {
      console.error(`[DISCORD SEND ERROR] ${channelId}:`, e.message);
    }
  }
}

/* =========================
   CORE LOGIC (APIs)
========================= */
const api = axios.create({ timeout: 8000 });

// 1. 기상청 지진 (KMA)
async function fetchKMA() {
  if (!KMA_KEY) return;
  stats.kma.attempts++;
  try {
    const nowKST = new Date(Date.now() + 9 * 3600000);
    const dateStr = nowKST.toISOString().slice(0, 10).replace(/-/g, '');
    const res = await api.get('http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg', {
      params: { serviceKey: KMA_KEY, numOfRows: 10, pageNo: 1, dataType: 'JSON', fromTmFc: dateStr, toTmFc: dateStr }
    });

    const items = res.data?.response?.body?.items?.item;
    if (Array.isArray(items)) {
      for (const e of items) {
        const id = `${e.tmEqk}_${e.loc}`;
        if (sent.kma.has(id)) continue;

        const mag = Number(e.mt);
        const isForeign = (e.rem || '').includes('국외') && !(e.rem || '').includes('일본');
        const isJapan = (e.rem || '').includes('일본');
        
        // 멘션 조건: 한국/일본 규모 5.0 이상만
        const shouldMention = (isJapan || !isForeign) && mag >= 5.0;

        const embed = new EmbedBuilder()
          .setTitle(isJapan ? '🌋 일본 지진 발생' : isForeign ? '🌍 국외 지진 발생' : '🌏 지진 발생 (국내)')
          .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
          .addFields(
            { name: '📍 위치', value: e.loc || '정보 없음' },
            { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true },
            { name: '🕒 시각', value: e.tmEqk ? String(e.tmEqk) : '정보 없음', inline: true }
          )
          .setTimestamp();

        await sendToAll({ content: shouldMention ? '@everyone' : undefined, embeds: [embed] }, 'kma', id);
      }
    }
    stats.kma.status = 'ok';
    stats.kma.last_ok = new Date().toISOString();
  } catch (err) {
    stats.kma.status = 'error';
    console.error('[API ERROR KMA]', err.message);
  }
}

// 2. 일본 지진 (JMA)
async function fetchJMA() {
  stats.jma.attempts++;
  try {
    const res = await api.get('https://www.jma.go.jp/bosai/quake/data/list.json');
    const latest = res.data?.slice(0, 5) || [];
    for (const e of latest) {
      const id = `${e.time}_${e.place}`;
      if (sent.jma.has(id)) continue;

      const mag = Number(e.mag);
      const time = new Date(e.time).getTime();
      if (Date.now() - time > 30 * 60000) continue; // 30분 경과 스킵

      const embed = new EmbedBuilder()
        .setTitle('🌋 일본 지진 발생 (JMA)')
        .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
        .addFields(
          { name: '📍 위치', value: e.place },
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true },
          { name: '💥 진도', value: e.maxi || '-', inline: true }
        )
        .setTimestamp(time);

      await sendToAll({ content: mag >= 5.0 ? '@everyone' : undefined, embeds: [embed] }, 'jma', id);
    }
    stats.jma.status = 'ok';
    stats.jma.last_ok = new Date().toISOString();
  } catch (err) {
    stats.jma.status = 'error';
    console.error('[API ERROR JMA]', err.message);
  }
}

// 3. 안전안내문자 (NDMS)
async function fetchNDMS() {
  if (!SAFETY_KEY) return false;
  stats.ndms.attempts++;
  try {
    const res = await api.get('https://safetydata.go.kr/V2/api/DSSP-IF-00247', {
      params: { serviceKey: SAFETY_KEY, returnType: 'json', numOfRows: 5, pageNo: 1 }
    });

    const items = res.data?.body?.[0]?.data || [];
    if (!Array.isArray(items)) throw new Error('Invalid NDMS Format');

    for (const e of items) {
      const id = String(e.MD101_SN || e.SN);
      if (sent.ndms.has(id)) continue;

      const msg = e.MSG_CN || '';
      const time = new Date(String(e.CRT_DT || '').replace(/\//g, '-') + '+09:00').getTime();
      
      // 최근 2분 이내 데이터만 전송
      if (isNaN(time) || Date.now() - time > 120_000) continue;

      const isDisaster = msg.includes('재난문자');
      const embed = new EmbedBuilder()
        .setTitle(isDisaster ? '🚨 긴급/위급 재난 문자' : '📢 안전 안내 문자')
        .setColor(isDisaster ? 0xff0000 : 0xffcc00)
        .setDescription(msg)
        .addFields({ name: '📍 지역', value: e.RCPTN_RGN_NM || '전국' })
        .setFooter({ text: '행정안전부' });

      await sendToAll({ content: isDisaster ? '@everyone' : undefined, embeds: [embed] }, 'ndms', id);
    }
    stats.ndms.status = 'ok';
    stats.ndms.last_ok = new Date().toISOString();
    return true;
  } catch (err) {
    stats.ndms.status = 'error';
    console.error('[API ERROR NDMS]', err.message);
    return false;
  }
}

/* =========================
   SCHEDULER LOOP
========================= */
let ndmsTimer = null;
async function ndmsLoop() {
  const success = await fetchNDMS();
  // 성공 시 2분(120,000ms), 실패 시 3시간(10,800,000ms)
  const delay = success ? 120_000 : 3 * 3600_000;
  ndmsTimer = setTimeout(ndmsLoop, delay);
}

client.once('ready', async () => {
  console.log(`[SYSTEM] Logged in as ${client.user.tag}`);
  client.user.setActivity('재난 상황 감시 중', { type: ActivityType.Watching });

  await initStorage();

  // 지진 스케줄러 (1분)
  setInterval(() => {
    fetchKMA();
    fetchJMA();
  }, CONFIG.POLL_INTERVAL);

  // 안전문자 스케줄러 (가변 루프)
  ndmsLoop();

  // 슬래시 명령어 등록
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: [
      { name: '상태', description: '서비스 연결 상태 확인' },
      { name: '청소', description: '기록 캐시 초기화 (관리자전용)' }
    ]});
  } catch (e) { console.error('[REST ERROR]', e.message); }
});

/* =========================
   INTERACTION HANDLER
========================= */
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (OWNER_ID && i.user.id !== OWNER_ID) return i.reply({ content: '권한이 없습니다.', ephemeral: true });

  if (i.commandName === '상태') {
    const icon = (s) => s === 'ok' ? '🟢' : (s === 'idle' ? '⚪' : '🔴');
    const embed = new EmbedBuilder()
      .setTitle('📊 시스템 가동 현황')
      .setColor(0x2f3136)
      .addFields(
        { name: '기상청 (KMA)', value: `${icon(stats.kma.status)} 시도: ${stats.kma.attempts}회`, inline: true },
        { name: '일본 (JMA)', value: `${icon(stats.jma.status)} 시도: ${stats.jma.attempts}회`, inline: true },
        { name: '안전문자 (NDMS)', value: `${icon(stats.ndms.status)} 시도: ${stats.ndms.attempts}회`, inline: true }
      )
      .setTimestamp();
    await i.reply({ embeds: [embed] });
  }

  if (i.commandName === '청소') {
    sent.kma.clear(); sent.jma.clear(); sent.ndms.clear();
    await Promise.all([saveState('kma'), saveState('jma'), saveState('ndms')]);
    await i.reply('🧹 전송 기록이 초기화되었습니다.');
  }
});

/* =========================
   FINALIZE
========================= */
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED]', reason));
client.login(DISCORD_TOKEN);