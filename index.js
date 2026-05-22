import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import {
  Client, GatewayIntentBits, Partials, Options,
  EmbedBuilder, REST, Routes, Events,
  ApplicationCommandOptionType, AuditLogEvent
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, CRITICAL: 4, FATAL: 5 };
let LOG_LEVEL = process.env.NODE_ENV === 'development' ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

const requiredEnv = ['DISCORD_TOKEN', 'KMA_KEY', 'SAFETY_KEY'];
for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`❌ ${env} 필수`);
    process.exit(1);
  }
}

const ENV = Object.freeze({
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  KMA_KEY: process.env.KMA_KEY,
  SAFETY_KEY: process.env.SAFETY_KEY,
  APPLICATION_ID: process.env.APPLICATION_ID || '',
  OWNER_ID: process.env.OWNER_ID || '',
  ROLE: process.env.ROLE || '',
  PORT: Number(process.env.PORT) || 3000,
  CHANNEL_IDS: (process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
});

const CFG = Object.freeze({
  MS: { NDMS: 2 * 60_000, KMA: 5 * 60_000, JMA: 30_000, ERR: 20 * 60_000 },
  RETRY: { BASE: [1_000, 3_000], JITTER: 0.1 },
  CB: { THRESH: 3, HALF_MS: 5 * 60_000, ERR_CD_MS: 10 * 60_000 },
  CACHE: { TTL: 24 * 3_600_000, SENT_MAX: 1_200, MSG_BUFFER: 0 },
  DEDUP: { DIST_KM: 80, MAG_D: 0.5, TIME_MS: 5 * 60_000, MAX: 200 },
  REGIONS: {
    KR: { name: '한국', lat: [33.0, 38.9], lon: [124.5, 132.0] },
    CN: { name: '중국', lat: [18.0, 53.0], lon: [73.0, 135.0] },
    JP: { name: '일본', lat: [30.0, 45.0], lon: [130.0, 145.0] },
  },
  BROADCAST_GAP: 50,
  SHUTDOWN_MS: 8_000,
  API_TIMEOUT: 4_000,
  MAX_CONCURRENT: 20,
  VERIFY: {
    DAYS: 50,
    COUNTER_SAVE_MS: 15_000,
  },
  ANTISPAM: {
    MAX_MSG: 15,
    WINDOW_MS: 3000,
    TIMEOUT_MS: 60 * 60 * 1000,
    BAN_THRESHOLD: 10,
  }
});

class Logger {
  constructor(source) {
    this.source = String(source).padEnd(6);
    this.buffer = [];
    this.flushTimer = setInterval(() => this.flush(), 3000);
    this.flushTimer.unref();
  }

  log(level, msg, extra = '') {
    if (LOG_LEVELS[level] < LOG_LEVEL) return;
    const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const ex = extra ? ` | ${String(extra).slice(0, 80)}` : '';
    this.buffer.push(`${ts} [${level.padEnd(8)}][${this.source}] ${msg}${ex}`);
    
    if (this.buffer.length >= 100 || level === 'FATAL') this.flush();
  }

  flush() {
    if (this.buffer.length === 0) return;
    const logStr = this.buffer.join('\n');
    console.log(logStr);
    this.buffer = [];
  }

  destroy() {
    clearInterval(this.flushTimer);
    this.flush();
  }

  debug(msg, ex) { this.log('DEBUG', msg, ex); }
  info(msg, ex) { this.log('INFO', msg, ex); }
  warn(msg, ex) { this.log('WARN', msg, ex); }
  error(msg, ex) { this.log('ERROR', msg, ex); }
  critical(msg, ex) { this.log('CRITICAL', msg, ex); }
  fatal(msg, ex) { this.log('FATAL', msg, ex); process.exit(1); }
}

const mainLogger = new Logger('MAIN');
const securityLogger = new Logger('SECURE');

class Metrics {
  constructor() {
    this.eq = 0;
    this.apiCalls = new Map();
    this.errors = new Map();
    this.startTime = Date.now();
  }

  addEq() { this.eq++; }
  
  recordApiCall(src, ms) {
    const stat = this.apiCalls.get(src) || { n: 0, t: 0 };
    stat.n++;
    stat.t += ms;
    if (stat.n > 500) { stat.n = 250; stat.t = Math.round(stat.t / 2); }
    this.apiCalls.set(src, stat);
  }

  recordErr(src) {
    this.errors.set(src, (this.errors.get(src) ?? 0) + 1);
  }

  getStats() {
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const avgTime = {};
    for (const [s, { n, t }] of this.apiCalls) avgTime[s] = n ? Math.round(t / n) : 0;
    
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      earthquakes: this.eq,
      memory: mem,
      avgResponseTime: avgTime,
      errors: Object.fromEntries(this.errors),
    };
  }
}

const metrics = new Metrics();

