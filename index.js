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
  Routes
} from 'discord.js';

/* =========================
   1. 설정 및 상태 추적
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

const stats = {
  kma: { attempts: 0, status: 'idle' },
  jma: { attempts: 0, status: 'idle' },
  ndms: { attempts: 0, status: 'idle' }
};

/* =========================
   2. 안전한 유틸리티 함수
========================= */
// 디스코드 글자 수 제한 방어 로직
const truncate = (str, max) => (str && str.length > max) ? str.slice(0, max - 3) + '...' : (str || '내용 없음');

// 프로세스 종료 방어 (Global Error Catch)
process.on('uncaughtException', err => console.error('[FATAL] Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('[FATAL] Unhandled Rejection:', err));

/* =========================
   3. 데이터 저장소 (안전한 I/O)
========================= */
const sent = { kma: new Set(), jma: new Set(), ndms: new Set() };
const FILE_PATHS = {
  kma: path.join(CONFIG.SENT_DIR, 'kma.json'),
  jma: path.join(CONFIG.SENT_DIR, 'jma.json'),
  ndms: path.join(CONFIG.SENT_DIR, 'ndms.json')
};

let isSaving = { kma: false, jma: false, ndms: false };

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true }).catch(() => {});
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const data = await fs.readFile(p, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) list.forEach(id => sent[key].add(id));
    } catch {
      await fs.writeFile(p, '[]', 'utf8').catch(() => {});
    }
  }
}

// 충돌 방지를 위한 쓰기 잠금(Lock) 적용
async function saveStateSafe(key) {
  if (isSaving[key]) return; 
  isSaving[key] = true;
  try {
    const tmp = `${FILE_PATHS[key]}.tmp`;
    const dataStr = JSON.stringify([...sent[key]]);
    await fs.writeFile(tmp, dataStr, 'utf8');
    await fs.rename(tmp, FILE_PATHS[key]);
  } catch (err) {
    console.error(`[SAVE ERROR] ${key} 저장 실패:`, err.message);
  } finally {
    isSaving[key] = false;
  }
}

/* =========================
   4. 웹 서버 (Render 유지용)
========================= */
const app = express();
app.get('/', (_, res) => res.send('Bot Status: Online'));
app.get('/health', async (_, res) => {
  try {
    const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
    res.json({ outbound_ip: ipRes.data.ip, stats, uptime: Math.floor(process.uptime()) });
  } catch (e) {
    res.json({ outbound_ip: 'unknown', stats, uptime: Math.floor(process.uptime()) });
  }
});
const server = app.listen(CONFIG.PORT, () => console.log(`[HTTP] Port ${CONFIG.PORT}`));

/* =========================
   5. 디스코드 전송 래퍼
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function broadcast(payload) {
  for (const channelId of CONFIG.CHANNELS) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send(payload);
    } catch (e) {
      console.error(`[DISCORD SEND ERROR] Channel ${channelId}:`, e.message);
    }
  }
}

/* =========================
   6. 핵심 API 로직
========================= */
const api = axios.create({ timeout: 8000 }); // 무한 대기 방지 (8초 타임아웃)

// [기상청 - KMA]
async function fetchKMA() {
  if (!KMA_KEY) return;
  stats.kma.attempts++;
  try {
    const kstDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    const res = await api.get('http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg', {
      params: { serviceKey: KMA_KEY, numOfRows: 10, pageNo: 1, dataType: 'JSON', fromTmFc: kstDate, toTmFc: kstDate }
    });
    
    // 데이터가 이상하게 와도 터지지 않게 방어 배열화
    const rawItems = res.data?.response?.body?.items?.item;
    const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
    let hasNew = false;

    for (const e of items) {
      if (!e.tmEqk) continue;
      const id = `${e.tmEqk}_${e.loc}`;
      if (sent.kma.has(id)) continue;

      sent.kma.add(id);
      hasNew = true;

      const mag = Number(e.mt) || 0;
      const rem = e.rem || '';
      const isJapan = rem.includes('일본');
      const isForeign = rem.includes('국외') && !isJapan;

      // 멘션 규칙 적용
      const mentionEveryone = (!isForeign && mag >= 5.0);

      const embed = new EmbedBuilder()
        .setTitle(isJapan ? '🌋 일본 지진 발생 (KMA 분석)' : isForeign ? '🌍 국외 지진 발생' : '🌏 지진 발생 (대한민국)')
        .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
        .addFields(
          { name: '📍 위치', value: truncate(e.loc, 1024) }, 
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true }
        )
        .setTimestamp();

      await broadcast({ content: mentionEveryone ? '@everyone' : undefined, embeds: [embed] });
    }
    
    if (hasNew) await saveStateSafe('kma'); // 다 보내고 한 번만 저장
    stats.kma.status = 'ok';
  } catch (err) {
    stats.kma.status = 'error';
  }
}

// [일본 기상청 - JMA]
async function fetchJMA() {
  stats.jma.attempts++;
  try {
    const res = await api.get('https://www.jma.go.jp/bosai/quake/data/list.json');
    if (!Array.isArray(res.data)) throw new Error('Invalid JMA data');
    
    let hasNew = false;
    for (const e of res.data.slice(0, 5)) {
      if (!e.time || !e.place) continue;
      const id = `${e.time}_${e.place}`;
      if (sent.jma.has(id)) continue;

      const timeMs = new Date(e.time).getTime();
      if (isNaN(timeMs) || Date.now() - timeMs > 30 * 60000) continue;

      sent.jma.add(id);
      hasNew = true;

      const mag = Number(e.mag) || 0;
      const mentionEveryone = (mag >= 5.0);

      const embed = new EmbedBuilder()
        .setTitle('🌋 일본 지진 발생 (JMA)')
        .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
        .addFields(
          { name: '📍 위치', value: truncate(e.place, 1024) }, 
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true }
        );

      await broadcast({ content: mentionEveryone ? '@everyone' : undefined, embeds: [embed] });
    }
    
    if (hasNew) await saveStateSafe('jma');
    stats.jma.status = 'ok';
  } catch (err) {
    stats.jma.status = 'error';
  }
}

