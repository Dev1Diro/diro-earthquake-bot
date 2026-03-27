import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { XMLParser } from 'fast-xml-parser';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } from 'discord.js';

/* =========================
   1. 초기 설정
========================= */
const {
  DISCORD_TOKEN, APPLICATION_ID, OWNER_ID,
  PORT, CHANNEL_IDS, KMA_KEY, SAFETY_KEY
} = process.env;

if (!DISCORD_TOKEN) { console.error('[SYSTEM] DISCORD_TOKEN이 없습니다.'); process.exit(1); }

const CONFIG = {
  PORT:         Number(PORT) || 3000,
  SENT_DIR:     path.resolve(process.cwd(), 'data'),
  CHANNELS:     (CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  MS_NDMS:      2  * 60 * 1000,
  MS_EQ:        5  * 60 * 1000,
  MAX_CACHE_MS: 24 * 60 * 60 * 1000,
  RETRY_DELAYS: [3000, 8000, 20000],   // 재시도 간격 (ms)
  ERR_COOLDOWN: 10 * 60 * 1000,        // 동일 에러 재알림 최소 간격 (10분)
};

// 상태 저장
const sent      = { kma: new Map(), jma: new Map(), ndms: new Map() };
const stats     = { kma: { ok:0, err:0 }, jma: { ok:0, err:0 }, ndms: { ok:0, err:0 } };
const lastFetch = { kma: null, jma: null, ndms: null };
const lastErrMsg= { kma: '', jma: '', ndms: '' };   // 중복 에러 방지
const lastErrAt = { kma: 0,  jma: 0,  ndms: 0  };
const xlCache   = new Map();   // 번역 캐시

/* =========================
   2. 유틸리티
========================= */
const truncate = (str, max) =>
  str && str.length > max ? str.slice(0, max - 3) + '...' : (str || '내용 없음');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const kstNow = () => new Date(Date.now() + 9 * 3600_000);

const fmtDate = d => {
  if (!d) return '-';
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : dt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
};

const createMapLink = (lat, lon, query) => {
  if (lat && lon) return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  if (query)      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return 'https://www.google.com/maps';
};

const cleanupCache = () => {
  const now = Date.now();
  for (const t of Object.keys(sent))
    for (const [id, ts] of sent[t]) if (now - ts > CONFIG.MAX_CACHE_MS) sent[t].delete(id);
};

// 규모별 색상 + 이모지
const magMeta = mag => {
  if (mag >= 7.0) return { color: 0x7B0000, emoji: '🆘' };
  if (mag >= 6.0) return { color: 0xFF0000, emoji: '🔴' };
  if (mag >= 5.0) return { color: 0xFF6600, emoji: '🟠' };
  if (mag >= 4.0) return { color: 0xFFAA00, emoji: '🟡' };
  if (mag >= 3.0) return { color: 0x00AAFF, emoji: '🔵' };
  return           { color: 0x888888, emoji: '⚪' };
};

/* =========================
   3. 번역 엔진 (다중 폴백)
========================= */
// JMA XML에 자주 나오는 단어 로컬 사전
const JMA_DICT = {
  '震源': '진원', '震央': '진앙', '震度': '진도', '規模': '규모', '深さ': '깊이',
  '地震': '지진', '津波': '쓰나미', '注意報': '주의보', '警報': '경보',
  '火山': '화산', '噴火': '분화', '溶岩': '용암', '火砕流': '화쇄류',
  '北海道': '홋카이도', '東北': '도호쿠', '関東': '간토', '中部': '주부',
  '近畿': '긴키', '中国': '주고쿠', '四国': '시코쿠', '九州': '규슈',
  '沖縄': '오키나와', '北西': '북서', '北東': '북동', '南西': '남서', '南東': '남동',
  'マグニチュード': 'M', '暫定値': '잠정값', '最大': '최대', '観測': '관측',
  '発生': '발생', '情報': '정보', '第': '제', '報': '보', '速報': '속보',
};

// 로컬 사전으로 1차 치환
function localPreTranslate(text) {
  let t = text;
  for (const [ja, ko] of Object.entries(JMA_DICT)) t = t.replaceAll(ja, ko);
  return t;
}

// Google 무료 API (1차)
async function translateGoogle(text) {
  const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
    params: { client: 'gtx', sl: 'ja', tl: 'ko', dt: 't', q: text },
    timeout: 8000
  });
  const result = res.data?.[0]?.map(x => x?.[0] || '').join('').trim();
  if (!result) throw new Error('empty');
  return result;
}