const DANGER_RE = /[<>"'`\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const sane = (v, max = 1024) => 
  v == null ? '없음' : String(v).replace(DANGER_RE, '').slice(0, max) || '없음';

class Earthquake {
  constructor(data) {
    this.id = String(data.id || '').slice(0, 100);
    this.source = data.source;
    this.location = String(data.location || 'Unknown').slice(0, 200);
    this.lat = typeof data.latitude === 'number' ? data.latitude : null;
    this.lon = typeof data.longitude === 'number' ? data.longitude : null;
    this.mag = typeof data.magnitude === 'number' ? data.magnitude : null;
    this.depth = typeof data.depth === 'number' ? data.depth : null;
    this.intensity = data.intensity ? String(data.intensity).slice(0, 50) : null;
    this.time = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
  }

  get aftershockProb() {
    if (!this.mag || this.mag < 4) return null;
    if (this.mag < 5) return '5~20%';
    if (this.mag < 6) return '20~40%';
    if (this.mag < 7) return '40~65%';
    return '65~80%';
  }

  get mmi() {
    if (!this.mag) return null;
    if (this.mag < 3) return 'I~II';
    if (this.mag < 4) return 'III~IV';
    if (this.mag < 5) return 'V~VI';
    if (this.mag < 6) return 'VI~VII';
    if (this.mag < 7) return 'VII~VIII';
    return 'VIII~X';
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, d2r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d2r / 2) ** 2 + 
            Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin((lon2 - lon1) * d2r / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const GEV = [];

function isDuplicate({ src, lat, lon, mag, time }) {
  const now = Date.now(), cutoff = now - CFG.CACHE.TTL;
  
  while (GEV.length > 0 && GEV[GEV.length - 1].at < cutoff) GEV.pop();
  if (GEV.length >= CFG.DEDUP.MAX) GEV.pop();

  if (!lat || !lon) {
    GEV.unshift({ src, lat, lon, mag, time, at: now });
    return false;
  }

  const scanLimit = Math.min(15, GEV.length);
  for (let i = 0; i < scanLimit; i++) {
    const ev = GEV[i];
    if (!ev.lat || !ev.lon) continue;
    if (Math.abs(mag - ev.mag) <= CFG.DEDUP.MAG_D &&
        Math.abs(time - ev.time) <= CFG.DEDUP.TIME_MS &&
        haversineKm(lat, lon, ev.lat, ev.lon) <= CFG.DEDUP.DIST_KM) {
      return true;
    }
  }

  GEV.unshift({ src, lat, lon, mag, time, at: now });
  return false;
}

function getRegion(lat, lon) {
  if (!lat || !lon) return null;
  if (lat >= 33.0 && lat <= 38.9 && lon >= 124.5 && lon <= 132.0) return 'KR';
  if (lat >= 30.0 && lat <= 45.0 && lon >= 130.0 && lon <= 145.0) return 'JP';
  if (lat >= 18.0 && lat <= 53.0 && lon >= 73.0 && lon <= 135.0) return 'CN';
  return null;
}

class CircuitBreaker {
  constructor(name) {
    this.name = name;
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
  }

  async exec(fn) {
    if (this.state === 'OPEN') {
      const wait = CFG.CB.HALF_MS - (Date.now() - this.openedAt);
      if (wait > 0) throw { cbOpen: true };
      this.state = 'HALF_OPEN';
    }

    try {
      const r = await fn();
      if (this.failures > 0) this.state = 'CLOSED';
      this.failures = 0;
      return r;
    } catch (e) {
      if (!e.cbOpen) {
        this.failures++;
        if (this.failures >= CFG.CB.THRESH) {
          this.state = 'OPEN';
          this.openedAt = Date.now();
        }
      }
      throw e;
    }
  }

  forceClose() {
    this.state = 'CLOSED';
    this.failures = 0;
  }

  badge() {
    if (this.state === 'CLOSED') return '✅';
    if (this.state === 'HALF_OPEN') return '🟡';
    return `❌ ${Math.ceil((CFG.CB.HALF_MS - (Date.now() - this.openedAt)) / 1000)}s`;
  }
}

const CB = { kma: new CircuitBreaker('KMA'), jma: new CircuitBreaker('JMA'), ndms: new CircuitBreaker('NDMS') };
const TRK = { kma: { streak: 0, lastOk: null }, jma: { streak: 0, lastOk: null }, ndms: { streak: 0, lastOk: null } };

const SENT = { kma: new Map(), jma: new Map(), ndms: new Map() };
const GUILD_CFG = new Map();
const MEMBERS = new Map();
const SPAM_STREAKS = new Map();
let VERIFY_COUNTER = 0;
const DATA_DIR = path.resolve(__dirname, 'data');

async function initStorage() {
  const logger = new Logger('STORAGE');
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const loadTasks = [
      ...Object.entries(SENT).map(async ([src, map]) => {
        try {
          const raw = await fs.readFile(path.join(DATA_DIR, `${src}.json`), 'utf8');
          const data = JSON.parse(raw);
          if (Array.isArray(data)) data.forEach(([id, ts]) => map.set(id, ts || Date.now()));
        } catch {
          await fs.writeFile(path.join(DATA_DIR, `${src}.json`), '[]', 'utf8').catch(() => {});
        }
      }),
      (async () => {
        try {
          const raw = await fs.readFile(path.join(DATA_DIR, 'config.json'), 'utf8');
          const cfgs = JSON.parse(raw);
          Object.entries(cfgs).forEach(([id, cfg]) => GUILD_CFG.set(id, cfg));
        } catch {
          await fs.writeFile(path.join(DATA_DIR, 'config.json'), '{}', 'utf8').catch(() => {});
        }
      })(),
      (async () => {
        try {
          const raw = await fs.readFile(path.join(DATA_DIR, 'members.json'), 'utf8');
          const memberData = JSON.parse(raw);
          if (memberData.counter) VERIFY_COUNTER = memberData.counter;
          if (memberData.members) {
            Object.entries(memberData.members).forEach(([id, data]) => MEMBERS.set(id, data));
          }
          if (memberData.spamStreaks) {
            Object.entries(memberData.spamStreaks).forEach(([id, count]) => SPAM_STREAKS.set(id, count));
          }
        } catch {
          await fs.writeFile(path.join(DATA_DIR, 'members.json'), JSON.stringify({ counter: 0, members: {}, spamStreaks: {} }), 'utf8').catch(() => {});
        }
      })()
    ];

    await Promise.all(loadTasks);
    logger.info('저장소 초기화 완료');
  } catch (e) {
    logger.error('저장소 파일 바인딩 실패', e.message);
  }
}

async function persistMembers() {
  try {
    const tmp = path.join(DATA_DIR, 'members.tmp');
    const final = path.join(DATA_DIR, 'members.json');
    const data = {
      counter: VERIFY_COUNTER,
      members: Object.fromEntries(MEMBERS),
      spamStreaks: Object.fromEntries(SPAM_STREAKS),
    };
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, final);
  } catch (e) {
    new Logger('PERSIST').warn('데이터 기록 대기 실패', e.message);
  }
}

async function persistSent(src) {
  try {
    const tmp = path.join(DATA_DIR, `${src}.tmp`);
    const final = path.join(DATA_DIR, `${src}.json`);
    await fs.writeFile(tmp, JSON.stringify([...SENT[src].entries()]));
    await fs.rename(tmp, final);
  } catch (e) {
    new Logger('PERSIST').warn(`동기화 전송 기록 보존 누락 (${src})`);
  }
}

async function persistConfig() {
  try {
    const tmp = path.join(DATA_DIR, 'config.tmp');
    const final = path.join(DATA_DIR, 'config.json');
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(GUILD_CFG)));
    await fs.rename(tmp, final);
  } catch {}
}