// [안전안내문자 - NDMS]
async function fetchNDMS() {
  if (!SAFETY_KEY) return false;
  stats.ndms.attempts++;
  try {
    const res = await api.get('https://safetydata.go.kr/V2/api/DSSP-IF-00247', {
      params: { serviceKey: SAFETY_KEY, returnType: 'json', numOfRows: 5, pageNo: 1 }
    });
    
    const items = res.data?.body?.[0]?.data || [];
    if (!Array.isArray(items)) throw new Error('Invalid NDMS format');

    let hasNew = false;
    for (const e of items) {
      const id = String(e.MD101_SN || e.SN);
      if (!id || id === 'undefined' || sent.ndms.has(id)) continue;

      const timeStr = String(e.CRT_DT || '').replace(/\//g, '-') + '+09:00';
      const timeMs = new Date(timeStr).getTime();
      
      // 2분 초과 시 패스
      if (isNaN(timeMs) || Date.now() - timeMs > 120_000) continue;

      sent.ndms.add(id);
      hasNew = true;

      const msg = truncate(e.MSG_CN, 4000); // 디스코드 Description 최대 4096자
      const isDisaster = msg.includes('재난문자');

      const embed = new EmbedBuilder()
        .setTitle(isDisaster ? '🚨 긴급/위급 재난 문자' : '📢 안전 안내 문자')
        .setColor(isDisaster ? 0xff0000 : 0xffcc00)
        .setDescription(msg)
        .addFields({ name: '📍 지역', value: truncate(e.RCPTN_RGN_NM || '전국', 1024) });

      await broadcast({ content: isDisaster ? '@everyone' : undefined, embeds: [embed] });
    }

    if (hasNew) await saveStateSafe('ndms');
    stats.ndms.status = 'ok';
    return true; // 정상 처리
  } catch (err) {
    stats.ndms.status = 'error';
    return false; // API 에러
  }
}

// [스케줄러: 절대 죽지 않는 무적 루프]
async function ndmsLoop() {
  let isSuccess = false;
  try {
    isSuccess = await fetchNDMS();
  } catch (e) {
    console.error('[NDMS FATAL]', e);
  } finally {
    // try에서 무슨 에러가 터지든 finally는 무조건 실행됨 -> 루프가 끊기지 않음
    const delay = isSuccess ? 120_000 : 3 * 3600_000;
    setTimeout(ndmsLoop, delay);
  }
}

/* =========================
   7. 봇 실행 및 명령어
========================= */
client.once('ready', async () => {
  console.log(`[SYSTEM] Bot Online: ${client.user.tag}`);
  await initStorage();
  
  setInterval(() => { fetchKMA(); fetchJMA(); }, CONFIG.POLL_INTERVAL);
  ndmsLoop();

  // 슬래시 명령어 등록
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  rest.put(Routes.applicationCommands(APPLICATION_ID), { body: [
    { name: '상태', description: 'API 연결 상태 확인' },
    { name: '청소', description: '기록 캐시 초기화' }
  ]}).catch(err => console.error('[REST ERROR]', err.message));
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (OWNER_ID && i.user.id !== OWNER_ID) return i.reply({ content: '권한 없음', ephemeral: true });

  if (i.commandName === '상태') {
    const icon = (s) => s === 'ok' ? '🟢' : '🔴';
    const embed = new EmbedBuilder()
      .setTitle('📊 봇 시스템 상태 리포트')
      .setColor(0x2b2d31)
      .addFields(
        { name: '기상청 (KMA)', value: `${icon(stats.kma.status)} 연결 상태 (${stats.kma.attempts}회 시도)`, inline: false },
        { name: '일본기상청 (JMA)', value: `${icon(stats.jma.status)} 연결 상태 (${stats.jma.attempts}회 시도)`, inline: false },
        { name: '안전안내문자 (NDMS)', value: `${icon(stats.ndms.status)} 연결 상태 (${stats.ndms.attempts}회 시도)`, inline: false }
      )
      .setFooter({ text: `Uptime: ${Math.floor(process.uptime() / 60)}분` })
      .setTimestamp();
    await i.reply({ embeds: [embed] });
  }

  if (i.commandName === '청소') {
    sent.kma.clear(); sent.jma.clear(); sent.ndms.clear();
    await Promise.all([saveStateSafe('kma'), saveStateSafe('jma'), saveStateSafe('ndms')]);
    await i.reply('🧹 봇의 메모리와 데이터 파일이 초기화되었습니다.');
  }
});

/* =========================
   8. 안전 종료 (Graceful Shutdown)
========================= */
async function shutdown() {
  console.log('[SYSTEM] 종료 신호 감지. 데이터를 저장하고 봇을 안전하게 종료합니다.');
  await Promise.all([saveStateSafe('kma'), saveStateSafe('jma'), saveStateSafe('ndms')]);
  client.destroy();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(DISCORD_TOKEN).catch(err => console.error('[LOGIN ERROR]', err.message));