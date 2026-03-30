/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  재난 알림 봇 v8.0  —  Absolute World-Class                   ║
 * ║  소스: KMA · JMA · NDMS · USGS                               ║
 * ║                                                              ║
 * ║  NEW v8.0                                                    ║
 * ║  ├─ Anti-Raid          (@everyone 스팸·채널 홍수 자동 차단)    ║
 * ║  ├─ Audit Log          (닉네임·역할·입퇴장·밴·채널 등 기록)    ║
 * ║  ├─ Per-Guild Config   (/알림·/로그 채널 서버별 설정)          ║
 * ║  ├─ Input Sanitize     (XSS·인젝션·embed 인젝션 방어)         ║
 * ║  └─ Security Headers   (Express 보안 헤더 6종)               ║
 * ║                                                              ║
 * ║  CORE (v7 계승)                                              ║
 * ║  ├─ Circuit Breaker · Broadcast Queue · Dynamic Interval     ║
 * ║  ├─ Jittered Retry · Bounded LRU · Atomic Persist           ║
 * ║  ├─ Cross-Source Dedup (Haversine) · Geo Router             ║
 * ║  └─ Graceful Shutdown · Structured Log                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import express       from 'express';
import axios         from 'axios';
import fs            from 'fs/promises';
import path          from 'path';
import https         from 'https';
import http          from 'http';
import { XMLParser } from 'fast-xml-parser';
import {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, REST, Routes,
  Events, AuditLogEvent,
  PermissionFlagsBits,
  ApplicationCommandOptionType,
} from 'discord.js';

/* ══════════════════════════════════════════════════════════════
   §1.  환경 변수 검증
══════════════════════════════════════════════════════════════ */
const ENV = (() => {
  if (!process.env.DISCORD_TOKEN) {
    process.stdout.write('[FATAL] DISCORD_TOKEN 없음\n');
    process.exit(1);
  }
  return Object.freeze({
    DISCORD_TOKEN:  process.env.DISCORD_TOKEN,
    APPLICATION_ID: process.env.APPLICATION_ID ?? '',
    OWNER_ID:       process.env.OWNER_ID        ?? '',
    PORT:           process.env.PORT             ?? '3000',
    CHANNEL_IDS:    process.env.CHANNEL_IDS      ?? '',
    KMA_KEY:        process.env.KMA_KEY          ?? '',
    SAFETY_KEY:     process.env.SAFETY_KEY       ?? '',
  });
})();

/* ══════════════════════════════════════════════════════════════
   §2.  전역 설정 (불변 동결)
══════════════════════════════════════════════════════════════ */
const CFG = Object.freeze({
  PORT:          Number(ENV.PORT) || 3000,
  DATA_DIR:      path.resolve(process.cwd(), 'data'),
  /* 재난 알림 폴백 채널 (env 설정) */
  GLOBAL_CH:     ENV.CHANNEL_IDS.split(',').map(s => s.trim()).filter(Boolean),

  /* 폴링 주기 */
  MS_NDMS:       2  * 60_000,
  MS_EQ:         5  * 60_000,
  MS_ERR:        20 * 60_000,

  /* 재시도 */
  RETRY_BASE:    Object.freeze([3_000, 8_000, 20_000]),
  RETRY_JITTER:  0.3,

  /* Circuit Breaker */
  CB_THRESH:     3,
  CB_HALF_MS:    5 * 60_000,

  /* 에러 알림 쿨다운 */
  ERR_CD_MS:     10 * 60_000,

  /* 캐시 한도 */
  CACHE_TTL:     24 * 3_600_000,
  SENT_MAX:      3_000,
  XL_MAX:        800,

  /* Cross-Source 중복 판별 */
  DEDUP_DIST_KM: 80,
  DEDUP_MAG_D:   0.5,
  DEDUP_TIME_MS: 5 * 60_000,
  DEDUP_MAX:     500,

  /* KMA 정상 resultCode */
  KMA_OK:        Object.freeze(new Set(['00', '03'])),

  /* USGS */
  USGS_URL:      'https://earthquake.usgs.gov/fdsnws/event/1/query',
  USGS_MIN_MAG:  4.5,
  USGS_LIMIT:    20,

  /* 지리 경계 박스 */
  GEO: Object.freeze({
    KR: Object.freeze({ latMin:33.0, latMax:38.9, lonMin:124.5, lonMax:132.0 }),
    JP: Object.freeze({ latMin:24.0, latMax:46.0, lonMin:122.0, lonMax:154.0 }),
  }),

  /* Anti-Raid */
  RAID_MENTION_LIMIT: 5,         // N초 안에 @everyone N회 → 차단
  RAID_MENTION_SEC:   3,         // 초
  RAID_CH_LIMIT:      5,         // N초 안에 채널 N개 생성 → 차단·삭제
  RAID_CH_SEC:        10,

  /* Discord */
  BROADCAST_GAP:  350,
  EMBED_MAX:      4_000,
  SHUTDOWN_MS:    12_000,
});

/* ══════════════════════════════════════════════════════════════
   §3.  구조화 로그
══════════════════════════════════════════════════════════════ */
function log(level, src, msg, extra) {
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const ex = extra ? ` | ${String(extra).slice(0, 200)}` : '';
  process.stdout.write(`${ts} [${level.padEnd(5)}][${String(src).padEnd(5)}] ${msg}${ex}\n`);
}

/* ══════════════════════════════════════════════════════════════
   §4.  입력 무결성 (XSS · Embed 인젝션 방어)
══════════════════════════════════════════════════════════════ */
const DANGER_RE = /[<>"'`\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const sane = (v, max = 1024) =>
  v == null ? '없음' : String(v).replace(DANGER_RE, '').slice(0, max) || '없음';

/* ══════════════════════════════════════════════════════════════
   §5.  Haversine 거리
══════════════════════════════════════════════════════════════ */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6_371, d2r = Math.PI / 180;
  const dL = (lat2 - lat1) * d2r, dO = (lon2 - lon1) * d2r;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1*d2r) * Math.cos(lat2*d2r) * Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ══════════════════════════════════════════════════════════════
   §6.  Cross-Source 전역 이벤트 레지스트리
══════════════════════════════════════════════════════════════ */
const GEV = [];

function isDuplicateEvent({ src, lat, lon, mag, timeMs }) {
  const now    = Date.now();
  const cutoff = now - CFG.CACHE_TTL;
  while (GEV.length > 0 && GEV[GEV.length-1].sentAt < cutoff) GEV.pop();
  while (GEV.length >= CFG.DEDUP_MAX) GEV.pop();

  if (lat == null || lon == null) {
    GEV.unshift({ src, lat, lon, mag, timeMs, sentAt:now });
    return false;
  }
  for (const ev of GEV) {
    if (ev.lat == null || ev.lon == null) continue;
    if (haversineKm(lat,lon,ev.lat,ev.lon) <= CFG.DEDUP_DIST_KM &&
        mag != null && ev.mag != null && Math.abs(mag - ev.mag) <= CFG.DEDUP_MAG_D &&
        timeMs != null && ev.timeMs != null && Math.abs(timeMs - ev.timeMs) <= CFG.DEDUP_TIME_MS) {
      log('INFO', src, `Cross-Dedup 스킵 (${ev.src} 기전송)`,
          `d=${haversineKm(lat,lon,ev.lat,ev.lon).toFixed(0)}km M${mag}`);
      return true;
    }
  }
  GEV.unshift({ src, lat, lon, mag, timeMs, sentAt:now });
  return false;
}