async function sendLog(guildId, embed) {
  try {
    const logChannelId = getLogChannel(guildId);
    if (!logChannelId) return;
    const ch = await discord.channels.fetch(logChannelId);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch {}
}

function getAlertChannels() {
  const ids = new Set(ENV.CHANNEL_IDS);
  for (const cfg of GUILD_CFG.values()) {
    if (cfg.alertChannel) ids.add(cfg.alertChannel);
  }
  return [...ids];
}

function getLogChannel(guildId) {
  return GUILD_CFG.get(guildId)?.logChannel || null;
}

const httpAgent = new http.Agent({ 
  keepAlive: true, 
  maxSockets: 40, 
  maxFreeSockets: 20, 
  freeSocketTimeout: 60000 
});
const httpsAgent = new https.Agent({ 
  keepAlive: true, 
  maxSockets: 40, 
  maxFreeSockets: 20, 
  freeSocketTimeout: 60000, 
  rejectUnauthorized: false 
});

const HTTP = axios.create({
  timeout: CFG.API_TIMEOUT,
  headers: { 'User-Agent': 'DisasterBot/12.1.0' },
  httpAgent,
  httpsAgent,
});

const jitter = ms => Math.floor(ms * (1 + (Math.random() * 2 - 1) * CFG.RETRY.JITTER));

const gmap = (lat, lon) => lat && lon 
  ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
  : 'https://www.google.com/maps';

const magStyle = m => {
  if (m >= 7) return { color: 0x660000, em: '🆘', label: 'M7+ 매우강함' };
  if (m >= 6) return { color: 0xCC0000, em: '🔴', label: 'M6+ 강함' };
  if (m >= 5) return { color: 0xFF6600, em: '🟠', label: 'M5+ 중간' };
  if (m >= 4) return { color: 0xFFAA00, em: '🟡', label: 'M4+ 약함' };
  if (m >= 3) return { color: 0x00AAFF, em: '🔵', label: 'M3+ 약함' };
  return { color: 0x999999, em: '⚪', label: 'M<3 미세' };
};

async function withRetry(fn, src) {
  let last;
  for (let i = 0; i <= CFG.RETRY.BASE.length; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < CFG.RETRY.BASE.length) {
        await new Promise(r => setTimeout(r, jitter(CFG.RETRY.BASE[i])));
      }
    }
  }
  throw last;
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  makeCache: Options.cacheWithLimits({
    ApplicationCommandManager: 0,
    BaseGuildEmojiManager: 0,
    GuildEmojiManager: 0,
    GuildIdenpotencyManager: 0,
    GuildMemberManager: 50,
    GuildMessageManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0,
    GuildScheduledEventManager: 0,
    GuildStickerManager: 0,
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    StageInstanceManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    UserManager: 0,
    VoiceStateManager: 0
  }),
});

const Q = [];
let broadcasting = false;

const broadcast = payload => new Promise((res, rej) => {
  Q.push({ payload, res, rej });
  processQueue();
});

async function processQueue() {
  if (broadcasting || Q.length === 0) return;
  broadcasting = true;

  while (Q.length > 0) {
    const { payload, res, rej } = Q.shift();
    try {
      const channels = getAlertChannels();
      
      const promises = [];
      for (let i = 0; i < channels.length; i += CFG.MAX_CONCURRENT) {
        const chunk = channels.slice(i, i + CFG.MAX_CONCURRENT);
        promises.push(
          Promise.allSettled(
            chunk.map(async id => {
              try {
                const ch = await discord.channels.fetch(id, { allowUnknownGuild: true });
                if (ch?.isTextBased()) await ch.send(payload);
              } catch {}
            })
          )
        );
      }

      await Promise.all(promises);
      res();
    } catch (e) {
      rej(e);
    }
  }

  broadcasting = false;
}