// MyMemory 무료 API (2차 폴백)
async function translateMyMemory(text) {
  const res = await axios.get('https://api.mymemory.translated.net/get', {
    params: { q: text.slice(0, 500), langpair: 'ja|ko' },
    timeout: 8000
  });
  const result = res.data?.responseData?.translatedText?.trim();
  if (!result || result === text) throw new Error('empty');
  return result;
}

// 메인 번역 함수 (캐시 → 로컬 → Google → MyMemory)
async function translateToKo(text) {
  if (!text || text.trim() === '') return '내용 없음';

  // 캐시 확인
  const cacheKey = text.slice(0, 200);
  if (xlCache.has(cacheKey)) return xlCache.get(cacheKey);

  // 로컬 1차 치환
  const preTranslated = localPreTranslate(text);

  // 번역 필요 여부 확인 (이미 한국어/영어만 있으면 스킵)
  const needsTranslation = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(preTranslated);
  if (!needsTranslation) {
    xlCache.set(cacheKey, preTranslated);
    return preTranslated;
  }

  // Google 시도
  try {
    const result = await translateGoogle(preTranslated);
    xlCache.set(cacheKey, result);
    if (xlCache.size > 500) xlCache.delete(xlCache.keys().next().value); // LRU 제한
    return result;
  } catch {}

  // MyMemory 폴백
  try {
    const result = await translateMyMemory(preTranslated);
    xlCache.set(cacheKey, result);
    return result;
  } catch {}

  // 모두 실패 시 로컬 치환 결과 반환
  return preTranslated;
}

/* =========================
   4. 데이터 저장소
========================= */
const FILE_PATHS = Object.fromEntries(
  ['kma', 'jma', 'ndms'].map(k => [k, path.join(CONFIG.SENT_DIR, `${k}.json`)])
);

async function initStorage() {
  await fs.mkdir(CONFIG.SENT_DIR, { recursive: true }).catch(() => {});
  for (const [key, p] of Object.entries(FILE_PATHS)) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) list.forEach(([id, ts]) => sent[key].set(id, ts || Date.now()));
      console.log(`[STORAGE] ${key}: ${sent[key].size}개 로드`);
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
  } catch (e) {
    console.error(`[SAVE ERROR] ${key}:`, e.message);
  }
}

/* =========================
   5. HTTP 클라이언트 (재시도 포함)
========================= */
const api = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, application/xml, text/xml, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
  },
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  httpAgent:  new http.Agent({ keepAlive: true }),
});

// 재시도 래퍼 (지수 백오프)
async function fetchWithRetry(fn, source) {
  let lastErr;
  for (let i = 0; i <= CONFIG.RETRY_DELAYS.length; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < CONFIG.RETRY_DELAYS.length) {
        console.warn(`[${source}] 재시도 ${i + 1}/${CONFIG.RETRY_DELAYS.length} (${CONFIG.RETRY_DELAYS[i]}ms 후)`);
        await sleep(CONFIG.RETRY_DELAYS[i]);
      }
    }
  }
  throw lastErr;
}

