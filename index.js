import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { XMLParser } from 'fast-xml-parser';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } from 'discord.js';

/* =========================
   1. 초기 설정 및 검증
========================= */
const { DISCORD_TOKEN, APPLICATION_ID, OWNER_ID, PORT, CHANNEL_IDS, KMA_KEY, SAFETY_KEY } = process.env;

if (!DISCORD_TOKEN) {
  console.error('[SYSTEM] DISCORD_TOKEN이 없습니다.');
  process.exit(1);
}

const CONFIG = {
  PORT: Number(PORT) || 3000,
  SENT_DIR: path.resolve(process.cwd(), 'data'),
  CHANNELS: (CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  MS_NDMS: 2 * 60 * 1000,           // 2분 (안내문자)
  MS_EQ: 5 * 60 * 1000,             // 5분 (지진)
  MAX_CACHE_MS: 24 * 60 * 60 * 1000 // 24시간 후 메모리 삭제
};

// Map을 사용한 타임스탬프 기반 메모리 관리
const sent = { kma: new Map(), jma: new Map(), ndms: new Map() };
const stats = { kma: { ok: 0, err: 0 }, jma: { ok: 0, err: 0 }, ndms: { ok: 0, err: 0 } };

/* =========================
   2. 유틸리티 (지도, 번역, 캐시정리)
========================= */
const truncate = (str, max) => (str && str.length > max) ? str.slice(0, max - 3) + '...' : (str || '내용 없음');

// ✅ 구글 지도 링크 수정 완료
const createGoogleMapLink = (lat, lon, query) => {
  if (lat && lon) return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  if (query) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return null;
};

// ✅ 메모리 관리: 오래된 캐시 삭제
const cleanupCache = () => {
  const now = Date.now();
  for (const type in sent) {
    for (const [id, time] of sent[type].entries()) {
      if (now - time > CONFIG.MAX_CACHE_MS) sent[type].delete(id);
    }
  }
};

// ✅ 일본어 번역
async function translateToKo(text) {
  if (!text) return '내용 없음';
  try {
    const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'ja', tl: 'ko', dt: 't', q: text },
      timeout: 5000
    });
    return res.data[0].map(x => x[0]).join('');
  } catch {
    return text;
  }
}

/* =========================
   3. 데이터 저장소 (Atomic 저장)
========================= */
const FILE_PATHS = Object.fromEntries(['kma', 'jma', 'ndms'].map(k => [k, path.join(CONFIG.SENT_DIR, `${k}.json`)]));

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true }).catch(() => {});
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const data = await fs.readFile(p, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) list.forEach(([id, time]) => sent[key].set(id, time || Date.now()));
    } catch {
      await fs.writeFile(p, '[]', 'utf8');
    }
  }
}