function buildEqEmbed(eq) {
  const { color, em, label } = magStyle(eq.mag ?? 0);
  const mapLink = eq.lat && eq.lon
    ? `[${eq.lat.toFixed(2)}°, ${eq.lon.toFixed(2)}°](${gmap(eq.lat, eq.lon)})`
    : '좌표 없음';

  const fields = [
    { name: `${em} 진원지`, value: `\`\`\`${sane(eq.location, 150)}\`\`\``, inline: false }
  ];
  
  if (eq.mag != null) fields.push({ name: '📏 규모', value: `**M ${eq.mag.toFixed(1)}**\n${label}`, inline: true });
  if (eq.depth != null) fields.push({ name: '🔽 깊이', value: `**${eq.depth.toFixed(0)}** km`, inline: true });
  if (eq.intensity) fields.push({ name: '📊 진도', value: `**${sane(eq.intensity, 15)}**`, inline: true });
  
  fields.push({ name: '🕐 발생시간', value: `<t:${Math.floor(eq.time / 1000)}:F>`, inline: false });
  
  if (eq.aftershockProb) fields.push({ name: '⚡ 여진 확률', value: eq.aftershockProb, inline: true });
  if (eq.mmi) fields.push({ name: '📈 진동 등급', value: eq.mmi, inline: true });
  
  fields.push({ name: '🗺️ 좌표', value: mapLink, inline: false });

  return new EmbedBuilder()
    .setTitle(`${em} ${eq.source} 지진 감지`)
    .setColor(color)
    .addFields(fields)
    .setFooter({ text: `${eq.source} | ID: ${eq.id.slice(0, 20)}` })
    .setThumbnail('https://cdn-icons-png.flaticon.com/512/2909/2909985.png')
    .setTimestamp(eq.time);
}

function buildDisasterEmbed({ title, desc, loc, time }) {
  return new EmbedBuilder()
    .setTitle(`🚨 재난 알림`)
    .setColor(0xFF4500)
    .addFields(
      { name: '📢 유형', value: `\`\`\`${sane(title, 100)}\`\`\``, inline: false },
      { name: '📍 지역', value: `\`\`\`${sane(loc, 150)}\`\`\``, inline: false },
      { name: '📝 상세', value: sane(desc, 1024), inline: false },
      { name: '🕐 발령시간', value: `<t:${Math.floor(time / 1000)}:F>`, inline: true }
    )
    .setFooter({ text: '행정안전부 안전누리' })
    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1995/1995467.png')
    .setTimestamp(time);
}

const ERR_COOLDOWN = { kma: { msg: '', at: 0 }, jma: { msg: '', at: 0 }, ndms: { msg: '', at: 0 } };