/* =========================
   6. 에러 브로드캐스트 (중복 방지)
========================= */
async function broadcastError(source, err) {
  const msg = err.response?.data
    ? JSON.stringify(err.response.data).slice(0, 200)
    : (err.message || '알 수 없는 에러');

  console.error(`[${source} ERROR]`, err.code || err.message);

  // 동일 에러 10분 이내 재알림 방지
  const now = Date.now();
  if (lastErrMsg[source] === msg && now - lastErrAt[source] < CONFIG.ERR_COOLDOWN) return;
  lastErrMsg[source] = msg;
  lastErrAt[source]  = now;

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ [${source}] API 오류 발생`)
    .setColor(0xFF0000)
    .addFields(
      { name: '에러 코드',    value: String(err.code || err.response?.status || 'UNKNOWN'), inline: true },
      { name: 'HTTP 상태',   value: String(err.response?.status || '-'), inline: true },
      { name: '메시지',       value: truncate(msg, 1024) },
    )
    .setFooter({ text: `재시도 ${CONFIG.RETRY_DELAYS.length}회 모두 실패` })
    .setTimestamp();

  await broadcast({ embeds: [embed] }).catch(() => {});
}

/* =========================
   7. API 폴링
========================= */

// ─── NDMS ─────────────────────────────────────────────
async function fetchNDMS() {
  if (!SAFETY_KEY) return;
  cleanupCache();
  try {
    const items = await fetchWithRetry(async () => {
      const url = `https://www.safetydata.go.kr/V2/api/DSSP-IF-00247` +
        `?serviceKey=${encodeURIComponent(SAFETY_KEY)}&returnType=json&numOfRows=5&pageNo=1`;
      const res = await api.get(url);

      // ✅ 다양한 응답 구조 모두 처리
      const raw = res.data;
      let body = raw?.body ?? raw?.Body ?? raw?.response?.body ?? raw;

      if (Array.isArray(body)) {
        return body[0]?.data ?? body[0]?.items ?? body[0]?.item ?? body ?? [];
      }
      if (body && typeof body === 'object') {
        return body.data ?? body.items ?? body.item ?? [];
      }
      return [];
    }, 'NDMS');

    const list = Array.isArray(items) ? items : (items ? [items] : []);
    let hasNew = false;

    for (const e of list) {
      // 필드명 스네이크/카멜 둘 다 처리
      const id = String(e.MD101_SN ?? e.md101Sn ?? e.SN ?? e.sn ?? e.msgId ?? '');
      if (!id || sent.ndms.has(id)) continue;

      sent.ndms.set(id, Date.now());
      hasNew = true;

      const type    = e.DSSTR_SE_NM ?? e.dstrSeNm ?? e.dsstrSeNm ?? '알림';
      const content = e.MSG_CN      ?? e.msgCn    ?? e.content    ?? '';
      const area    = e.RCV_AREA_NM ?? e.rcvAreaNm ?? e.areaName  ?? '전국';
      const createdAt = (e.CRT_DT   ?? e.crtDt    ?? e.createDt  ?? '').replace(/\//g, '-');

      // 재난 유형별 색상
      const color = type.includes('지진') ? 0xFF6600
                  : type.includes('화재') ? 0xFF0000
                  : type.includes('홍수') || type.includes('태풍') ? 0x0066FF
                  : 0xFFBB00;

      const embed = new EmbedBuilder()
        .setTitle(`📢 긴급 재난 문자 — ${type}`)
        .setColor(color)
        .setDescription(truncate(content, 4000))
        .addFields(
          { name: '📍 수신 지역', value: area, inline: true },
          { name: '🕐 발령 시각', value: fmtDate(createdAt) || '-', inline: true },
        )
        .setFooter({ text: '행정안전부 안전안내문자' })
        .setTimestamp();

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveState('ndms');
    stats.ndms.ok++;
    lastFetch.ndms = new Date();
  } catch (err) {
    stats.ndms.err++;
    await broadcastError('NDMS', err);
  }
}

