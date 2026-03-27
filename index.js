import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

/* =========================
   1. 환경 설정 및 유효성 검사
========================= */
const { DISCORD_TOKEN, PORT, CHANNEL_IDS, KMA_KEY, SAFETY_KEY } = process.env;

if (!DISCORD_TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN이 .env 파일에 없습니다. 봇을 종료합니다.');
  process.exit(1);
}

const CONFIG = {
  PORT: Number(PORT) || 3000,
  SENT_DIR: path.resolve(process.cwd(), 'data'),
  CHANNELS: (CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  MS_NDMS: 2 * 60 * 1000,       // 2분
  MS_EQ: 5 * 60 * 1000,         // 5분
  MAX_CACHE_MS: 24 * 60 * 60 * 1000 // 24시간
};

const sent = { kma: new Map(), jma: new Map(), ndms: new Map() };
const stats = { kma: { status: '대기' }, jma: { status: '대기' }, ndms: { status: '대기' } };

/* =========================
   2. 코어 유틸리티
========================= */
const truncate = (str, max) => (str && str.length > max) ? str.slice(0, max - 3) + '...' : (str || '내용 없음');

// ✅ 구글 지도 공식 검색 URL로 수정
const createGoogleMapLink = (lat, lon, query) => {
  if (lat && lon) return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  if (query) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return null;
};

// ✅ 메모리 누수 방지 로직
const cleanupCache = () => {
  const now = Date.now();
  for (const type in sent) {
    for (const [id, time] of sent[type].entries()) {
      if (now - time > CONFIG.MAX_CACHE_MS) sent[type].delete(id);
    }
  }
};

/* =========================
   3. 안전한 데이터 저장소 (Atomic Write)
========================= */
const FILE_PATHS = Object.fromEntries(
  ['kma', 'jma', 'ndms'].map(k => [k, path.join(CONFIG.SENT_DIR, `${k}.json`)])
);

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true }).catch(() => {});
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const data = await fs.readFile(p, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) list.forEach(([id, time]) => sent[key].set(id, time));
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
    await fs.rename(tmpPath, FILE_PATHS[key]); // 원자적 덮어쓰기
  } catch (err) {
    console.error(`[SAVE ERROR ${key}]`, err.message);
  } finally {
    isSaving[key] = false;
  }
}

/* =========================
   4. API 통신 모듈 (비동기 에러 완벽 제어)
========================= */
const api = axios.create({ timeout: 10000 });

// ✅ NDMS: Axios 인코딩 우회를 위해 URL 하드코딩 결합
async function fetchNDMS() {
  if (!SAFETY_KEY) return false;
  cleanupCache();

  try {
    // 🔥 중요: 파라미터를 직접 문자열로 결합하여 Axios의 맘대로 인코딩을 방지합니다.
    const url = `https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=${SAFETY_KEY}&returnType=json&numOfRows=5&pageNo=1`;
    const res = await api.get(url);

    const items = res.data?.body?.[0]?.data || [];
    if (!Array.isArray(items)) {
      if (res.data?.rtnResultMsg) console.error(`[NDMS 응답 에러] ${res.data.rtnResultMsg}`);
      return true; // 구조가 없어도 봇이 죽지 않도록 true 반환 (다음 턴 대기)
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
    stats.ndms.status = '정상';
    return true;
  } catch (err) {
    stats.ndms.status = '에러';
    console.error('[NDMS FETCH ERROR]', err.response?.status || err.message);
    return false;
  }
}

// ✅ KMA (기상청 지진)
async function fetchKMA() {
  if (!KMA_KEY) return false;
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
        .setTitle('🌏 국내 지진 발생 (KMA)')
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
    stats.kma.status = '정상';
    return true;
  } catch (err) {
    stats.kma.status = '에러';
    return false;
  }
}

/* =========================
   5. 디스코드 & 시스템 실행
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

async function broadcast(payload) {
  if (!CONFIG.CHANNELS.length) return;
  for (const id of CONFIG.CHANNELS) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.isTextBased()) await ch.send(payload);
    } catch (e) {
      console.error(`[SEND ERROR] 채널(${id}) 전송 실패:`, e.message);
    }
  }
}

// 에러로 인해 프로세스가 죽는 것을 방지
process.on('uncaughtException', err => console.error('[FATAL EXCEPTION]', err));
process.on('unhandledRejection', err => console.error('[FATAL REJECTION]', err));

client.once('ready', async () => {
  console.log(`[SYSTEM] Bot Online: ${client.user.tag}`);
  await initStorage();

  // 재귀적 setTimeout을 사용하여 API 호출이 겹치는 것을 방지 (메모리 최적화)
  const loop = async (fn, delay) => {
    await fn();
    setTimeout(() => loop(fn, delay), delay);
  };

  loop(fetchNDMS, CONFIG.MS_NDMS);
  loop(fetchKMA, CONFIG.MS_EQ);
  // JMA 로직이 필요하시다면 위와 동일한 패턴으로 추가하시면 됩니다.
});

client.login(DISCORD_TOKEN);

// 간단한 상태 모니터링 웹 서버
express().get('/', (_, res) => res.json(stats)).listen(CONFIG.PORT, () => {
  console.log(`[SYSTEM] Web health-check running on port ${CONFIG.PORT}`);
});