async function notifyErr(src, err) {
  if (err?.cbOpen) return;
  const msg = err?.message || 'Unknown';
  const now = Date.now(), c = ERR_COOLDOWN[src];
  if (c.msg === msg && now - c.at < CFG.CB.ERR_CD_MS) return;
  c.msg = msg;
  c.at = now;
  metrics.recordErr(src);

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ [${src}] 오류`)
    .setColor(0xFF0000)
    .setDescription(sane(msg, 512))
    .setTimestamp();
  
  broadcast({ embeds: [embed] }).catch(() => {});
}

async function fetchNDMS() {
  if (!ENV.SAFETY_KEY) return;

  try {
    const start = Date.now();
    const items = await CB.ndms.exec(() =>
      withRetry(async () => {
        const { data } = await HTTP.get(
          `https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=${encodeURIComponent(ENV.SAFETY_KEY)}&returnType=json&numOfRows=10&pageNo=1`
        );
        const body = data?.body || data?.Body || data?.response?.body || data;
        if (!body) return [];
        if (body.data) return Array.isArray(body.data) ? body.data : [body.data];
        if (body.items) return Array.isArray(body.items) ? body.items : [body.items];
        return Array.isArray(body) ? body : [];
      }, 'NDMS')
    );

    metrics.recordApiCall('NDMS', Date.now() - start);
    let dirty = false;

    for (const e of items || []) {
      const id = sane(e.MD101_SN || e.msgId || '', 100);
      if (!id || SENT.ndms.has(id)) continue;

      SENT.ndms.set(id, Date.now());
      if (SENT.ndms.size > CFG.CACHE.SENT_MAX) {
        SENT.ndms.delete(SENT.ndms.keys().next().value);
      }
      dirty = true;
      metrics.addEq();

      const embed = buildDisasterEmbed({
        title: `재난 — ${sane(e.DSSTR_SE_NM || '재난', 50)}`,
        desc: e.MSG_CN || '',
        loc: sane(e.RCV_AREA_NM || '전국', 200),
        time: e.CRT_DT ? new Date(e.CRT_DT.replace(/\//g, '-')).getTime() : Date.now(),
      });

      broadcast({ embeds: [embed] });
    }

    if (dirty) persistSent('ndms');
    TRK.ndms.streak = 0;
    TRK.ndms.lastOk = new Date();
  } catch (err) {
    if (!err?.cbOpen) TRK.ndms.streak++;
    notifyErr('ndms', err);
  }
}

async function fetchKMA() {
  if (!ENV.KMA_KEY) return;

  try {
    const start = Date.now();
    const rows = await CB.kma.exec(() =>
      withRetry(async () => {
        const now = new Date(Date.now() + 9 * 3_600_000);
        const to = now.toISOString().slice(0, 10).replace(/-/g, '');
        const from = new Date(+now - 2 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');

        const { data } = await HTTP.get(
          `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${encodeURIComponent(ENV.KMA_KEY)}&numOfRows=10&pageNo=1&dataType=JSON&fromTmFc=${from}&toTmFc=${to}`
        );

        const code = String(data?.response?.header?.resultCode || '');
        if (code && !['00', '03'].includes(code)) throw new Error(`Code: ${code}`);

        const raw = data?.response?.body?.items?.item;
        return Array.isArray(raw) ? raw : raw ? [raw] : [];
      }, 'KMA')
    );

    metrics.recordApiCall('KMA', Date.now() - start);
    let dirty = false;

    for (const e of rows) {
      const id = `${e.tmEqk}_${sane(e.loc, 100)}`;
      if (!e.tmEqk || SENT.kma.has(id)) continue;

      const mag = e.mt != null ? +e.mt : null;
      const lat = e.tmLa != null ? +e.tmLa : null;
      const lon = e.tmLo != null ? +e.tmLo : null;

      if (!getRegion(lat, lon)) continue;
      
      if (isDuplicate({ src: 'KMA', lat, lon, mag, time: Date.now() })) {
        SENT.kma.set(id, Date.now());
        dirty = true;
        continue;
      }

      SENT.kma.set(id, Date.now());
      if (SENT.kma.size > CFG.CACHE.SENT_MAX) {
        SENT.kma.delete(SENT.kma.keys().next().value);
      }
      dirty = true;
      metrics.addEq();

      const eq = new Earthquake({
        id,
        source: 'KMA',
        location: e.loc,
        latitude: lat,
        longitude: lon,
        magnitude: mag,
        depth: e.dep != null ? +e.dep : null,
        intensity: e.mtSt,
        timestamp: new Date(String(e.tmEqk)).getTime(),
      });

      broadcast({ embeds: [buildEqEmbed(eq)] });
    }

    if (dirty) persistSent('kma');
    TRK.kma.streak = 0;
    TRK.kma.lastOk = new Date();
  } catch (err) {
    if (!err?.cbOpen) TRK.kma.streak++;
    notifyErr('kma', err);
  }
}

async function fetchJMA() {
  try {
    const start = Date.now();
    const data = await CB.jma.exec(() =>
      withRetry(async () => {
        const { data: raw } = await HTTP.get('https://www.jma.go.jp/bosai/quake/data/latest_quakes.json');
        return raw;
      }, 'JMA')
    );

    metrics.recordApiCall('JMA', Date.now() - start);
    let dirty = false;

    if (data?.result?.data && Array.isArray(data.result.data)) {
      for (const e of data.result.data.slice(0, 10)) {
        const id = sane(e.id || '', 300);
        if (!id || SENT.jma.has(id)) continue;

        const lat = e.lat || null;
        const lon = e.lon || null;

        if (!getRegion(lat, lon)) continue;
        
        if (isDuplicate({ src: 'JMA', lat, lon, mag: e.mag, time: e.originTime })) {
          SENT.jma.set(id, Date.now());
          dirty = true;
          continue;
        }

        SENT.jma.set(id, Date.now());
        if (SENT.jma.size > CFG.CACHE.SENT_MAX) {
          SENT.jma.delete(SENT.jma.keys().next().value);
        }
        dirty = true;
        metrics.addEq();

        const eq = new Earthquake({
          id,
          source: 'JMA',
          location: e.locations?.[0]?.name || '(정보 없음)',
          latitude: lat,
          longitude: lon,
          magnitude: e.mag,
          depth: e.depth,
          intensity: e.intensity,
          timestamp: e.originTime,
        });

        broadcast({ embeds: [buildEqEmbed(eq)] });
      }
    }

    if (dirty) persistSent('jma');
    TRK.jma.streak = 0;
    TRK.jma.lastOk = new Date();
  } catch (err) {
    if (!err?.cbOpen) TRK.jma.streak++;
    notifyErr('jma', err);
  }
}

const msgTimestamps = new Map();

async function handleSpamFilter(message) {
  if (message.author.bot || !message.guild) return;
  const { author, member, guild } = message;
  
  if (ENV.OWNER_ID && author.id === ENV.OWNER_ID) return;

  const now = Date.now();
  let times = msgTimestamps.get(author.id);
  if (!times) {
    times = [];
    msgTimestamps.set(author.id, times);
  }
  times.push(now);

  const cutoff = now - CFG.ANTISPAM.WINDOW_MS;
  let validCount = 0;
  for (let i = times.length - 1; i >= 0; i--) {
    if (times[i] >= cutoff) validCount++;
    else break;
  }

  if (times.length > 30) {
    msgTimestamps.set(author.id, times.slice(-20));
  }

  if (validCount >= CFG.ANTISPAM.MAX_MSG) {
    msgTimestamps.set(author.id, []);

    const currentWarnings = (SPAM_STREAKS.get(author.id) || 0) + 1;
    SPAM_STREAKS.set(author.id, currentWarnings);
    persistMembers();

    const isBanTrigger = currentWarnings >= CFG.ANTISPAM.BAN_THRESHOLD;
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${author.tag} (${author.id})`, iconURL: author.displayAvatarURL() })
      .setTimestamp();

    if (isBanTrigger) {
      embed.setTitle('🚫 [영구 차단] 도배 누적 한계 도달')
        .setColor(0xFF0000)
        .setDescription(`도배로 인한 경고가 **${currentWarnings}회** 누적되어 영구 차단되었습니다.`)
        .addFields(
          { name: '사유', value: `3초 내 ${validCount}회 도배 감지` }
        );

      try {
        await guild.members.ban(author.id, { reason: '도배 누적 한계 초과로 인한 자동 차단' });
        await message.channel.send({ content: `🚨 **${author.username}**님이 도배 한계 누적으로 영구 차단되었습니다.` });
      } catch (err) {
        securityLogger.error('스패머 차단 권한 부적격', err.message);
      }
    } else {
      embed.setTitle('⏳ [타임아웃] 고속 도배 감지')
        .setColor(0xFFAA00)
        .setDescription(`과도하게 빠른 메시지 전송으로 1시간 동안 타임아웃 되었습니다.`)
        .addFields(
          { name: '경고 횟수', value: `**${currentWarnings}** / ${CFG.ANTISPAM.BAN_THRESHOLD}회` }
        );

      try {
        await member.timeout(CFG.ANTISPAM.TIMEOUT_MS, '고속 도배 감지 (3초 내 15회)');
        await message.channel.send({ content: `⚠️ **${author.username}**님이 도배로 인해 1시간 대화 금지 처리되었습니다. (누적: ${currentWarnings}회)` });
      } catch (err) {
        securityLogger.error('스패머 타임아웃 제어 오류', err.message);
      }
    }

    await sendLog(guild.id, embed);
  }
}