/* ══════════════════════════════════════════════════════════════
   §7.  Circuit Breaker
══════════════════════════════════════════════════════════════ */
class CircuitBreaker {
  #name; #state='CLOSED'; #failures=0; #openedAt=0;
  constructor(name) { this.#name = name; }
  get state()  { return this.#state; }
  get isOpen() { return this.#state === 'OPEN'; }

  async exec(fn) {
    if (this.#state === 'OPEN') {
      const wait = CFG.CB_HALF_MS - (Date.now() - this.#openedAt);
      if (wait > 0) throw Object.assign(new Error(`CB_OPEN:${this.#name}`), { cbOpen:true });
      this.#state = 'HALF_OPEN';
      log('CB', this.#name, '→ HALF_OPEN');
    }
    try {
      const r = await fn();
      if (this.#failures > 0 || this.#state === 'HALF_OPEN')
        log('CB', this.#name, '→ CLOSED (복구)');
      this.#state = 'CLOSED'; this.#failures = 0;
      return r;
    } catch(e) {
      if (!e.cbOpen && ++this.#failures >= CFG.CB_THRESH) {
        this.#state = 'OPEN'; this.#openedAt = Date.now();
        log('WARN', this.#name, `→ OPEN (${this.#failures}회)`);
      }
      throw e;
    }
  }
  badge() {
    if (this.#state === 'CLOSED')    return '✅ 정상';
    if (this.#state === 'HALF_OPEN') return '🟡 복구 시험 중';
    const s = Math.ceil((CFG.CB_HALF_MS-(Date.now()-this.#openedAt))/1_000);
    return `❌ 차단됨 (${s}초 후)`;
  }
}
const CB = Object.fromEntries(
  ['kma','jma','ndms','usgs'].map(k => [k, new CircuitBreaker(k.toUpperCase())])
);

/* ══════════════════════════════════════════════════════════════
   §8.  에러·복구 추적기
══════════════════════════════════════════════════════════════ */
const TRK = Object.fromEntries(
  ['kma','jma','ndms','usgs'].map(k => [k, { streak:0, lastOk:null }])
);
const onOk  = src => { const t=TRK[src]; const w=t.streak; t.streak=0; t.lastOk=new Date(); return w>0?w+1:null; };
const onErr = src => TRK[src].streak++;

/* ══════════════════════════════════════════════════════════════
   §9.  유틸
══════════════════════════════════════════════════════════════ */
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const kst    = ()  => new Date(Date.now() + 9*3_600_000);
const jitter = ms  => Math.floor(ms * (1 + (Math.random()*2-1)*CFG.RETRY_JITTER));
const fmtDate = v  => {
  if (!v) return '-';
  const d = new Date(typeof v==='string' && !/^\d{10,}$/.test(v) ? v : Number(v));
  return isNaN(d) ? sane(v,30) : d.toLocaleString('ko-KR', { timeZone:'Asia/Seoul' });
};
const gmap = (lat, lon, q) =>
  lat!=null&&lon!=null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
  : q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
      : 'https://www.google.com/maps';

const magStyle = m => {
  if (m>=7) return { color:0x7B0000, em:'🆘' };
  if (m>=6) return { color:0xFF0000, em:'🔴' };
  if (m>=5) return { color:0xFF6600, em:'🟠' };
  if (m>=4) return { color:0xFFAA00, em:'🟡' };
  if (m>=3) return { color:0x00AAFF, em:'🔵' };
  return     { color:0x888888, em:'⚪' };
};
const pagerMeta = lv => ({
  green: {em:'🟢',color:0x00CC00,label:'낮음'}, yellow:{em:'🟡',color:0xFFCC00,label:'보통'},
  orange:{em:'🟠',color:0xFF8800,label:'높음'}, red:   {em:'🔴',color:0xFF0000,label:'심각'},
}[lv] ?? {em:'⚫',color:0x888888,label:'-'});

const geoRegion = (lat, lon) => {
  if (lat==null||lon==null) return 'INT';
  const {KR,JP} = CFG.GEO;
  if (lat>=KR.latMin&&lat<=KR.latMax&&lon>=KR.lonMin&&lon<=KR.lonMax) return 'KR';
  if (lat>=JP.latMin&&lat<=JP.latMax&&lon>=JP.lonMin&&lon<=JP.lonMax) return 'JP';
  return 'INT';
};

/* ══════════════════════════════════════════════════════════════
   §10. NDMS 재난 유형별 색상 (15종)
══════════════════════════════════════════════════════════════ */
const NDMS_TYPES = [
  { keys:['지진'],                  color:0xFF6600, em:'🌏' },
  { keys:['화재','산불'],            color:0xFF2200, em:'🔥' },
  { keys:['홍수','호우','침수'],      color:0x0055FF, em:'🌊' },
  { keys:['태풍','강풍'],            color:0x0099CC, em:'🌀' },
  { keys:['대설','폭설','한파'],      color:0xAADDFF, em:'❄️' },
  { keys:['폭염','고온'],            color:0xFF4400, em:'🌡️' },
  { keys:['황사','미세먼지'],         color:0xCCBB44, em:'😷' },
  { keys:['화학','가스','유해'],      color:0x88CC00, em:'☣️' },
  { keys:['방사능','방사선','원전'],  color:0xFFFF00, em:'☢️' },
  { keys:['실종'],                   color:0x9B59B6, em:'🔍' },
  { keys:['교통','도로','철도'],      color:0x808080, em:'🚧' },
  { keys:['붕괴','침하','사고'],      color:0x964B00, em:'⚠️' },
  { keys:['테러','범죄','위협'],      color:0x2C3E50, em:'🚨' },
  { keys:['해일','쓰나미'],          color:0x0000CC, em:'🌊' },
  { keys:['가뭄','용수'],            color:0xC68E3C, em:'💧' },
  { keys:['훈련','연습'],            color:0x27AE60, em:'📋' },
];
const NDMS_DEFAULT = { color:0x778899, em:'📢' };
function ndmsMeta(type) {
  const t = String(type??'');
  for (const e of NDMS_TYPES) if (e.keys.some(k=>t.includes(k))) return e;
  return NDMS_DEFAULT;
}

/* ══════════════════════════════════════════════════════════════
   §11. 중복 방지 캐시 (Bounded Map)
══════════════════════════════════════════════════════════════ */
const SENT = Object.fromEntries(['kma','jma','ndms','usgs'].map(k=>[k,new Map()]));
function pruneSent() {
  const cut = Date.now()-CFG.CACHE_TTL;
  for (const m of Object.values(SENT)) for (const [id,ts] of m) if(ts<cut) m.delete(id);
}
function markSent(src, id) {
  const m = SENT[src]; m.set(id, Date.now());
  if (m.size > CFG.SENT_MAX) m.delete(m.keys().next().value);
}

/* ══════════════════════════════════════════════════════════════
   §12. 영속화 (Atomic Write)
══════════════════════════════════════════════════════════════ */
const FILE = Object.fromEntries(
  ['kma','jma','ndms','usgs','config'].map(k=>[k, path.join(CFG.DATA_DIR,`${k}.json`)])
);

async function initStorage() {
  await fs.mkdir(CFG.DATA_DIR, { recursive:true });
  for (const [k, p] of Object.entries(FILE)) {
    if (k === 'config') continue; // config는 별도 로드
    try {
      const rows = JSON.parse(await fs.readFile(p,'utf8'));
      if (Array.isArray(rows)) rows.forEach(([id,ts])=>SENT[k].set(id,ts||Date.now()));
      log('INFO','STOR',`${k} ${SENT[k].size}개 로드`);
    } catch { await fs.writeFile(p,'[]','utf8').catch(()=>{}); }
  }
}

async function persist(key) {
  const tmp = `${FILE[key]}.tmp`;
  try {
    const data = key === 'config'
      ? JSON.stringify(Object.fromEntries(GUILD_CFG))
      : JSON.stringify([...SENT[key].entries()]);
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, FILE[key]);
  } catch(e) {
    log('ERROR','STOR',`${key} 저장 실패`,e.message);
    await fs.unlink(tmp).catch(()=>{});
  }
}

/* ══════════════════════════════════════════════════════════════
   §13. 서버별 설정 (alertChannel, logChannel)
══════════════════════════════════════════════════════════════ */
/** Map<guildId, { alertChannel:string|null, logChannel:string|null }> */
const GUILD_CFG = new Map();

async function loadGuildConfig() {
  try {
    const raw  = JSON.parse(await fs.readFile(FILE.config,'utf8'));
    for (const [gid, cfg] of Object.entries(raw)) GUILD_CFG.set(gid, cfg);
    log('INFO','GCFG',`서버 설정 ${GUILD_CFG.size}개 로드`);
  } catch { await fs.writeFile(FILE.config,'{}','utf8').catch(()=>{}); }
}

function getAlertChannels() {
  const ids = new Set(CFG.GLOBAL_CH);
  for (const [, cfg] of GUILD_CFG) if (cfg.alertChannel) ids.add(cfg.alertChannel);
  return [...ids];
}
function getLogChannel(guildId) {
  return GUILD_CFG.get(guildId)?.logChannel ?? null;
}

/* ══════════════════════════════════════════════════════════════
   §14. HTTP 클라이언트 + Jitter 재시도
══════════════════════════════════════════════════════════════ */
const HTTP = axios.create({
  timeout: 15_000,
  headers: {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'application/json, application/xml, text/xml, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
  },
  httpsAgent: new https.Agent({ keepAlive:true, keepAliveMsecs:30_000, rejectUnauthorized:false }),
  httpAgent:  new http.Agent({ keepAlive:true, keepAliveMsecs:30_000 }),
});
HTTP.interceptors.response.use(r=>r, e=>{
  if (e.response?.status) e.message=`HTTP ${e.response.status}: ${e.config?.url?.split('?')[0]??''}`;
  return Promise.reject(e);
});
async function withRetry(fn, src) {
  let last;
  for (let i=0; i<=CFG.RETRY_BASE.length; i++) {
    try { return await fn(); }
    catch(e) {
      last=e;
      if (i<CFG.RETRY_BASE.length) {
        const ms=jitter(CFG.RETRY_BASE[i]);
        log('WARN',src,`재시도 ${i+1}/${CFG.RETRY_BASE.length} (${ms}ms)`,e.message);
        await sleep(ms);
      }
    }
  }
  throw last;
}

/* ══════════════════════════════════════════════════════════════
   §15. 번역 엔진
══════════════════════════════════════════════════════════════ */
const JMA_DICT = new Map([
  ['緊急地震速報','긴급지진속보'],['震源地','진원지'],['震源域','진원역'],
  ['震源','진원'],['震央','진앙'],['震度','진도'],['規模','규모'],
  ['深さ','깊이'],['地震','지진'],['津波','쓰나미'],['注意報','주의보'],
  ['警報','경보'],['火山','화산'],['噴火','분화'],['溶岩','용암'],
  ['火砕流','화쇄류'],['余震','여진'],['本震','본진'],['前震','전진'],
  ['北海道','홋카이도'],['東北','도호쿠'],['関東','간토'],['中部','주부'],
  ['近畿','긴키'],['中国','주고쿠'],['四国','시코쿠'],['九州','규슈'],
  ['沖縄','오키나와'],['北西','북서'],['北東','북동'],['南西','남서'],['南東','남동'],
  ['マグニチュード','M'],['暫定値','잠정값'],['最大','최대'],['観測','관측'],
  ['発生','발생'],['情報','정보'],['速報','속보'],['第','제'],['報','보'],
  ['陸地','육지'],['海域','해역'],['沿岸','연안'],['予想','예상'],['到達','도달'],
  ['発表','발표'],['取消','취소'],['更新','갱신'],['高い','높음'],['低い','낮음'],
  ['強い','강함'],['弱い','약함'],['危険','위험'],['避難','대피'],
  ['警戒','경계'],['解除','해제'],['継続','계속'],
]);
const XL = new Map();
function dictTr(t) { let r=t; for (const [j,k] of JMA_DICT) r=r.replaceAll(j,k); return r; }
function xlSet(k,v) { if(XL.size>=CFG.XL_MAX) XL.delete(XL.keys().next().value); XL.set(k,v); }
async function toKo(raw) {
  if (!raw?.trim()) return '내용 없음';
  const key=raw.slice(0,200); if(XL.has(key)) return XL.get(key);
  const pre=dictTr(raw);
  if (!/[\u3040-\u30FF\u4E00-\u9FFF]/.test(pre)) { xlSet(key,pre); return pre; }
  try {
    const r=await axios.get('https://translate.googleapis.com/translate_a/single',
      {params:{client:'gtx',sl:'ja',tl:'ko',dt:'t',q:pre},timeout:8_000});
    const out=r.data?.[0]?.map(x=>x?.[0]||'').join('').trim();
    if(out){xlSet(key,out);return out;}
  } catch {}
  try {
    const r=await axios.get('https://api.mymemory.translated.net/get',
      {params:{q:pre.slice(0,500),langpair:'ja|ko'},timeout:8_000});
    const out=r.data?.responseData?.translatedText?.trim();
    if(out&&out!==pre){xlSet(key,out);return out;}
  } catch {}
  xlSet(key,pre); return pre;
}

/* ══════════════════════════════════════════════════════════════
   §16. JMA 본문 숫자 파싱
══════════════════════════════════════════════════════════════ */
function parseJMANums(text) {
  if (typeof text!=='string') return {};
  return {
    mag:   text.match(/M\s*([\d.]+)/)?.[1]  ?+text.match(/M\s*([\d.]+)/)[1] :null,
    depth: (text.match(/深さ.*?([\d]+)\s*km/)?.[1]??text.match(/깊이.*?([\d]+)\s*km/)?.[1])
           ? +(text.match(/深さ.*?([\d]+)\s*km/)?.[1]??text.match(/깊이.*?([\d]+)\s*km/)[1]) :null,
    lat:   text.match(/北緯\s*([\d.]+)/)?.[1]  ?+text.match(/北緯\s*([\d.]+)/)[1] :null,
    lon:   text.match(/東経\s*([\d.]+)/)?.[1]  ?+text.match(/東経\s*([\d.]+)/)[1] :null,
  };
}

/* ══════════════════════════════════════════════════════════════
   §17. Discord 클라이언트 (확장된 인텐트)
══════════════════════════════════════════════════════════════ */
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

/* ══════════════════════════════════════════════════════════════
   §18. Broadcast Queue (직렬 전송 · Rate Limit 방지)
══════════════════════════════════════════════════════════════ */
const Q=[]; let qBusy=false;
const broadcast = payload => new Promise((res,rej)=>{Q.push({payload,res,rej});drain();});
async function drain() {
  if(qBusy||Q.length===0) return; qBusy=true;
  while(Q.length>0) {
    const {payload,res,rej}=Q.shift();
    try {
      for (const id of getAlertChannels()) {
        try {
          const ch=await discord.channels.fetch(id);
          if(ch?.isTextBased()) await ch.send(payload);
        } catch(e){log('WARN','CAST',`채널 ${id} 실패`,e.message);}
        if(getAlertChannels().length>1) await sleep(CFG.BROADCAST_GAP);
      }
      res();
    } catch(e){rej(e);}
    if(Q.length>0) await sleep(CFG.BROADCAST_GAP);
  }
  qBusy=false;
}

/* ══════════════════════════════════════════════════════════════
   §19. 감사 로그 전송 (스크린샷 양식)
   형식:
   [아바타] username
   @TARGET action
   
   **Before**
   [이전 값]
   
   **after**
   [이후 값]
   
   ID: XXXXXXXX | Today at HH:MM
══════════════════════════════════════════════════════════════ */
async function sendAuditLog(guildId, embed) {
  const chId = getLogChannel(guildId);
  if (!chId) return;
  try {
    const ch = await discord.channels.fetch(chId);
    if (ch?.isTextBased()) await ch.send({ embeds:[embed] });
  } catch(e){ log('WARN','ALOG',`로그 채널 전송 실패 (${guildId})`,e.message); }
}

/**
 * 감사 로그 임베드 빌더 — 스크린샷 양식
 * @param {Object} o
 * @param {string} o.actor       - 행동한 사람 태그 (예: gimgyeongho0582)
 * @param {string} o.actorAvatar - 아바타 URL
 * @param {string} o.target      - 대상 멘션 (예: @GOLDEN_X96)
 * @param {string} o.action      - 동작 설명 (예: nickname changed)
 * @param {string|null} o.before - 변경 전 값
 * @param {string|null} o.after  - 변경 후 값
 * @param {string} o.targetId    - 대상 ID
 * @param {number} o.color       - 임베드 색상
 */
function buildAuditEmbed({ actor, actorAvatar, target, action, before, after, targetId, color=0x5865F2 }) {
  const now    = new Date();
  const timeStr = now.toLocaleString('en-US', {
    timeZone:'Asia/Seoul', hour:'numeric', minute:'2-digit', hour12:true,
  });
  // "Today at HH:MM AM" 형식
  const footer = `ID: ${sane(targetId,25)} | Today at ${timeStr}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: sane(actor,100), iconURL: actorAvatar ?? undefined })
    .setDescription(`**${sane(target,100)}** ${sane(action,200)}`)
    .setFooter({ text: footer });

  if (before != null) embed.addFields({ name:'**Before**', value: sane(before, 512), inline:false });
  if (after  != null) embed.addFields({ name:'**after**',  value: sane(after,  512), inline:false });

  return embed;
}

/* ══════════════════════════════════════════════════════════════
   §20. Anti-Raid 시스템
══════════════════════════════════════════════════════════════ */
/** Map<userId, number[]> — @everyone 발생 타임스탬프 목록 */
const mentionLog  = new Map();
/** Map<guildId, { timestamps:number[], channels:string[] }> — 채널 생성 추적 */
const channelLog  = new Map();

/**
 * @everyone 스팸 감지 → 영구차단 + 메시지 삭제
 */
async function handleEveryoneMention(msg) {
  if (!msg.guild || !msg.mentions.everyone) return;

  const uid  = msg.author.id;
  const now  = Date.now();
  const win  = CFG.RAID_MENTION_SEC * 1_000;

  // 윈도우 내 타임스탬프 유지
  const times = (mentionLog.get(uid) ?? []).filter(t => now-t < win);
  times.push(now);
  mentionLog.set(uid, times);

  if (times.length < CFG.RAID_MENTION_LIMIT) return;

  // 한도 초과 → 즉시 처리
  mentionLog.delete(uid);
  log('WARN','RAID',`@everyone 스팸 감지: ${msg.author.tag} (${uid}) in ${msg.guild.name}`);

  try {
    // 최근 100개 메시지 중 해당 유저 메시지 전부 삭제
    const fetched = await msg.channel.messages.fetch({ limit:100 });
    const toDelete = fetched.filter(m => m.author.id===uid && now-m.createdTimestamp<60_000*14);
    if (toDelete.size > 0) await msg.channel.bulkDelete(toDelete, true).catch(()=>{});

    // 영구 차단
    await msg.guild.members.ban(uid, { reason:'[자동] @everyone 멘션 스팸 (Anti-Raid)', deleteMessageSeconds:604800 });
    log('INFO','RAID',`영구차단 완료: ${uid}`);

    // 감사 로그
    await sendAuditLog(msg.guild.id, buildAuditEmbed({
      actor:       '봇 자동 처리 (Anti-Raid)',
      actorAvatar: discord.user?.displayAvatarURL(),
      target:      `@${sane(msg.author.tag,100)}`,
      action:      'was permanently banned (everyone mention spam)',
      before:      `${times.length}회 / ${CFG.RAID_MENTION_SEC}초`,
      after:       '영구 서버 차단',
      targetId:    uid,
      color:       0xFF0000,
    }));
  } catch(e){ log('ERROR','RAID','스팸 처리 실패',e.message); }
}

/**
 * 채널 홍수 감지 → 채널 삭제 + 생성자 영구차단
 */
async function handleChannelCreate(channel) {
  const guild = channel.guild;
  if (!guild) return;
  const now  = Date.now();
  const win  = CFG.RAID_CH_SEC * 1_000;

  const state = channelLog.get(guild.id) ?? { timestamps:[], channels:[], creatorId:null };
  state.timestamps = state.timestamps.filter(t => now-t < win);
  state.timestamps.push(now);
  state.channels.push(channel.id);

  // 채널 생성자 파악 (AuditLog)
  try {
    const logs = await guild.fetchAuditLogs({ type:AuditLogEvent.ChannelCreate, limit:1 });
    const entry = logs.entries.first();
    if (entry && now - entry.createdTimestamp < 5_000) state.creatorId = entry.executor?.id ?? null;
  } catch {}

  channelLog.set(guild.id, state);

  if (state.timestamps.length < CFG.RAID_CH_LIMIT) return;

  log('WARN','RAID',`채널 홍수 감지: ${guild.name} (${state.channels.length}개)`);
  channelLog.delete(guild.id);

  // 생성된 채널 즉시 삭제
  const deleted = [];
  for (const chId of state.channels) {
    try {
      const ch = await discord.channels.fetch(chId).catch(()=>null);
      if (ch && ch.guild?.id === guild.id) { await ch.delete('[자동] 채널 홍수 감지 (Anti-Raid)'); deleted.push(chId); }
    } catch(e){ log('WARN','RAID',`채널 삭제 실패 ${chId}`,e.message); }
  }

  // 생성자 차단
  if (state.creatorId && state.creatorId !== discord.user?.id) {
    try {
      await guild.members.ban(state.creatorId, { reason:'[자동] 채널 홍수 (Anti-Raid)', deleteMessageSeconds:604800 });
      log('INFO','RAID',`채널 홍수 생성자 차단: ${state.creatorId}`);
    } catch(e){ log('WARN','RAID','채널 홍수 생성자 차단 실패',e.message); }
  }

  await sendAuditLog(guild.id, buildAuditEmbed({
    actor:       '봇 자동 처리 (Anti-Raid)',
    actorAvatar: discord.user?.displayAvatarURL(),
    target:      state.creatorId ? `<@${state.creatorId}>` : '알 수 없음',
    action:      `channel flood detected — ${deleted.length}개 채널 삭제`,
    before:      `${state.timestamps.length}개 / ${CFG.RAID_CH_SEC}초`,
    after:       `${deleted.length}개 삭제 완료 · 생성자 영구차단`,
    targetId:    state.creatorId ?? 'N/A',
    color:       0xFF4500,
  }));
}

/* ══════════════════════════════════════════════════════════════
   §21. 감사 로그 이벤트 핸들러
══════════════════════════════════════════════════════════════ */

/** 닉네임 변경 */
async function onNicknameChange(oldMember, newMember) {
  if (oldMember.nickname === newMember.nickname) return;
  await sendAuditLog(newMember.guild.id, buildAuditEmbed({
    actor:       sane(newMember.user.tag, 100),
    actorAvatar: newMember.user.displayAvatarURL(),
    target:      `@${sane(newMember.user.username, 100)}`,
    action:      'nickname changed',
    before:      oldMember.nickname ?? oldMember.user.username,
    after:       newMember.nickname ?? newMember.user.username,
    targetId:    newMember.id,
    color:       0x5865F2,
  }));
}

/** 역할 변경 */
async function onRoleChange(oldMember, newMember) {
  const added   = newMember.roles.cache.filter(r=>!oldMember.roles.cache.has(r.id));
  const removed = oldMember.roles.cache.filter(r=>!newMember.roles.cache.has(r.id));
  if (added.size === 0 && removed.size === 0) return;

  const addedStr   = added.size   > 0 ? added.map(r=>`@${r.name}`).join(', ')   : null;
  const removedStr = removed.size > 0 ? removed.map(r=>`@${r.name}`).join(', ') : null;

  await sendAuditLog(newMember.guild.id, buildAuditEmbed({
    actor:       sane(newMember.user.tag, 100),
    actorAvatar: newMember.user.displayAvatarURL(),
    target:      `@${sane(newMember.user.username, 100)}`,
    action:      'role updated',
    before:      removedStr ? `제거된 역할: ${removedStr}` : null,
    after:       addedStr   ? `추가된 역할: ${addedStr}`   : null,
    targetId:    newMember.id,
    color:       0xFFA500,
  }));
}

/** 멤버 입장 */
async function onMemberJoin(member) {
  await sendAuditLog(member.guild.id, buildAuditEmbed({
    actor:       sane(member.user.tag, 100),
    actorAvatar: member.user.displayAvatarURL(),
    target:      `@${sane(member.user.username, 100)}`,
    action:      'joined the server',
    before:      null,
    after:       `계정 생성: ${fmtDate(member.user.createdAt)}`,
    targetId:    member.id,
    color:       0x00FF99,
  }));
}

/** 멤버 퇴장 */
async function onMemberLeave(member) {
  await sendAuditLog(member.guild.id, buildAuditEmbed({
    actor:       sane(member.user.tag, 100),
    actorAvatar: member.user.displayAvatarURL(),
    target:      `@${sane(member.user.username, 100)}`,
    action:      'left the server',
    before:      `입장: ${fmtDate(member.joinedAt)}`,
    after:       null,
    targetId:    member.id,
    color:       0x808080,
  }));
}

/** 멤버 밴 */
async function onMemberBan(guild, user) {
  await sendAuditLog(guild.id, buildAuditEmbed({
    actor:       sane(user.tag, 100),
    actorAvatar: user.displayAvatarURL?.() ?? undefined,
    target:      `@${sane(user.username, 100)}`,
    action:      'was banned from the server',
    before:      null,
    after:       '서버에서 영구 차단됨',
    targetId:    user.id,
    color:       0xFF0000,
  }));
}

/** 멤버 언밴 */
async function onMemberUnban(guild, user) {
  await sendAuditLog(guild.id, buildAuditEmbed({
    actor:       sane(user.tag, 100),
    actorAvatar: user.displayAvatarURL?.() ?? undefined,
    target:      `@${sane(user.username, 100)}`,
    action:      'was unbanned from the server',
    before:      '차단됨',
    after:       '차단 해제됨',
    targetId:    user.id,
    color:       0x00AAFF,
  }));
}

/** 메시지 수정 */
async function onMessageUpdate(oldMsg, newMsg) {
  if (!newMsg.guild || !newMsg.author || newMsg.author.bot) return;
  if (oldMsg.content === newMsg.content) return;
  await sendAuditLog(newMsg.guild.id, buildAuditEmbed({
    actor:       sane(newMsg.author.tag, 100),
    actorAvatar: newMsg.author.displayAvatarURL(),
    target:      `@${sane(newMsg.author.username, 100)}`,
    action:      `message edited in <#${newMsg.channel.id}>`,
    before:      oldMsg.content ? sane(oldMsg.content, 512) : '(내용 없음)',
    after:       sane(newMsg.content, 512),
    targetId:    newMsg.author.id,
    color:       0xFFCC00,
  }));
}

/** 메시지 삭제 */
async function onMessageDelete(msg) {
  if (!msg.guild || !msg.author || msg.author.bot) return;
  await sendAuditLog(msg.guild.id, buildAuditEmbed({
    actor:       sane(msg.author.tag, 100),
    actorAvatar: msg.author.displayAvatarURL(),
    target:      `@${sane(msg.author.username, 100)}`,
    action:      `message deleted in <#${msg.channel.id}>`,
    before:      msg.content ? sane(msg.content, 512) : '(내용 없음 또는 임베드)',
    after:       null,
    targetId:    msg.author.id,
    color:       0xFF6600,
  }));
}

/** 채널 생성 (로그용, Anti-Raid와 별개) */
async function onChannelCreateLog(channel) {
  if (!channel.guild) return;
  await sendAuditLog(channel.guild.id, buildAuditEmbed({
    actor:       '서버',
    actorAvatar: channel.guild.iconURL() ?? undefined,
    target:      `#${sane(channel.name, 100)}`,
    action:      'channel created',
    before:      null,
    after:       `타입: ${channel.type} · ID: ${channel.id}`,
    targetId:    channel.id,
    color:       0x27AE60,
  }));
}

/** 채널 삭제 (로그용) */
async function onChannelDeleteLog(channel) {
  if (!channel.guild) return;
  await sendAuditLog(channel.guild.id, buildAuditEmbed({
    actor:       '서버',
    actorAvatar: channel.guild.iconURL() ?? undefined,
    target:      `#${sane(channel.name, 100)}`,
    action:      'channel deleted',
    before:      `ID: ${channel.id}`,
    after:       null,
    targetId:    channel.id,
    color:       0xFF4500,
  }));
}

/* ══════════════════════════════════════════════════════════════
   §22. 에러·복구 Discord 알림
══════════════════════════════════════════════════════════════ */
const ERR_CD = Object.fromEntries(['kma','jma','ndms','usgs'].map(k=>[k,{msg:'',at:0}]));
async function notifyErr(src, err) {
  if (err?.cbOpen) return;
  const msg = err?.response?.data ? JSON.stringify(err.response.data).slice(0,300):(err?.message??'Unknown');
  log('ERROR',src,msg);
  const now=Date.now(), c=ERR_CD[src];
  if(c.msg===msg&&now-c.at<CFG.ERR_CD_MS) return;
  c.msg=msg; c.at=now;
  await broadcast({embeds:[new EmbedBuilder().setTitle(`⚠️ [${src.toUpperCase()}] API 오류`)
    .setColor(0xFF0000).addFields(
      {name:'내용',value:sane(msg,512)},
      {name:'HTTP',value:sane(err?.response?.status??err?.code??'-',30),inline:true},
      {name:'다음 시도',value:'20분 후',inline:true},
    ).setTimestamp()]}).catch(()=>{});
}
async function notifyRecover(src, n) {
  log('INFO',src,`복구 완료 (${n}번째 시도)`);
  await broadcast({embeds:[new EmbedBuilder().setTitle(`✅ [${src.toUpperCase()}] 복구됨`)
    .setColor(0x00FF99).setDescription(`${n}번째 시도에서 성공했습니다.`).setTimestamp()]}).catch(()=>{});
}

/* ══════════════════════════════════════════════════════════════
   §23. Embed 빌더 (KR · JP · INT)
══════════════════════════════════════════════════════════════ */
function buildKR({title,footer,loc,mag,depth,intensity,time,lat,lon,extra=[]}) {
  const {color,em}=magStyle(mag??0);
  const f=[
    {name:'📍 진원지',value:sane(loc||'알 수 없음',256),inline:false},
    {name:'📏 규모',value:mag!=null?`${em} M ${Number(mag).toFixed(1)}`:'-',inline:true},
    {name:'🕐 발생',value:fmtDate(time)||'-',inline:true},
  ];
  if(depth!=null)     f.push({name:'🔽 깊이',   value:`${Number(depth).toFixed(0)} km`,inline:true});
  if(intensity!=null) f.push({name:'📊 최대진도',value:sane(intensity,20),inline:true});
  f.push(...extra);
  f.push({name:'🗺️ 지도',value:`[Google Maps](${gmap(lat,lon,loc)})`,inline:true});
  return new EmbedBuilder().setTitle(sane(title??'🌏 국내 지진 발생',256)).setColor(color)
    .addFields(f).setFooter({text:sane(footer??'기상청 지진 정보',100)}).setTimestamp();
}
function buildJP({title,footer,titleKo,contentKo,mag,depth,lat,lon,isVolcano,isTsunami}) {
  const {color:bc,em}=mag?magStyle(mag):{color:0x5865F2,em:'⚪'};
  const color=isTsunami?0x0000FF:isVolcano?0xFF4500:bc;
  const f=[{name:'📍 제목',value:sane(titleKo??'정보 없음',256)}];
  if(mag!=null)   f.push({name:'📏 규모',value:`${em} M ${Number(mag).toFixed(1)}`,inline:true});
  if(depth!=null) f.push({name:'🔽 깊이',value:`${Number(depth).toFixed(0)} km`,inline:true});
  f.push({name:'🗺️ 지도',value:`[Google Maps](${gmap(lat,lon,titleKo)})`,inline:true});
  const e=new EmbedBuilder().setTitle(sane(title,256)).setColor(color)
    .addFields(f).setFooter({text:sane(footer??'일본 기상청 (JMA)',100)}).setTimestamp();
  if(contentKo) e.setDescription(sane(contentKo,CFG.EMBED_MAX));
  return e;
}
function buildINT({mag,place,time,depth,lat,lon,alert,tsunami,sig,magType,url}) {
  const {color:bc,em}=magStyle(mag??0);
  const pg=pagerMeta(alert); const color=alert&&alert!=='green'?pg.color:bc;
  const isMajor=tsunami||(alert&&alert!=='green')||(sig??0)>=600;
  const title=tsunami?'🌊 쓰나미 경보 동반 지진 (USGS)':isMajor?'🚨 중요 국외 지진 (USGS)':'🌐 국외 지진 발생 (USGS)';
  const f=[
    {name:'📍 위치',value:sane(place??'알 수 없음',256),inline:false},
    {name:'📏 규모',value:mag!=null?`${em} M ${Number(mag).toFixed(1)}${magType?` (${magType})`:''}`:'-',inline:true},
    {name:'🕐 발생',value:fmtDate(time)||'-',inline:true},
  ];
  if(depth!=null) f.push({name:'🔽 깊이',value:`${Number(depth).toFixed(0)} km`,inline:true});
  if(alert)       f.push({name:'⚠️ PAGER',value:`${pg.em} ${pg.label} (${sane(alert,20)})`,inline:true});
  if(tsunami)     f.push({name:'🌊 쓰나미',value:'⚠️ 경보 발령',inline:true});
  if(sig>0)       f.push({name:'📊 중요도',value:`${sig} / 1000`,inline:true});
  f.push({name:'🗺️ 지도',value:`[Google Maps](${gmap(lat,lon,place)})`,inline:true});
  if(url) f.push({name:'🔗 상세',value:`[USGS 페이지](${sane(url,300)})`,inline:true});
  return new EmbedBuilder().setTitle(title).setColor(color).addFields(f)
    .setFooter({text:'USGS Earthquake Hazards Program'})
    .setTimestamp(time?new Date(time):new Date());
}

/* ══════════════════════════════════════════════════════════════
   §24. fetchNDMS
══════════════════════════════════════════════════════════════ */
async function fetchNDMS() {
  if (!ENV.SAFETY_KEY) return;
  pruneSent();
  try {
    const items = await CB.ndms.exec(()=>withRetry(async()=>{
      const {data}=await HTTP.get(
        `https://www.safetydata.go.kr/V2/api/DSSP-IF-00247`+
        `?serviceKey=${encodeURIComponent(ENV.SAFETY_KEY)}&returnType=json&numOfRows=5&pageNo=1`
      );
      const body=data?.body??data?.Body??data?.response?.body??data;
      if(Array.isArray(body)) return body[0]?.data??body[0]?.items??body[0]?.item??[];
      if(body&&typeof body==='object') return body.data??body.items??body.item??[];
      return [];
    },'NDMS'));
    const list=Array.isArray(items)?items:(items?[items]:[]);
    let dirty=false;
    for (const e of list) {
      const id=sane(e.MD101_SN??e.md101Sn??e.SN??e.sn??e.msgId??'',100);
      if(!id||id==='없음'||SENT.ndms.has(id)) continue;
      markSent('ndms',id); dirty=true;
      const type=sane(e.DSSTR_SE_NM??e.dstrSeNm??'기타',50);
      const meta=ndmsMeta(type);
      await broadcast({embeds:[
        new EmbedBuilder().setTitle(`${meta.em} 긴급 재난 문자 — ${type}`).setColor(meta.color)
          .setDescription(sane(e.MSG_CN??e.msgCn??'',CFG.EMBED_MAX))
          .addFields(
            {name:'📍 수신 지역',value:sane(e.RCV_AREA_NM??e.rcvAreaNm??'전국',200),inline:true},
            {name:'🕐 발령 시각',value:fmtDate((e.CRT_DT??e.crtDt??'').replace(/\//g,'-'))||'-',inline:true},
          ).setFooter({text:'행정안전부 안전안내문자'}).setTimestamp(),
      ]});
    }
    if(dirty) await persist('ndms');
    const rc=onOk('ndms'); if(rc) await notifyRecover('ndms',rc);
  } catch(err){ if(err?.cbOpen)return; onErr('ndms'); await notifyErr('ndms',err); }
}

/* ══════════════════════════════════════════════════════════════
   §25. fetchKMA
══════════════════════════════════════════════════════════════ */
async function fetchKMA() {
  if (!ENV.KMA_KEY) return;
  try {
    const rows=await CB.kma.exec(()=>withRetry(async()=>{
      const now=kst(), to=now.toISOString().slice(0,10).replace(/-/g,'');
      const from=new Date(+now-2*86_400_000).toISOString().slice(0,10).replace(/-/g,'');
      const {data}=await HTTP.get(
        `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg`+
        `?serviceKey=${encodeURIComponent(ENV.KMA_KEY)}&numOfRows=10&pageNo=1`+
        `&dataType=JSON&fromTmFc=${from}&toTmFc=${to}`
      );
      const code=String(data?.response?.header?.resultCode??'');
      if(code&&!CFG.KMA_OK.has(code))
        throw new Error(`resultCode=${code} ${data?.response?.header?.resultMsg??''}`);
      if(code==='03') return [];
      const raw=data?.response?.body?.items?.item;
      return Array.isArray(raw)?raw:(raw?[raw]:[]);
    },'KMA'));
    let dirty=false;
    for (const e of rows) {
      const id=`${e.tmEqk}_${sane(e.loc,100)}`;
      if(!e.tmEqk||SENT.kma.has(id)) continue;
      const mag=e.mt!=null?+e.mt:null, dep=e.dep!=null?+e.dep:null;
      const lat=e.tmLa!=null?+e.tmLa:null, lon=e.tmLo!=null?+e.tmLo:null;
      let timeMs=null;
      try {
        const t=String(e.tmEqk);
        if(t.length>=12){
          const iso=`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:00+09:00`;
          timeMs=new Date(iso).getTime();
        }
      } catch {}
      if(isDuplicateEvent({src:'KMA',lat,lon,mag,timeMs})){markSent('kma',id);dirty=true;continue;}
      markSent('kma',id); dirty=true;
      await broadcast({embeds:[buildKR({
        title:'🌏 국내 지진 발생 (기상청)',footer:'기상청 지진 정보',
        loc:sane(e.loc,256),mag,depth:dep,
        intensity:e.mtSt!=null?sane(e.mtSt,20):null,
        time:String(e.tmEqk),lat,lon,
      })]});
    }
    if(dirty) await persist('kma');
    const rc=onOk('kma'); if(rc) await notifyRecover('kma',rc);
  } catch(err){ if(err?.cbOpen)return; onErr('kma'); await notifyErr('kma',err); }
}

/* ══════════════════════════════════════════════════════════════
   §26. fetchJMA
══════════════════════════════════════════════════════════════ */
async function fetchJMA() {
  try {
    const entries=await CB.jma.exec(()=>withRetry(async()=>{
      const {data}=await HTTP.get('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml',
        {headers:{Accept:'application/xml, text/xml, */*'}});
      const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',trimValues:true});
      const e=parser.parse(data)?.feed?.entry;
      return Array.isArray(e)?e.slice(0,10):(e?[e]:[]);
    },'JMA'));
    let dirty=false;
    for (const e of entries) {
      const id=sane(e.id??e['@_id']??'',300);
      if(!id||id==='없음'||SENT.jma.has(id)) continue;
      const rawTitle=typeof e.title==='string'?e.title:(e.title?.['#text']??'');
      const rawContent=typeof e.content==='string'?e.content:(e.content?.['#text']??rawTitle);
      const rawSummary=typeof e.summary==='string'?e.summary:(e.summary?.['#text']??'');
      const rawText=rawContent||rawSummary||rawTitle;
      const [titleKo,contentKo]=await Promise.all([toKo(rawTitle),toKo(rawText)]);
      const nums=parseJMANums(rawText);
      const isVolcano=/火山|噴火/.test(rawTitle), isTsunami=/津波/.test(rawTitle);
      const timeMs=e.updated?new Date(e.updated).getTime():null;
      if(!isVolcano&&isDuplicateEvent({src:'JMA',lat:nums.lat,lon:nums.lon,mag:nums.mag,timeMs})){
        markSent('jma',id);dirty=true;continue;
      }
      markSent('jma',id); dirty=true;
      const title=isTsunami?'🌊 쓰나미 경보 (JMA)':isVolcano?'🌋 일본 화산 정보 (JMA)':'🌏 일본 지진 발생 (JMA)';
      await broadcast({embeds:[buildJP({
        title,footer:'일본 기상청 (JMA)',titleKo,contentKo,
        mag:nums.mag,depth:nums.depth,lat:nums.lat,lon:nums.lon,isVolcano,isTsunami,
      })]});
    }
    if(dirty) await persist('jma');
    const rc=onOk('jma'); if(rc) await notifyRecover('jma',rc);
  } catch(err){ if(err?.cbOpen)return; onErr('jma'); await notifyErr('jma',err); }
}

/* ══════════════════════════════════════════════════════════════
   §27. fetchUSGS
══════════════════════════════════════════════════════════════ */
let usgsAfter=null;
async function fetchUSGS() {
  try {
    const features=await CB.usgs.exec(()=>withRetry(async()=>{
      const after=usgsAfter??new Date(Date.now()-10*60_000).toISOString();
      const qs=new URLSearchParams({
        format:'geojson',updatedafter:after,
        minmagnitude:String(CFG.USGS_MIN_MAG),orderby:'time',limit:String(CFG.USGS_LIMIT),
      });
      const {data}=await HTTP.get(`${CFG.USGS_URL}?${qs}`);
      if(!data?.features) throw new Error('features 없음');
      usgsAfter=new Date().toISOString();
      return data.features;
    },'USGS'));
    let dirty=false;
    for (const f of features) {
      const id=sane(f.id??'',200); if(!id||id==='없음'||SENT.usgs.has(id)) continue;
      const p=f.properties??{}, geo=f.geometry?.coordinates;
      const lon=geo?.[0]??null, lat=geo?.[1]??null, depth=geo?.[2]??null;
      const mag=p.mag!=null?+p.mag:null, timeMs=p.time??null;
      if(isDuplicateEvent({src:'USGS',lat,lon,mag,timeMs})){markSent('usgs',id);dirty=true;continue;}
      markSent('usgs',id); dirty=true;
      const region=geoRegion(lat,lon);
      let embed;
      if(region==='KR'){
        embed=buildKR({
          title:'🌏 국내 인근 지진 (USGS 보조)',footer:'USGS · 한반도 지역',
          loc:sane(p.place,256),mag,depth,intensity:null,time:timeMs,lat,lon,
          extra:p.alert?[{name:'⚠️ PAGER',value:`${pagerMeta(p.alert).em} ${pagerMeta(p.alert).label}`,inline:true}]:[],
        });
      } else if(region==='JP'){
        const placeKo=await toKo(p.place??'');
        embed=buildJP({
          title:p.tsunami===1?'🌊 쓰나미 경보 동반 지진 (USGS·일본)':'🌏 일본 인근 지진 (USGS 보조)',
          footer:'USGS · 일본 지역',titleKo:placeKo,contentKo:null,
          mag,depth,lat,lon,isVolcano:false,isTsunami:p.tsunami===1,
        });
      } else {
        embed=buildINT({
          mag,place:sane(p.place,256),time:timeMs,depth,lat,lon,
          alert:p.alert,tsunami:p.tsunami===1,sig:p.sig??0,
          magType:sane(p.magType,20),url:sane(p.url,300),
        });
      }
      await broadcast({embeds:[embed]});
    }
    if(dirty) await persist('usgs');
    const rc=onOk('usgs'); if(rc) await notifyRecover('usgs',rc);
  } catch(err){ if(err?.cbOpen)return; onErr('usgs'); await notifyErr('usgs',err); }
}

/* ══════════════════════════════════════════════════════════════
   §28. 동적 폴링 루프
══════════════════════════════════════════════════════════════ */
function startLoop(fn, normalMs, src) {
  let active=true;
  const tick=async()=>{
    if(!active) return;
    try { await fn(); } catch {}
    const isErr=TRK[src].streak>0||CB[src].isOpen;
    const next=isErr?CFG.MS_ERR:normalMs;
    if(isErr) log('INFO',src,`에러→${next/60_000}분 후 재시도`);
    setTimeout(tick,next);
  };
  tick();
  return ()=>{ active=false; };
}

/* ══════════════════════════════════════════════════════════════
   §29. 슬래시 커맨드 정의
══════════════════════════════════════════════════════════════ */
const CMDS = [
  { name:'상태',   description:'봇 및 API 상태 확인' },
  { name:'마지막', description:'마지막 성공 조회 시각' },
  { name:'중복',   description:'Cross-Source 중복 판별 현황' },
  { name:'지역',   description:'USGS 지역 분류 기준' },
  { name:'도움말', description:'봇 기능 전체 안내' },
  { name:'청소',   description:'캐시 초기화 (OWNER 전용)' },
  {
    name:'알림',
    description:'재난 알림을 받을 채널 설정 (OWNER 전용)',
    options:[{
      name:'채널id',
      description:'알림을 받을 채널의 ID',
      type: ApplicationCommandOptionType.String,
      required:true,
    }],
  },
  {
    name:'로그',
    description:'감사 로그를 기록할 채널 설정 (OWNER 전용)',
    options:[{
      name:'채널id',
      description:'로그를 기록할 채널의 ID',
      type: ApplicationCommandOptionType.String,
      required:true,
    }],
  },
];

/* ══════════════════════════════════════════════════════════════
   §30. Discord Ready
══════════════════════════════════════════════════════════════ */
discord.once(Events.ClientReady, async () => {
  log('INFO','BOT',`준비 완료: ${discord.user.tag}`);
  await initStorage();
  await loadGuildConfig();

  const stops=[
    startLoop(fetchNDMS, CFG.MS_NDMS,'ndms'),
    startLoop(fetchKMA,  CFG.MS_EQ,  'kma'),
    startLoop(fetchJMA,  CFG.MS_EQ,  'jma'),
    startLoop(fetchUSGS, CFG.MS_EQ,  'usgs'),
  ];
  SHUTDOWN.push(()=>stops.forEach(s=>s()));

  const pt=setInterval(pruneSent, 3_600_000);
  SHUTDOWN.push(()=>clearInterval(pt));

  // 1시간마다 mentionLog 정리 (메모리 누수 방지)
  const ml=setInterval(()=>{
    const now=Date.now(), win=CFG.RAID_MENTION_SEC*1_000;
    for (const [uid,times] of mentionLog) {
      const t=times.filter(x=>now-x<win*10); // 10배 여유
      if(t.length===0) mentionLog.delete(uid); else mentionLog.set(uid,t);
    }
    channelLog.clear(); // 채널 로그는 주기적으로 전체 초기화
  }, 3_600_000);
  SHUTDOWN.push(()=>clearInterval(ml));

  if (ENV.APPLICATION_ID) {
    const rest=new REST({version:'10'}).setToken(ENV.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(ENV.APPLICATION_ID),{body:CMDS})
      .then(()=>log('INFO','BOT','슬래시 커맨드 등록 완료'))
      .catch(e=>log('WARN','BOT','커맨드 등록 실패',e.message));
  }
});

/* ══════════════════════════════════════════════════════════════
   §31. 이벤트 핸들러 등록
══════════════════════════════════════════════════════════════ */
// Anti-Raid: @everyone 스팸
discord.on(Events.MessageCreate, msg => { if(!msg.author?.bot) handleEveryoneMention(msg).catch(()=>{}); });

// Anti-Raid: 채널 홍수
discord.on(Events.ChannelCreate, ch => {
  handleChannelCreate(ch).catch(()=>{});
  onChannelCreateLog(ch).catch(()=>{});
});

// 감사 로그
discord.on(Events.ChannelDelete,     ch  => onChannelDeleteLog(ch).catch(()=>{}));
discord.on(Events.GuildMemberAdd,    m   => onMemberJoin(m).catch(()=>{}));
discord.on(Events.GuildMemberRemove, m   => onMemberLeave(m).catch(()=>{}));
discord.on(Events.GuildBanAdd,       (g,u)=> onMemberBan(g,u).catch(()=>{}));
discord.on(Events.GuildBanRemove,    (g,u)=> onMemberUnban(g,u).catch(()=>{}));
discord.on(Events.MessageUpdate,     (o,n)=> onMessageUpdate(o,n).catch(()=>{}));
discord.on(Events.MessageDelete,     m   => onMessageDelete(m).catch(()=>{}));
discord.on(Events.GuildMemberUpdate, (o,n)=>{
  onNicknameChange(o,n).catch(()=>{});
  onRoleChange(o,n).catch(()=>{});
});

/* ══════════════════════════════════════════════════════════════
   §32. 슬래시 커맨드 인터랙션
══════════════════════════════════════════════════════════════ */
discord.on(Events.InteractionCreate, async ix => {
  if (!ix.isChatInputCommand()) return;
  const cmd=ix.commandName;
  const isOwner=!ENV.OWNER_ID || ix.user.id===ENV.OWNER_ID;

  /* OWNER 전용 커맨드 */
  const ownerCmds=['청소','알림','로그'];
  if (ownerCmds.includes(cmd) && !isOwner)
    return ix.reply({content:'❌ OWNER 전용 명령어입니다.',ephemeral:true});

  /* /알림 채널id:[ID] */
  if (cmd==='알림') {
    const chId=ix.options.getString('채널id','').trim();
    if (!/^\d{17,20}$/.test(chId))
      return ix.reply({content:'❌ 올바른 채널 ID를 입력하세요. (17~20자리 숫자)',ephemeral:true});
    try {
      const ch=await discord.channels.fetch(chId);
      if (!ch?.isTextBased()) return ix.reply({content:'❌ 텍스트 채널 ID를 입력하세요.',ephemeral:true});
      const gid=ix.guildId??'global';
      const cfg=GUILD_CFG.get(gid)??{alertChannel:null,logChannel:null};
      cfg.alertChannel=chId;
      GUILD_CFG.set(gid, cfg);
      await persist('config');
      log('INFO','GCFG',`알림 채널 설정: ${gid} → ${chId}`);
      return ix.reply({content:`✅ 재난 알림 채널이 <#${chId}>로 설정되었습니다.`,ephemeral:true});
    } catch(e){
      return ix.reply({content:`❌ 채널을 찾을 수 없습니다: ${sane(e.message,100)}`,ephemeral:true});
    }
  }

  /* /로그 채널id:[ID] */
  if (cmd==='로그') {
    const chId=ix.options.getString('채널id','').trim();
    if (!/^\d{17,20}$/.test(chId))
      return ix.reply({content:'❌ 올바른 채널 ID를 입력하세요. (17~20자리 숫자)',ephemeral:true});
    try {
      const ch=await discord.channels.fetch(chId);
      if (!ch?.isTextBased()) return ix.reply({content:'❌ 텍스트 채널 ID를 입력하세요.',ephemeral:true});
      const gid=ix.guildId??'global';
      const cfg=GUILD_CFG.get(gid)??{alertChannel:null,logChannel:null};
      cfg.logChannel=chId;
      GUILD_CFG.set(gid, cfg);
      await persist('config');
      log('INFO','GCFG',`로그 채널 설정: ${gid} → ${chId}`);
      return ix.reply({content:`✅ 감사 로그 채널이 <#${chId}>로 설정되었습니다.`,ephemeral:true});
    } catch(e){
      return ix.reply({content:`❌ 채널을 찾을 수 없습니다: ${sane(e.message,100)}`,ephemeral:true});
    }
  }

  /* /상태 */
  if (cmd==='상태') {
    const up=process.uptime(), anyErr=Object.values(TRK).some(t=>t.streak>0);
    return ix.reply({embeds:[
      new EmbedBuilder().setTitle('📊 봇 시스템 상태').setColor(anyErr?0xFF6600:0x00FF99)
        .addFields(
          {name:'🕐 가동',value:`${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${Math.floor(up%60)}s`,inline:false},
          {name:'📢 NDMS', value:CB.ndms.badge(),inline:true},
          {name:'🌏 KMA',  value:CB.kma.badge(), inline:true},
          {name:'🗾 JMA',  value:CB.jma.badge(), inline:true},
          {name:'🌐 USGS', value:CB.usgs.badge(),inline:true},
          {name:'🔄 중복 레코드',value:`${GEV.length} / ${CFG.DEDUP_MAX}`,inline:true},
          {name:'🔁 에러 시 주기',value:'20분 · CB 3회→차단→5분 후 복구',inline:false},
        ).setFooter({text:'CB = Circuit Breaker'}).setTimestamp(),
    ]});
  }

  /* /마지막 */
  if (cmd==='마지막') {
    return ix.reply({embeds:[
      new EmbedBuilder().setTitle('🕐 마지막 성공 조회').setColor(0x5865F2)
        .addFields(
          {name:'📢 NDMS',value:TRK.ndms.lastOk?fmtDate(TRK.ndms.lastOk):'없음',inline:true},
          {name:'🌏 KMA', value:TRK.kma.lastOk ?fmtDate(TRK.kma.lastOk) :'없음',inline:true},
          {name:'🗾 JMA', value:TRK.jma.lastOk ?fmtDate(TRK.jma.lastOk) :'없음',inline:true},
          {name:'🌐 USGS',value:TRK.usgs.lastOk?fmtDate(TRK.usgs.lastOk):'없음',inline:true},
          {name:'🔁 주기',value:'NDMS 2분 / KMA·JMA·USGS 5분',inline:false},
        ).setTimestamp(),
    ]});
  }

  /* /중복 */
  if (cmd==='중복') {
    const bySrc={};
    for (const ev of GEV) bySrc[ev.src]=(bySrc[ev.src]??0)+1;
    return ix.reply({embeds:[
      new EmbedBuilder().setTitle('🔄 Cross-Source 중복 판별').setColor(0x5865F2)
        .addFields(
          {name:'레코드 수',value:`${GEV.length} / ${CFG.DEDUP_MAX}`,inline:true},
          {name:'소스별',value:Object.entries(bySrc).map(([s,n])=>`${s}: ${n}`).join('\n')||'없음',inline:true},
          {name:'판별 기준',value:`거리 ≤${CFG.DEDUP_DIST_KM}km · 규모 ±${CFG.DEDUP_MAG_D} · 시각 ±${CFG.DEDUP_TIME_MS/60_000}분`,inline:false},
        ).setTimestamp(),
    ]});
  }

  /* /지역 */
  if (cmd==='지역') {
    const {KR,JP}=CFG.GEO;
    return ix.reply({embeds:[
      new EmbedBuilder().setTitle('🗺️ USGS 지역 분류 기준').setColor(0x5865F2)
        .addFields(
          {name:'🇰🇷 KR',value:`위도 ${KR.latMin}°~${KR.latMax}° / 경도 ${KR.lonMin}°~${KR.lonMax}°`,inline:false},
          {name:'🇯🇵 JP',value:`위도 ${JP.latMin}°~${JP.latMax}° / 경도 ${JP.lonMin}°~${JP.lonMax}°`,inline:false},
          {name:'🌐 INT',value:'위 두 범위 외 전 세계 → 국외 임베드',inline:false},
        ).setTimestamp(),
    ]});
  }

  /* /청소 */
  if (cmd==='청소') {
    const cnt=Object.fromEntries(Object.entries(SENT).map(([k,m])=>[k,m.size]));
    Object.values(SENT).forEach(m=>m.clear());
    Object.values(ERR_CD).forEach(c=>{c.msg='';c.at=0;});
    XL.clear(); GEV.length=0; usgsAfter=null;
    mentionLog.clear(); channelLog.clear();
    await Promise.all(['kma','jma','ndms','usgs'].map(persist));
    return ix.reply({content:
      `🧹 캐시 초기화 완료\nNDMS ${cnt.ndms} / KMA ${cnt.kma} / JMA ${cnt.jma} / USGS ${cnt.usgs} 개 삭제`,
      ephemeral:true,
    });
  }

  /* /도움말 */
  if (cmd==='도움말') {
    return ix.reply({embeds:[
      new EmbedBuilder().setTitle('📖 재난 알림 봇 v8 도움말').setColor(0x5865F2)
        .setDescription('국내외 지진·화산·쓰나미·재난문자 통합 실시간 알림 봇')
        .addFields(
          {name:'📢 NDMS',value:'안전안내문자 **2분** · 유형별 색상(16종)',inline:true},
          {name:'🌏 KMA', value:'국내 지진 **5분**',inline:true},
          {name:'🗾 JMA', value:'일본 지진·화산 **5분** (자동 번역)',inline:true},
          {name:'🌐 USGS',value:'M4.5+ 전세계 **5분** · 한국/일본/국외 자동 분류',inline:false},
          {name:'🛡️ Anti-Raid',
           value:`@everyone 스팸 (${CFG.RAID_MENTION_SEC}초 내 ${CFG.RAID_MENTION_LIMIT}회) → 영구차단 + 삭제\n채널 홍수 (${CFG.RAID_CH_SEC}초 내 ${CFG.RAID_CH_LIMIT}개) → 채널 삭제 + 차단`,
           inline:false},
          {name:'📋 감사 로그',value:'닉네임·역할·입퇴장·밴·메시지수정/삭제·채널생성/삭제',inline:false},
          {name:'⚙️ OWNER 커맨드',
           value:'`/알림 채널id:[ID]` — 알림 채널 설정\n`/로그 채널id:[ID]` — 감사 로그 채널 설정\n`/청소` — 캐시 초기화',
           inline:false},
          {name:'📊 일반 커맨드',value:'`/상태` `/마지막` `/중복` `/지역` `/도움말`',inline:false},
          {name:'🎨 규모 색상',value:'⚪M3미만 🔵M3+ 🟡M4+ 🟠M5+ 🔴M6+ 🆘M7+',inline:false},
        ).setFooter({text:'에러 자동 알림 · 동일 에러 10분 쿨다운'}).setTimestamp(),
    ]});
  }
});

/* ══════════════════════════════════════════════════════════════
   §33. Express 웹 서버 (보안 헤더 포함)
══════════════════════════════════════════════════════════════ */
const app=express();
const server=app.listen(CFG.PORT,()=>log('INFO','WEB',`포트 ${CFG.PORT}`));

// 보안 헤더
app.use((_,res,next)=>{
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Permissions-Policy',      'geolocation=(), microphone=()');
  next();
});
app.get('/health',(_,res)=>{
  const anyOpen=Object.values(CB).some(c=>c.isOpen);
  res.status(anyOpen?503:200).json({healthy:!anyOpen});
});
app.get('/',(_,res)=>res.json({
  version:'8.0.0',status:'running',uptime:Math.floor(process.uptime()),
  circuit:Object.fromEntries(Object.entries(CB).map(([k,v])=>[k,v.state])),
  lastOk: Object.fromEntries(Object.entries(TRK).map(([k,v])=>[k,v.lastOk])),
  dedupRecords:GEV.length,
}));
app.use((_,res)=>res.status(404).json({error:'Not Found'}));

/* ══════════════════════════════════════════════════════════════
   §34. Graceful Shutdown
══════════════════════════════════════════════════════════════ */
const SHUTDOWN=[]; let shutting=false;
async function graceful(sig) {
  if(shutting) return; shutting=true;
  log('INFO','SYS',`${sig} — 종료 시작`);
  const force=setTimeout(()=>{log('WARN','SYS','강제 종료');process.exit(1);},CFG.SHUTDOWN_MS);
  force.unref();
  try {
    SHUTDOWN.forEach(fn=>fn());
    await new Promise(r=>server.close(r));
    const t0=Date.now(); while(Q.length>0&&Date.now()-t0<5_000) await sleep(100);
    await discord.destroy();
    log('INFO','SYS','정상 종료');
    clearTimeout(force); process.exit(0);
  } catch(e){ log('ERROR','SYS','종료 오류',e.message); process.exit(1); }
}
process.once('SIGTERM',()=>graceful('SIGTERM'));
process.once('SIGINT', ()=>graceful('SIGINT'));
process.on('uncaughtException',  e=>log('ERROR','SYS','uncaughtException',  e.message));
process.on('unhandledRejection', e=>log('ERROR','SYS','unhandledRejection', e?.message??String(e)));

/* ══════════════════════════════════════════════════════════════
   §35. Discord 로그인
══════════════════════════════════════════════════════════════ */
discord.login(ENV.DISCORD_TOKEN)
  .catch(e=>{ log('FATAL','BOT','로그인 실패',e.message); process.exit(1); });