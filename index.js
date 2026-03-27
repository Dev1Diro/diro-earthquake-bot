import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { XMLParser } from 'fast-xml-parser';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } from 'discord.js';

/* =========================
   1. 환경 설정 및 유효성 검사
========================= */
const { DISCORD_TOKEN, APPLICATION_ID, OWNER_ID, PORT, CHANNEL_IDS, KMA_KEY, SAFETY_KEY } = process.env;

if (!DISCORD_TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN이 .env 파일에 없습니다.');
  process.exit(1);
}

const CONFIG = {
  PORT: Number(PORT) || 3000,
  SENT_DIR: path.resolve(process.cwd(), 'data'),
  CHANNELS: (CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  MS_NDMS: 2 * 60 * 1000,           // 2분 간격 (재난문자)
  MS_EQ: 5 * 60 * 1000,             // 5분 간격 (지진)
  MAX_CACHE_MS: 24 * 60 * 60 * 1000 // 24시간 후 캐시 삭제 (메모리 관리)
};

const stats = { kma: { attempts: 0, status: '대기 중' }, jma: { attempts: 0, status: '대기 중' }, ndms: { attempts: 0, status: '대기 중' } };
const sent = { kma: new Map(), jma: new Map(), ndms: new Map() };

/* =========================
   2. 코어 유틸리티
========================= */
const truncate = (str, max) => (str && str.length > max) ? str.slice(0, max - 3) + '...' : (str || '내용 없음');

// ✅ 공식 구글 지도 링크 포맷으로 완벽 수정
const createGoogleMapLink = (lat, lon, query) => {
  if (lat && lon) return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  if (query) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return null;
};

// ✅ 메모리 누수 방지 (24시간 지난 데이터 자동 삭제)
const cleanupCache = () => {
  const now = Date.now();
  for (const type in sent) {
    for (const [id, time] of sent[type].entries()) {
      if (now - time > CONFIG.MAX_CACHE_MS) sent[type].delete(id);
    }
  }
};

// ✅ 일본어 -> 한국어 번역 (안정성 강화)
async function translateToKo(text) {
  if (!text) return '내용 없음';
  try {
    const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'ja', tl: 'ko', dt: 't', q: text },
      timeout: 4000
    });
    return res.data[0].map(x => x[0]).join('');
  } catch {
    return `[번역실패] ${text}`;
  }
}

/* =========================
   3. 안전한 데이터 저장 (Atomic Write)
========================= */
const FILE_PATHS = {
  kma: path.join(CONFIG.SENT_DIR, 'kma.json'),
  jma: path.join(CONFIG.SENT_DIR, 'jma.json'),
  ndms: path.join(CONFIG.SENT_DIR, 'ndms.json')
};

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true }).catch(() => {});
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const data = await fs.readFile(p, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) list.forEach(([id, time]) => sent[key].set(id, time || Date.now()));
    } catch {
      await fs.writeFile(p, '[]', 'utf8').catch(() => {});
    }
  }
}