async function punishRaidUser(guild, actionType, targetName) {
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const fetchedLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: actionType,
    });
    
    const firstEntry = fetchedLogs.entries.first();
    if (!firstEntry) return null;

    const { executor } = firstEntry;
    if (executor.id === discord.user.id || executor.id === ENV.OWNER_ID) {
      return null;
    }

    await guild.members.ban(executor.id, { reason: `[안티 레이드] 승인되지 않은 구조 변조 시도 (${targetName})` });
    securityLogger.critical(`안티 레이드 경보 - 폭파범 즉각 차단 성공: ${executor.tag}`);

    const embed = new EmbedBuilder()
      .setTitle('🚨 안티 레이드 차단 및 복구 가동')
      .setColor(0xFF0000)
      .setDescription(`승인되지 않은 무단 폭파(레이드) 행위자가 적발되어 즉시 영구 밴 되었으며 원상복구를 시도합니다.`)
      .addFields(
        { name: '행위 유저', value: `**${executor.tag}** (\`${executor.id}\`)` },
        { name: '감지 변조 사양', value: `${targetName}` }
      )
      .setTimestamp();
    
    await sendLog(guild.id, embed);
    return executor;
  } catch (err) {
    securityLogger.error('보안 엔진 무력화 실패', err.message);
    return null;
  }
}

discord.on(Events.ChannelDelete, async channel => {
  if (!channel.guild) return;
  const executor = await punishRaidUser(channel.guild, AuditLogEvent.ChannelDelete, `채널 삭제: #${channel.name}`);
  if (!executor) return;

  try {
    const parentId = channel.parentId;
    const type = channel.type;
    const permissionOverwrites = channel.permissionOverwrites.cache.map(o => ({
      id: o.id,
      type: o.type,
      allow: o.allow.toArray(),
      deny: o.deny.toArray()
    }));

    const restoredChannel = await channel.guild.channels.create({
      name: channel.name,
      type: type,
      parent: parentId,
      permissionOverwrites: permissionOverwrites,
      topic: channel.topic || undefined,
      nsfw: channel.nsfw || undefined,
      rateLimitPerUser: channel.rateLimitPerUser || undefined,
    });

    const gid = channel.guild.id;
    if (GUILD_CFG.has(gid)) {
      const cfg = GUILD_CFG.get(gid);
      if (cfg.alertChannel === channel.id) {
        cfg.alertChannel = restoredChannel.id;
        persistConfig();
      }
      if (cfg.logChannel === channel.id) {
        cfg.logChannel = restoredChannel.id;
        persistConfig();
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🔧 원상복구 완료 (채널)')
      .setColor(0x00FF99)
      .setDescription(`무단 삭제된 채널 **#${channel.name}**을 완벽하게 재구성하여 정렬 완료했습니다.`)
      .addFields({ name: '복구 완료된 타겟', value: `<#${restoredChannel.id}>` })
      .setTimestamp();
    
    await sendLog(channel.guild.id, embed);
  } catch (err) {
    securityLogger.error('채널 원격 복구 파이프 오류', err.message);
  }
});

discord.on(Events.GuildRoleDelete, async role => {
  const executor = await punishRaidUser(role.guild, AuditLogEvent.RoleDelete, `역할 삭제: @${role.name}`);
  if (!executor) return;

  try {
    const restoredRole = await role.guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions.toArray(),
      mentionable: role.mentionable,
      position: role.position,
      reason: '[안티 레이드] 폭파된 보안 역할 즉각 복구 지시'
    });

    const embed = new EmbedBuilder()
      .setTitle('🔧 원상복구 완료 (역할)')
      .setColor(0x00FF99)
      .setDescription(`임의 분실 처리되었던 보안 등급 역할 **@${role.name}**을(를) 즉각 복구했습니다.`)
      .addFields({ name: '재지급 타겟 역할', value: `<@&${restoredRole.id}>` })
      .setTimestamp();
    
    await sendLog(role.guild.id, embed);
  } catch (err) {
    securityLogger.error('역할 복원 파이프라인 정지', err.message);
  }
});

discord.on(Events.GuildMemberRemove, async member => {
  await punishRaidUser(member.guild, AuditLogEvent.MemberKick, `멤버 강제 퇴장: ${member.user.tag}`);
});

discord.on(Events.GuildBanAdd, async ban => {
  await punishRaidUser(ban.guild, AuditLogEvent.MemberBanAdd, `멤버 무단 밴: ${ban.user.tag}`);
});

const CMDS = [
  { name: '상태', description: '실시간 게이트웨이 레이턴시 및 봇 가동 상태 확인' },
  { name: '통계', description: '처리 통계' },
  { name: '도움말', description: '안내' },
  { name: '청소', description: '캐시 초기화 (OWNER)' },
  { name: '알림', description: '알림 채널 설정 (OWNER)', options: [{ name: 'ch', type: ApplicationCommandOptionType.Channel, required: true }] },
  { name: '로그', description: '로그 채널 설정 (OWNER)', options: [{ name: 'ch', type: ApplicationCommandOptionType.Channel, required: true }] },
  { name: '인증', description: '멤버 인증' },
];