async function saveState(key) {
  try {
    const tmp = `${FILE_PATHS[key]}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...sent[key].entries()]), 'utf8');
    await fs.rename(tmp, FILE_PATHS[key]);
  } catch (e) { console.error(`[SAVE ERROR] ${key}`, e.message); }
}

/* =========================
   4. API 통신 설정 (차단 방어 핵심)
========================= */
const api = axios.create({
  timeout: 15000,
  headers: {
    // 🔥 실제 브라우저와 동일한 헤더를 보내 차단을 회피합니다.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  httpsAgent: new https.Agent({ 
    keepAlive: true, // 연결 유지로 ECONNRESET 방지
    rejectUnauthorized: false 
  })
});

// ✅ NDMS (안전안내문자)
async function fetchNDMS() {
  if (!SAFETY_KEY) return;
  cleanupCache();
  try {
    // 💡 키 인코딩 이슈를 피하기 위해 템플릿 리터럴로 직접 결합
    const url = `https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=${SAFETY_KEY}&returnType=json&numOfRows=5&pageNo=1`;
    const res = await api.get(url);
    const items = res.data?.body?.[0]?.data || [];

    let hasNew = false;
    for (const e of items) {
      const id = String(e.MD101_SN || e.SN);
      if (!id || sent.ndms.has(id)) continue;

      sent.ndms.set(id, Date.now());
      hasNew = true;

      const embed = new EmbedBuilder()
        .setTitle('📢 긴급 재난 문자')
        .setColor(0xFFBB00)
        .setDescription(`**[${e.DSSTR_SE_NM || '알림'}]**\n\n${truncate(e.MSG_CN, 4000)}`)
        .addFields({ name: '📍 수신 지역', value: e.RCV_AREA_NM || '전국', inline: true })
        .setFooter({ text: '행정안전부 안전안내문자' })
        .setTimestamp(new Date(e.CRT_DT?.replace(/\//g, '-')));

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveState('ndms');
    stats.ndms.ok++;
  } catch (err) {
    stats.ndms.err++;
    console.error(`[NDMS ERROR] ${err.code || err.message}`);
  }
}

// ✅ KMA (기상청 지진)
async function fetchKMA() {
  if (!KMA_KEY) return;
  try {
    const kst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    const url = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${KMA_KEY}&numOfRows=5&pageNo=1&dataType=JSON&fromTmFc=${kst}&toTmFc=${kst}`;
    const res = await api.get(url);
    const items = res.data?.response?.body?.items?.item;
    const itemList = Array.isArray(items) ? items : (items ? [items] : []);

    let hasNew = false;
    for (const e of itemList) {
      const id = `${e.tmEqk}_${e.loc}`;
      if (!e.tmEqk || sent.kma.has(id)) continue;

      sent.kma.set(id, Date.now());
      hasNew = true;

      const mag = Number(e.mt) || 0;
      const embed = new EmbedBuilder()
        .setTitle('🌏 지진 발생 (KMA)')
        .setColor(mag >= 5 ? 0xFF0000 : 0x00AAFF)
        .addFields([
          { name: '📍 위치', value: e.loc },
          { name: '📏 규모', value: `M ${mag.toFixed(1)}`, inline: true },
          { name: '🗺️ 지도', value: `[구글 지도 보기](${createGoogleMapLink(null, null, e.loc)})`, inline: true }
        ]).setTimestamp();

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveState('kma');
    stats.kma.ok++;
  } catch (err) { stats.kma.err++; }
}

// ✅ JMA (일본 지진/화산)
async function fetchJMA() {
  try {
    const res = await api.get('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml');
    const parser = new XMLParser();
    const jsonObj = parser.parse(res.data);
    const entries = jsonObj.feed?.entry;
    const items = Array.isArray(entries) ? entries.slice(0, 5) : (entries ? [entries] : []);

    let hasNew = false;
    for (const e of items) {
      if (!e.id || sent.jma.has(e.id)) continue;
      sent.jma.set(e.id, Date.now());
      hasNew = true;

      const titleKo = await translateToKo(e.title);
      const isVolcano = e.title.includes('火山') || e.title.includes('噴火');

      const embed = new EmbedBuilder()
        .setTitle(isVolcano ? '🌋 일본 화산 정보 (JMA)' : '🌏 일본 지진 발생 (JMA)')
        .setColor(isVolcano ? 0xFF4500 : 0x5865F2)
        .setDescription(await translateToKo(e.content))
        .addFields([
          { name: '📍 제목', value: titleKo },
          { name: '🗺️ 지도', value: `[구글 지도 보기](${createGoogleMapLink(null, null, titleKo)})`, inline: true }
        ]).setTimestamp(new Date(e.updated));

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveState('jma');
    stats.jma.ok++;
  } catch (err) { stats.jma.err++; }
}

/* =========================
   5. 실행 및 인터랙션
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function broadcast(payload) {
  for (const id of CONFIG.CHANNELS) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.isTextBased()) await ch.send(payload);
    } catch {}
  }
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  await initStorage();

  // 루프 실행
  const startLoop = (fn, ms) => { fn(); setInterval(fn, ms); };
  startLoop(fetchNDMS, CONFIG.MS_NDMS);
  startLoop(fetchKMA, CONFIG.MS_EQ);
  startLoop(fetchJMA, CONFIG.MS_EQ);

  // 커맨드 등록
  if (APPLICATION_ID) {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(APPLICATION_ID), {
      body: [
        { name: '상태', description: '봇 연결 상태 확인' },
        { name: '청소', description: '캐시 초기화' }
      ]
    }).catch(console.error);
  }
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (OWNER_ID && i.user.id !== OWNER_ID) return i.reply({ content: '권한 없음', ephemeral: true });

  if (i.commandName === '상태') {
    const embed = new EmbedBuilder()
      .setTitle('📊 봇 시스템 상태')
      .addFields(
        { name: '안전안내문자', value: `성공: ${stats.ndms.ok} / 에러: ${stats.ndms.err}`, inline: true },
        { name: '국내지진', value: `성공: ${stats.kma.ok} / 에러: ${stats.kma.err}`, inline: true },
        { name: '일본지진', value: `성공: ${stats.jma.ok} / 에러: ${stats.jma.err}`, inline: true }
      );
    await i.reply({ embeds: [embed] });
  }

  if (i.commandName === '청소') {
    Object.values(sent).forEach(m => m.clear());
    await Promise.all(['kma', 'jma', 'ndms'].map(saveState));
    await i.reply('🧹 캐시 데이터가 모두 삭제되었습니다.');
  }
});

// 웹 서버 (Render 유지용)
express().get('/', (_, res) => res.json({ status: 'running', stats })).listen(CONFIG.PORT);

process.on('uncaughtException', (e) => console.error('[CRITICAL]', e.message));
process.on('unhandledRejection', (e) => console.error('[CRITICAL]', e.message));

client.login(DISCORD_TOKEN);