let isSaving = { kma: false, jma: false, ndms: false };
async function saveStateSafe(key) {
  if (isSaving[key]) return;
  isSaving[key] = true;
  try {
    const tmpPath = `${FILE_PATHS[key]}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify([...sent[key].entries()]), 'utf8');
    await fs.rename(tmpPath, FILE_PATHS[key]);
  } catch (err) {
    console.error(`[SAVE ERROR ${key}]`, err.message);
  } finally {
    isSaving[key] = false;
  }
}

/* =========================
   4. API 통신 모듈 (ECONNRESET 완벽 방어)
========================= */
const api = axios.create({ 
  timeout: 15000,
  // 🔥 핵심 1: 브라우저 위장 (공공데이터 서버의 봇 차단 방어)
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  },
  // 🔥 핵심 2: 연결 유지 강제 (Render 환경의 잦은 끊김 방어)
  httpsAgent: new https.Agent({ 
    keepAlive: true,
    rejectUnauthorized: false
  })
});

// ✅ NDMS (안전안내문자) - Axios 자동 인코딩 회피용 하드코딩 URL 결합
async function fetchNDMS() {
  if (!SAFETY_KEY) return false;
  stats.ndms.attempts++;
  cleanupCache();

  try {
    const url = `https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=${SAFETY_KEY}&returnType=json&numOfRows=5&pageNo=1`;
    const res = await api.get(url);

    const items = res.data?.body?.[0]?.data || [];
    if (!Array.isArray(items)) {
      if (res.data?.rtnResultMsg) console.warn(`[NDMS MSG] ${res.data.rtnResultMsg}`);
      return true; 
    }

    let hasNew = false;
    for (const e of items) {
      const id = String(e.MD101_SN || e.SN);
      if (!id || sent.ndms.has(id)) continue;

      sent.ndms.set(id, Date.now());
      hasNew = true;

      const embed = new EmbedBuilder()
        .setTitle('📢 긴급 재난 문자')
        .setColor(0xffcc00)
        .setDescription(`**[${e.DSSTR_SE_NM || '알림'}]**\n\n${truncate(e.MSG_CN, 4000)}`)
        .addFields({ name: '📍 지역', value: e.RCV_AREA_NM || '전국', inline: true })
        .setTimestamp(new Date(e.CRT_DT?.replace(/\//g, '-')));

      await broadcast({ embeds: [embed] });
    }

    if (hasNew) await saveStateSafe('ndms');
    stats.ndms.status = '정상 (OK)';
    return true;
  } catch (err) {
    stats.ndms.status = `에러 (${err.code || err.response?.status})`;
    if (err.code === 'ECONNRESET') console.error('[NDMS] 서버 강제 연결 종료 (ECONNRESET). 재시도 예정.');
    else console.error('[NDMS FETCH ERROR]', err.message);
    return false;
  }
}

// ✅ KMA (한국 기상청 지진)
async function fetchKMA() {
  if (!KMA_KEY) return false;
  stats.kma.attempts++;
  try {
    const kstDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    const url = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${KMA_KEY}&numOfRows=5&pageNo=1&dataType=JSON&fromTmFc=${kstDate}&toTmFc=${kstDate}`;
    
    const res = await api.get(url);
    const rawItems = res.data?.response?.body?.items?.item;
    const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);

    let hasNew = false;
    for (const e of items) {
      if (!e.tmEqk) continue;
      const id = `${e.tmEqk}_${e.loc}`;
      if (sent.kma.has(id)) continue;

      sent.kma.set(id, Date.now());
      hasNew = true;

      const mag = Number(e.mt) || 0;
      const embed = new EmbedBuilder()
        .setTitle('🌏 지진 발생 (KMA)')
        .setColor(mag >= 5 ? 0xff0000 : 0x0099ff)
        .addFields([
          { name: '📍 위치', value: truncate(e.loc, 1024) },
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true },
          { name: '🗺️ 지도', value: `[구글 지도 보기](${createGoogleMapLink(null, null, e.loc)})` }
        ])
        .setTimestamp();

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveStateSafe('kma');
    stats.kma.status = '정상 (OK)';
    return true;
  } catch (err) {
    stats.kma.status = '에러';
    return false;
  }
}