discord.on(Events.InteractionCreate, async ix => {
  if (!ix.isChatInputCommand()) return;
  const { commandName: cmd, user, guild } = ix;
  const isOwner = !ENV.OWNER_ID || user.id === ENV.OWNER_ID;

  if (['청소', '알림', '로그'].includes(cmd) && !isOwner) {
    return ix.reply({ content: '❌ OWNER 전용 제어기입니다.', ephemeral: true }).catch(() => {});
  }

  try {
    if (cmd === '상태') {
      const up = process.uptime();
      const wsPing = discord.ws.ping;
      const pingStatus = wsPing < 20 ? `🟢 ${wsPing}ms (초고속 성능 유지)` : `🟡 ${wsPing}ms`;

      return ix.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📊 초고속 봇 상태 분석')
          .setColor(0x00FF99)
          .addFields(
            { name: '⚡ 게이트웨이 핑 (레이턴시)', value: `**${pingStatus}**`, inline: false },
            { name: '⏱️ 무 중단 가동시간', value: `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m`, inline: true },
            { name: '💾 메모리 점유', value: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`, inline: true },
            { name: '🛡️ 보안 방벽', value: '🟢 완벽 가동 중 (Zero-Cache 최적화)', inline: false },
          )
          .setTimestamp()],
      });
    }

    if (cmd === '통계') {
      const stats = metrics.getStats();
      return ix.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📈 감사 및 누적 성능 통계')
          .setColor(0x5865F2)
          .addFields(
            { name: '🌍 누적 지진 감지수', value: String(stats.earthquakes), inline: true },
            { name: '⚡ API 평균 응답', value: `KMA: ${stats.avgResponseTime.KMA || 0}ms | JMA: ${stats.avgResponseTime.JMA || 0}ms`, inline: false },
            { name: '👥 인증 통과자', value: `${MEMBERS.size}명`, inline: true },
          )
          .setTimestamp()],
      });
    }

    if (cmd === '도움말') {
      return ix.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📖 지진 재난 및 안티 레이드 엔진 v12.1.0')
          .setColor(0x5865F2)
          .setDescription('레이턴시 < 20ms를 보장하기 위해 전력 튜닝된 엔터프라이즈 사양')
          .addFields(
            { name: '⚡ 실시간 핑 제어', value: 'Discord Gateway와 긴밀하게 연동된 Zero-Cache 전술로 초고속 이벤트 파싱 지원.' },
            { name: '🛡️ 무단 파괴 억제', value: '승인되지 않은 관리자의 채널 폭파, 임의 퇴장 시도를 무력화하고 자동 백업 복구 수행.' }
          )
          .setTimestamp()],
      });
    }

    if (cmd === '청소') {
      for (const m of Object.values(SENT)) m.clear();
      const embed = new EmbedBuilder()
        .setTitle('🧹 전송 대기열 수집 캐시 청소')
        .setColor(0xFFDD00)
        .setDescription('중복 발송 검증 맵이 무력화 및 강제 청소 완료되었습니다.')
        .setTimestamp();
      await ix.reply({ content: '✅ 중복 전송 방지용 수집 기록을 비웠습니다.', ephemeral: true });
      await sendLog(guild?.id, embed);
      return;
    }

    if (cmd === '알림') {
      const ch = ix.options.getChannel('ch');
      const gid = guild?.id || 'global';
      if (!GUILD_CFG.has(gid)) GUILD_CFG.set(gid, {});
      GUILD_CFG.get(gid).alertChannel = ch.id;
      persistConfig();
      
      const embed = new EmbedBuilder()
        .setTitle('📢 알림 수신 대상 고정')
        .setColor(0x0099FF)
        .addFields(
          { name: '지정 채널', value: `<#${ch.id}>`, inline: true }
        )
        .setTimestamp();
      
      await ix.reply({ content: `✅ <#${ch.id}>로 수집 경보 채널을 갱신했습니다.`, ephemeral: true });
      await sendLog(guild?.id, embed);
      return;
    }

    if (cmd === '로그') {
      const ch = ix.options.getChannel('ch');
      const gid = guild?.id || 'global';
      if (!GUILD_CFG.has(gid)) GUILD_CFG.set(gid, {});
      GUILD_CFG.get(gid).logChannel = ch.id;
      persistConfig();
      
      const embed = new EmbedBuilder()
        .setTitle('📝 보안 분석 감사 채널 갱신')
        .setColor(0x9966FF)
        .addFields(
          { name: '지정 채널', value: `<#${ch.id}>`, inline: true }
        )
        .setTimestamp();
      
      await ix.reply({ content: `✅ <#${ch.id}>로 보안 로그 수집 장소를 설정 완료했습니다.`, ephemeral: true });
      await sendLog(guild?.id, embed);
      return;
    }

    if (cmd === '인증') {
      if (!guild) return ix.reply({ content: '❌ 서버 내 일반 채널에서만 구동됩니다.', ephemeral: true });
      
      const member = guild.members.cache.get(user.id) || await guild.members.fetch(user.id);
      const createdAt = user.createdAt;
      const daysOld = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));

      if (MEMBERS.has(user.id)) {
        const memberData = MEMBERS.get(user.id);
        return ix.reply({
          embeds: [new EmbedBuilder()
            .setTitle('✅ 이미 확보된 영구 인증')
            .setColor(0x00AA00)
            .addFields(
              { name: '고유 식별번호', value: `\`\`\`${memberData.number}\`\`\``, inline: true }
            )
            .setTimestamp()],
          ephemeral: true,
        });
      }

      if (daysOld < CFG.VERIFY.DAYS) {
        const embed = new EmbedBuilder()
          .setTitle('❌ 연령 한계 미달 즉각 추방')
          .setColor(0xFF0000)
          .addFields(
            { name: '대상자', value: `${user.tag}` },
            { name: '경과일수', value: `${daysOld}일 (정상 자격: 50일 이상)` }
          )
          .setTimestamp();
        
        try {
          await member.kick(`[보안 엔진] 계정 연령 미달 추방 (${daysOld}일 경과)`);
          await ix.reply({ content: '❌ 가입 조건 일수 부족 사유로 추방되었습니다.', ephemeral: true });
        } catch {
          await ix.reply({ content: '❌ 승인 조건 불충족으로 즉각 가입 철회되었습니다.', ephemeral: true });
        }
        
        await sendLog(guild.id, embed);
        return;
      }

      try {
        VERIFY_COUNTER++;
        const verifyNumber = VERIFY_COUNTER;
        const memberData = {
          number: verifyNumber,
          userId: user.id,
          username: user.username,
          verifiedAt: Date.now(),
          createdAt: createdAt.getTime(),
        };
        MEMBERS.set(user.id, memberData);
        persistMembers();

        if (ENV.ROLE) {
          try {
            await member.roles.add(ENV.ROLE);
          } catch (e) {
            new Logger('VERIFY').warn('역할 등급 조정 불가 (봇의 가중치 등급 확인 요망)');
          }
        }

        const newNick = `${verifyNumber} | ${user.username}`.slice(0, 32);
        try {
          await member.setNickname(newNick);
        } catch (e) {
          new Logger('VERIFY').warn('닉네임 명명권 소실');
        }

        const embed = new EmbedBuilder()
          .setTitle('✅ 가입 승인 및 식별번호 교부 완료')
          .setColor(0x00AA00)
          .addFields(
            { name: '승인 멤버', value: `${user.tag}` },
            { name: '교부 식별번호', value: `\`\`\`${verifyNumber}\`\`\`` }
          )
          .setTimestamp();

        await ix.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎉 인증 절차 완료')
            .setColor(0x00AA00)
            .addFields(
              { name: '부여된 코드', value: `\`\`\`${verifyNumber}\`\`\`` }
            )
            .setTimestamp()],
          ephemeral: true,
        });

        await sendLog(guild.id, embed);
      } catch (e) {
        new Logger('VERIFY').error('인증 라이브러리 가동 지연');
        await ix.reply({ content: '❌ 비정상 시스템 에러로 중단되었습니다.', ephemeral: true });
      }
      return;
    }
  } catch (e) {
    new Logger('CMD').error('요청 분산 파싱 오류');
    await ix.reply({ content: '❌ 내부 성능 튜닝 모듈 에러입니다.', ephemeral: true }).catch(() => {});
  }
});