// ─── KMA ──────────────────────────────────────────────
async function fetchKMA() {
  if (!KMA_KEY) return;
  try {
    const itemList = await fetchWithRetry(async () => {
      const now     = kstNow();
      const toDate  = now.toISOString().slice(0, 10).replace(/-/g, '');
      const fromDate= new Date(now - 2 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');

      const url = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg` +
        `?serviceKey=${encodeURIComponent(KMA_KEY)}&numOfRows=10&pageNo=1` +
        `&dataType=JSON&fromTmFc=${fromDate}&toTmFc=${toDate}`;

      const res = await api.get(url);

      const code = res.data?.response?.header?.resultCode;
      if (code && code !== '00') throw new Error(`KMA resultCode=${code}: ${res.data?.response?.header?.resultMsg}`);

      const items = res.data?.response?.body?.items?.item;
      return Array.isArray(items) ? items : (items ? [items] : []);
    }, 'KMA');

    let hasNew = false;
    for (const e of itemList) {
      const id = `${e.tmEqk}_${e.loc}`;
      if (!e.tmEqk || sent.kma.has(id)) continue;

      sent.kma.set(id, Date.now());
      hasNew = true;

      const mag   = Number(e.mt)  || 0;
      const depth = Number(e.dep) || null;
      const { color, emoji } = magMeta(mag);

      const fields = [
        { name: '📍 진원지', value: e.loc || '알 수 없음', inline: false },
        { name: '📏 규모',   value: `${emoji} M ${mag.toFixed(1)}`, inline: true },
        { name: '🕐 발생',   value: fmtDate(String(e.tmEqk)), inline: true },
      ];
      if (depth) fields.push({ name: '🔽 진원 깊이', value: `${depth} km`, inline: true });
      if (e.mtSt) fields.push({ name: '📊 진도',     value: String(e.mtSt), inline: true });

      fields.push({ name: '🗺️ 지도', value: `[구글 지도 보기](${createMapLink(null, null, e.loc)})`, inline: true });

      const embed = new EmbedBuilder()
        .setTitle(`🌏 국내 지진 발생 (기상청)`)
        .setColor(color)
        .addFields(fields)
        .setFooter({ text: '기상청 지진 정보' })
        .setTimestamp();

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveState('kma');
    stats.kma.ok++;
    lastFetch.kma = new Date();
  } catch (err) {
    stats.kma.err++;
    await broadcastError('KMA', err);
  }
}

// ─── JMA ──────────────────────────────────────────────
// JMA XML에서 진원, 규모, 깊이 파싱
function parseJMAContent(content) {
  if (!content || typeof content !== 'string') return {};
  const mag   = content.match(/M\s*([\d.]+)/)?.[1];
  const depth = content.match(/深さ.*?([\d]+)\s*km/)?.[1] ?? content.match(/깊이.*?([\d]+)\s*km/)?.[1];
  const lat   = content.match(/北緯\s*([\d.]+)/)?.[1];
  const lon   = content.match(/東経\s*([\d.]+)/)?.[1];
  return {
    mag:   mag   ? Number(mag)   : null,
    depth: depth ? Number(depth) : null,
    lat:   lat   ? Number(lat)   : null,
    lon:   lon   ? Number(lon)   : null,
  };
}

async function fetchJMA() {
  try {
    const items = await fetchWithRetry(async () => {
      const res = await api.get('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', {
        headers: { 'Accept': 'application/xml, text/xml, */*' },
      });

      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: true,
        trimValues: true,
      });
      const obj     = parser.parse(res.data);
      const entries = obj?.feed?.entry;
      return Array.isArray(entries) ? entries.slice(0, 10) : (entries ? [entries] : []);
    }, 'JMA');

    let hasNew = false;
    for (const e of items) {
      const id = String(e.id ?? e['@_id'] ?? '');
      if (!id || sent.jma.has(id)) continue;

      sent.jma.set(id, Date.now());
      hasNew = true;

      const rawTitle   = typeof e.title   === 'string' ? e.title   : (e.title?.['#text']   ?? '');
      const rawContent = typeof e.content === 'string' ? e.content : (e.content?.['#text'] ?? rawTitle);
      const rawSummary = typeof e.summary === 'string' ? e.summary : (e.summary?.['#text'] ?? '');
      const rawText    = rawContent || rawSummary || rawTitle;

      // 번역 병렬 처리
      const [titleKo, contentKo] = await Promise.all([
        translateToKo(rawTitle),
        translateToKo(rawText),
      ]);

      const isVolcano  = /火山|噴火/.test(rawTitle);
      const isTsunami  = /津波/.test(rawTitle);
      const parsed     = parseJMAContent(rawText);

      const color = isTsunami  ? 0x0000FF
                  : isVolcano  ? 0xFF4500
                  : parsed.mag ? magMeta(parsed.mag).color
                  : 0x5865F2;

      const title = isTsunami ? '🌊 쓰나미 경보 (JMA)'
                  : isVolcano ? '🌋 일본 화산 정보 (JMA)'
                  : '🌏 일본 지진 발생 (JMA)';

      const fields = [{ name: '📍 정보 제목', value: truncate(titleKo, 256) }];

      if (parsed.mag)   fields.push({ name: '📏 규모',     value: `${magMeta(parsed.mag).emoji} M ${parsed.mag.toFixed(1)}`, inline: true });
      if (parsed.depth) fields.push({ name: '🔽 진원 깊이', value: `${parsed.depth} km`, inline: true });

      const mapLink = createMapLink(parsed.lat, parsed.lon, titleKo);
      fields.push({ name: '🗺️ 지도', value: `[구글 지도 보기](${mapLink})`, inline: true });

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setDescription(truncate(contentKo, 2000))
        .addFields(fields)
        .setFooter({ text: '일본 기상청 (JMA)' })
        .setTimestamp(new Date(e.updated ?? Date.now()));

      await broadcast({ embeds: [embed] });
    }
    if (hasNew) await saveState('jma');
    stats.jma.ok++;
    lastFetch.jma = new Date();
  } catch (err) {
    stats.jma.err++;
    await broadcastError('JMA', err);
  }
}

/* =========================
   8. Discord 클라이언트
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function broadcast(payload) {
  for (const id of CONFIG.CHANNELS) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.isTextBased()) await ch.send(payload);
    } catch (e) {
      console.error(`[BROADCAST] 채널 ${id} 전송 실패:`, e.message);
    }
  }
}

// 슬래시 커맨드 정의
const COMMANDS = [
  { name: '상태',   description: '봇 연결 및 API 상태 확인' },
  { name: '청소',   description: '중복 방지 캐시 초기화 (Owner 전용)' },
  { name: '도움말', description: '봇 기능 안내' },
  { name: '마지막', description: '각 API 마지막 성공 조회 시각 확인' },
];

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  await initStorage();

  const startLoop = (fn, ms) => { fn(); setInterval(fn, ms); };
  startLoop(fetchNDMS, CONFIG.MS_NDMS);
  startLoop(fetchKMA,  CONFIG.MS_EQ);
  startLoop(fetchJMA,  CONFIG.MS_EQ);

  if (APPLICATION_ID) {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: COMMANDS }).catch(console.error);
    console.log('[COMMAND] 슬래시 커맨드 등록 완료');
  }
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // Owner 전용 커맨드
  const ownerOnly = ['청소'];
  if (ownerOnly.includes(i.commandName) && OWNER_ID && i.user.id !== OWNER_ID) {
    return i.reply({ content: '❌ 권한 없음 (Owner 전용)', ephemeral: true });
  }

  // /상태
  if (i.commandName === '상태') {
    const up    = process.uptime();
    const hh    = Math.floor(up / 3600);
    const mm    = Math.floor((up % 3600) / 60);
    const ss    = Math.floor(up % 60);
    const total = Object.values(stats).reduce((a, s) => a + s.ok + s.err, 0);
    const errTotal = Object.values(stats).reduce((a, s) => a + s.err, 0);

    const embed = new EmbedBuilder()
      .setTitle('📊 봇 시스템 상태')
      .setColor(errTotal > 0 ? 0xFFAA00 : 0x00FF99)
      .addFields(
        { name: '🕐 가동 시간',     value: `${hh}시간 ${mm}분 ${ss}초`,        inline: false },
        { name: '📢 안전안내문자',   value: `✅ ${stats.ndms.ok} / ❌ ${stats.ndms.err}`, inline: true },
        { name: '🌏 국내지진(KMA)', value: `✅ ${stats.kma.ok}  / ❌ ${stats.kma.err}`,  inline: true },
        { name: '🗾 일본지진(JMA)', value: `✅ ${stats.jma.ok}  / ❌ ${stats.jma.err}`,  inline: true },
        { name: '📡 총 API 호출',   value: `${total}회 (에러율 ${total ? Math.round(errTotal/total*100) : 0}%)`, inline: false },
      )
      .setFooter({ text: '모든 시간은 KST 기준' })
      .setTimestamp();

    return i.reply({ embeds: [embed] });
  }

  // /마지막
  if (i.commandName === '마지막') {
    const embed = new EmbedBuilder()
      .setTitle('🕐 마지막 조회 시각')
      .setColor(0x5865F2)
      .addFields(
        { name: '📢 안전안내문자',   value: lastFetch.ndms ? fmtDate(lastFetch.ndms) : '아직 없음', inline: true },
        { name: '🌏 국내지진(KMA)', value: lastFetch.kma  ? fmtDate(lastFetch.kma)  : '아직 없음', inline: true },
        { name: '🗾 일본지진(JMA)', value: lastFetch.jma  ? fmtDate(lastFetch.jma)  : '아직 없음', inline: true },
        { name: '🔁 조회 주기',
          value: `안전안내문자: 2분 / 지진: 5분`,
          inline: false },
      )
      .setTimestamp();
    return i.reply({ embeds: [embed] });
  }

  // /청소
  if (i.commandName === '청소') {
    const counts = Object.fromEntries(Object.entries(sent).map(([k, m]) => [k, m.size]));
    Object.values(sent).forEach(m => m.clear());
    Object.keys(lastErrMsg).forEach(k => { lastErrMsg[k] = ''; lastErrAt[k] = 0; });
    await Promise.all(['kma', 'jma', 'ndms'].map(saveState));
    return i.reply(
      `🧹 캐시가 초기화되었습니다.\n` +
      `삭제 항목 — NDMS: ${counts.ndms}개 / KMA: ${counts.kma}개 / JMA: ${counts.jma}개`
    );
  }

  // /도움말
  if (i.commandName === '도움말') {
    const embed = new EmbedBuilder()
      .setTitle('📖 재난 알림 봇 도움말')
      .setColor(0x5865F2)
      .setDescription('국내외 지진, 화산, 재난문자를 실시간으로 알려드립니다.')
      .addFields(
        { name: '📢 안전안내문자 (NDMS)', value: '행정안전부 안전안내문자를 2분마다 확인합니다.', inline: false },
        { name: '🌏 국내 지진 (KMA)',     value: '기상청 지진 정보를 5분마다 확인합니다.',        inline: false },
        { name: '🗾 일본 지진/화산 (JMA)',value: '일본 기상청 정보를 5분마다 확인합니다.\n번역은 자동으로 처리됩니다.', inline: false },
        { name: '⚙️ 슬래시 커맨드',
          value: '`/상태` — API 호출 통계 확인\n`/마지막` — 마지막 조회 시각 확인\n`/청소` — 캐시 초기화 (Owner 전용)\n`/도움말` — 이 메시지',
          inline: false },
        { name: '🎨 규모별 색상',
          value: '⚪ M3미만  🔵 M3+  🟡 M4+  🟠 M5+  🔴 M6+  🆘 M7+',
          inline: false },
      )
      .setFooter({ text: '문제 발생 시 오류 메시지가 이 채널에 자동으로 전송됩니다.' })
      .setTimestamp();
    return i.reply({ embeds: [embed] });
  }
});

/* =========================
   9. 웹 서버 & 프로세스 핸들링
========================= */
const app = express();
app.get('/', (_, res) => res.json({
  status: 'running',
  uptime: Math.floor(process.uptime()),
  stats,
  lastFetch,
}));
app.listen(CONFIG.PORT, () => console.log(`[WEB] :${CONFIG.PORT}`));

process.on('uncaughtException',  e => console.error('[CRITICAL]', e.message));
process.on('unhandledRejection', e => console.error('[CRITICAL]', e?.message ?? e));

client.login(DISCORD_TOKEN);