// ✅ JMA (일본 기상청 지진/화산)
async function fetchJMA() {
  stats.jma.attempts++;
  try {
    const res = await api.get('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml');
    const parser = new XMLParser();
    const jsonObj = parser.parse(res.data);
    const entries = jsonObj.feed?.entry;
    const items = Array.isArray(entries) ? entries.slice(0, 5) : (entries ? [entries] : []);

    let hasNew = false;
    for (const e of items) {
      const id = e.id;
      if (!id || sent.jma.has(id)) continue;

      sent.jma.set(id, Date.now());
      hasNew = true;

      const titleKo = await translateToKo(e.title);
      const contentKo = await translateToKo(e.content);
      const isVolcano = e.title.includes('火山') || e.title.includes('噴火');

      const embed = new EmbedBuilder().setTimestamp(new Date(e.updated));

      if (isVolcano) {
        embed.setTitle('🌋 일본 화산 정보 (JMA)').setColor(0xff4500)
             .addFields([{ name: '📍 제목', value: truncate(titleKo, 1024) }, { name: '📝 내용', value: truncate(contentKo, 1024) }]);
      } else {
        embed.setTitle('🌏 일본 지진 발생 (JMA)').setColor(0x0099ff)
             .addFields([
               { name: '📍 제목', value: truncate(titleKo, 1024) },
               { name: '📝 내용', value: truncate(contentKo, 1024) },
               { name: '🗺️ 지도', value: `[구글 지도 보기](${createGoogleMapLink(null, null, titleKo)})` }
             ]);
      }
      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveStateSafe('jma');
    stats.jma.status = '정상 (OK)';
    return true;
  } catch (err) {
    stats.jma.status = '에러';
    return false;
  }
}

/* =========================
   5. 디스코드 봇 및 시스템 실행
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function broadcast(payload) {
  for (const id of CONFIG.CHANNELS) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.isTextBased()) await ch.send(payload);
    } catch (e) { console.error(`[SEND ERROR] 채널(${id}) 전송 실패:`, e.message); }
  }
}

// 봇이 갑작스러운 에러로 죽지 않도록 보호막 추가
process.on('uncaughtException', err => console.error('[FATAL EXCEPTION]', err));
process.on('unhandledRejection', err => console.error('[FATAL REJECTION]', err));

client.once('ready', async () => {
  console.log(`[SYSTEM] Bot Online: ${client.user.tag}`);
  await initStorage();

  // 재귀적 setTimeout을 활용한 무한 루프 (API 과부하 방지)
  const loop = async (fn, delay) => {
    await fn();
    setTimeout(() => loop(fn, delay), delay);
  };

  loop(fetchNDMS, CONFIG.MS_NDMS);
  loop(fetchKMA, CONFIG.MS_EQ);
  loop(fetchJMA, CONFIG.MS_EQ);

  // 슬래시 명령어 등록
  if (APPLICATION_ID) {
    try {
      const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
      await rest.put(Routes.applicationCommands(APPLICATION_ID), {
        body: [
          { name: '상태', description: 'API 연결 상태 확인' },
          { name: '청소', description: '기록 캐시 초기화' }
        ]
      });
      console.log('[SYSTEM] Global commands registered.');
    } catch (err) { console.error('[SYSTEM] Command registration failed:', err.message); }
  }
});

// 명령어 처리 로직 (Map 초기화 로직 반영)
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (OWNER_ID && i.user.id !== OWNER_ID) return i.reply({ content: '권한이 없습니다.', ephemeral: true });

  if (i.commandName === '상태') {
    const embed = new EmbedBuilder().setTitle('📊 시스템 상태')
      .addFields(
        { name: 'KMA (기상청)', value: `${stats.kma.status}\n호출: ${stats.kma.attempts}회`, inline: true },
        { name: 'JMA (일본)', value: `${stats.jma.status}\n호출: ${stats.jma.attempts}회`, inline: true },
        { name: 'NDMS (안전안내)', value: `${stats.ndms.status}\n호출: ${stats.ndms.attempts}회`, inline: true }
      ).setTimestamp();
    await i.reply({ embeds: [embed] });
  }

  if (i.commandName === '청소') {
    sent.kma.clear();
    sent.jma.clear();
    sent.ndms.clear();
    await Promise.all([saveStateSafe('kma'), saveStateSafe('jma'), saveStateSafe('ndms')]);
    await i.reply({ content: '🧹 모든 캐시 메모리와 저장 파일이 초기화되었습니다.', ephemeral: true });
  }
});

// 웹 서버 (Render Port 바인딩 및 상태 모니터링)
const app = express();
app.get('/', (_, res) => res.json({ bot_status: 'online', up_time: process.uptime(), stats }));
app.listen(CONFIG.PORT, () => console.log(`[SYSTEM] Web health-check running on port ${CONFIG.PORT}`));

client.login(DISCORD_TOKEN);