discord.on(Events.MessageCreate, async message => {
  await handleSpamFilter(message);
});

const app = express();
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60_000, max: 100 }));
app.use(express.json({ limit: '5kb' }));

app.get('/health', (_, res) => {
  const healthy = !Object.values(CB).some(c => c.state === 'OPEN');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.get('/metrics', (_, res) => res.json(metrics.getStats()));
app.use((_, res) => res.status(404).json({ error: 'Not Found' }));

const server = app.listen(ENV.PORT, () => mainLogger.info(`포트 ${ENV.PORT} 개방 완료`));

discord.once(Events.ClientReady, async () => {
  mainLogger.info(`로그인 처리 완료: ${discord.user.tag}`);
  await initStorage();

  setInterval(() => persistMembers(), CFG.VERIFY.COUNTER_SAVE_MS).unref();

  const loops = [
    { fn: fetchNDMS, ms: CFG.MS.NDMS, id: 'ndms' },
    { fn: fetchKMA, ms: CFG.MS.KMA, id: 'kma' },
    { fn: fetchJMA, ms: CFG.MS.JMA, id: 'jma' },
  ];

  loops.forEach(({ fn, ms, id }) => {
    const tick = async () => {
      try {
        await fn();
      } catch {}
      const nextMs = TRK[id].streak > 0 || CB[id].state !== 'CLOSED' ? CFG.MS.ERR : ms;
      setTimeout(tick, nextMs).unref();
    };
    setTimeout(tick, Math.random() * 5000).unref();
  });

  if (ENV.APPLICATION_ID) {
    const rest = new REST({ version: '10' }).setToken(ENV.DISCORD_TOKEN);
    rest.put(Routes.applicationCommands(ENV.APPLICATION_ID), { body: CMDS }).catch(() => {});
  }
});

async function shutdown() {
  mainLogger.critical('종료 신호 감지, 메모리 전송기 종료');
  const timeout = setTimeout(() => mainLogger.fatal('자원 반환 지연으로 강제 프로세스 종료'), CFG.SHUTDOWN_MS);
  timeout.unref();

  try {
    await new Promise(r => server.close(r));
    await discord.destroy();
    await Promise.all([
      persistSent('kma'),
      persistSent('jma'),
      persistSent('ndms'),
      persistConfig(),
      persistMembers(),
    ]);
  } catch (e) {
    mainLogger.error('종료 디스크 플러시 무력화', e.message);
  } finally {
    clearTimeout(timeout);
    mainLogger.destroy();
    process.exit(0);
  }
}

process.on('uncaughtException', e => mainLogger.fatal('예외 상황 발생', e.stack || e.message));
process.on('unhandledRejection', e => mainLogger.fatal('핸들링 지연 Rejection', String(e)));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

discord.login(ENV.DISCORD_TOKEN).catch(e => mainLogger.fatal('Discord 인증 토큰 거부', e.message));