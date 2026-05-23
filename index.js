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
  ApplicationCommandOptionType
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
  PORT: Number(process.env.PORT) || 3000,
  CHANNEL_IDS: (process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
});

const CFG = Object.freeze({
  MS: { SAFE: 2 * 60_000, KMA: 5 * 60_000, JMA: 30_000, ERR: 20 * 60_000 },
  RETRY: { BASE: [800, 2_000], JITTER: 0.1 },
  CB: { THRESH: 3, HALF_MS: 5 * 60_000, ERR_CD_MS: 10 * 60_000 },
  CACHE: { TTL: 24 * 3_600_000, SENT_MAX: 1_500, MSG_BUFFER: 0 },
  DEDUP: { DIST_KM: 80, MAG_D: 0.5, TIME_MS: 5 * 60_000, MAX: 200 },
  REGIONS: {
    KR: { name: '한국', lat: [33.0, 38.9], lon: [124.5, 132.0] },
    CN: { name: '중국', lat: [18.0, 53.0], lon: [73.0, 135.0] },
    JP: { name: '일본', lat: [30.0, 45.0], lon: [130.0, 145.0] },
  },
  BROADCAST_GAP: 50,
  SHUTDOWN_MS: 8_000,
  API_TIMEOUT: 4_000,
  MAX_CONCURRENT: 25,
  EMERGENCY: {
    SAFE: { color: 0xFFDD00, mention: false, repeats: 1 },
    URGENT: { color: 0xFF8800, mention: true, repeats: 1 },
    CRITICAL: { color: 0xFF0000, mention: true, repeats: 5 },
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
    console.log(this.buffer.join('\n'));
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
      messages: this.eq,
      memory: mem,
      avgResponseTime: avgTime,
      errors: Object.fromEntries(this.errors),
    };
  }
}

const metrics = new Metrics();

const DANGER_RE = /[<>"'`\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const sane = (v, max = 1024) => 
  v == null ? '' : String(v).replace(DANGER_RE, '').slice(0, max) || '';

class Earthquake {
  constructor(data) {
    this.id = String(data.id || '').slice(0, 100);
    this.source = data.source;
    this.location = String(data.location || '미상').slice(0, 200);
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

const CB = { kma: new CircuitBreaker('KMA'), jma: new CircuitBreaker('JMA'), safe: new CircuitBreaker('SAFE') };
const TRK = { kma: { streak: 0, lastOk: null }, jma: { streak: 0, lastOk: null }, safe: { streak: 0, lastOk: null } };

const SENT = { kma: new Map(), jma: new Map(), safe: new Map() };
const GUILD_CFG = new Map();
const TEMP_MESSAGES = new Map();
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
      })()
    ];

    await Promise.all(loadTasks);
    logger.info('저장소 준비 완료');
  } catch (e) {
    logger.error('저장소 초기화 실패');
  }
}

async function persistSent(src) {
  try {
    const tmp = path.join(DATA_DIR, `${src}.tmp`);
    const final = path.join(DATA_DIR, `${src}.json`);
    await fs.writeFile(tmp, JSON.stringify([...SENT[src].entries()]));
    await fs.rename(tmp, final);
  } catch {}
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

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, freeSocketTimeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, freeSocketTimeout: 60000, rejectUnauthorized: false });

const HTTP = axios.create({
  timeout: CFG.API_TIMEOUT,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  httpAgent,
  httpsAgent,
});

const jitter = ms => Math.floor(ms * (1 + (Math.random() * 2 - 1) * CFG.RETRY.JITTER));

const gmap = (lat, lon) => lat && lon 
  ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
  : 'https://www.google.com/maps';

const magStyle = m => {
  if (m >= 7) return { color: 0x660000, em: '🆘' };
  if (m >= 6) return { color: 0xCC0000, em: '🔴' };
  if (m >= 5) return { color: 0xFF6600, em: '🟠' };
  if (m >= 4) return { color: 0xFFAA00, em: '🟡' };
  return { color: 0x00AAFF, em: '🔵' };
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
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  makeCache: Options.cacheWithLimits({
    ApplicationCommandManager: 0,
    BaseGuildEmojiManager: 0,
    GuildEmojiManager: 0,
    GuildMemberManager: 50,
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
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
                if (ch?.isTextBased()) {
                  const sent = await ch.send(payload);
                  return sent;
                }
              } catch {}
            })
          )
        );
      }

      const results = await Promise.all(promises);
      
      if (payload.tempDelete) {
        const msgIds = [];
        for (const result of results) {
          for (const r of result) {
            if (r.status === 'fulfilled' && r.value?.id) {
              msgIds.push(r.value.id);
            }
          }
        }
        if (msgIds.length > 0) {
          TEMP_MESSAGES.set(Math.random(), { ids: msgIds, channels: getAlertChannels(), at: Date.now() });
        }
      }

      res();
    } catch (e) {
      rej(e);
    }
  }

  broadcasting = false;
}

function buildEqEmbed(eq) {
  const { color, em } = magStyle(eq.mag ?? 0);
  const mapLink = eq.lat && eq.lon
    ? `[${eq.lat.toFixed(2)}°, ${eq.lon.toFixed(2)}°](${gmap(eq.lat, eq.lon)})`
    : '좌표 없음';

  const fields = [
    { name: `${em} 진원지`, value: `**${sane(eq.location, 150)}**`, inline: false }
  ];
  
  if (eq.mag != null) fields.push({ name: '📏 규모', value: `**M ${eq.mag.toFixed(1)}**`, inline: true });
  if (eq.depth != null) fields.push({ name: '🔽 깊이', value: `**${eq.depth.toFixed(0)} km**`, inline: true });
  if (eq.intensity) fields.push({ name: '📊 진도', value: `**${sane(eq.intensity, 15)}**`, inline: true });
  
  fields.push({ name: '🕐 발생시간', value: `<t:${Math.floor(eq.time / 1000)}:F>`, inline: false });
  
  if (eq.aftershockProb) fields.push({ name: '⚡ 여진확률', value: eq.aftershockProb, inline: true });
  
  fields.push({ name: '🗺️ 좌표', value: mapLink, inline: false });

  return new EmbedBuilder()
    .setTitle(`${em} ${eq.source} 지진 감지`)
    .setColor(color)
    .addFields(fields)
    .setFooter({ text: eq.source })
    .setThumbnail('https://cdn-icons-png.flaticon.com/512/2909/2909985.png')
    .setTimestamp(eq.time);
}

function buildSafeEmbed(title, desc, area, level) {
  const config = CFG.EMERGENCY[level];
  const icon = level === 'SAFE' ? '📢' : level === 'URGENT' ? '🚨' : '🆘';
  
  return new EmbedBuilder()
    .setTitle(`${icon} ${sane(title, 150)}`)
    .setColor(config.color)
    .setDescription(sane(desc, 2000))
    .addFields({ name: '📍 지역', value: `**${sane(area, 200)}**`, inline: true })
    .setFooter({ text: `${level === 'SAFE' ? '안전안내' : level === 'URGENT' ? '긴급재난' : '위급재난'} | 행정안전부` })
    .setTimestamp();
}

const ERR_COOLDOWN = { kma: { msg: '', at: 0 }, jma: { msg: '', at: 0 }, safe: { msg: '', at: 0 } };

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

async function fetchSafe() {
  if (!ENV.SAFETY_KEY) return;

  try {
    const start = Date.now();
    const items = await CB.safe.exec(() =>
      withRetry(async () => {
        const { data } = await HTTP.get(
          'https://www.safekorea.go.kr/safekorea-kor/ctim/cmsg/calamitySms.do?menuSn=34&firstYn=Y'
        );
        
        const rows = data.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/g) || [];
        const items = [];
        
        for (const tbody of rows) {
          const trs = tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          
          for (const tr of trs.slice(0, 20)) {
            const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
            
            if (tds.length >= 3) {
              const clean = (str) => {
                return str
                  .replace(/<[^>]*>/g, '')
                  .replace(/&nbsp;/g, ' ')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&amp;/g, '&')
                  .trim();
              };
              
              const title = clean(tds[0]);
              const area = clean(tds[1]);
              const levelText = clean(tds[2]);
              
              let level = 'SAFE';
              if (levelText.includes('위급')) level = 'CRITICAL';
              else if (levelText.includes('긴급')) level = 'URGENT';
              
              if (title && area) {
                items.push({ title, area, level, time: Date.now() });
              }
            }
          }
        }
        
        return items;
      }, 'SAFE')
    );

    metrics.recordApiCall('SAFE', Date.now() - start);

    for (const e of items || []) {
      const id = `${sane(e.title, 100)}_${sane(e.area, 50)}_${e.level}`;
      if (SENT.safe.has(id)) continue;

      SENT.safe.set(id, Date.now());
      if (SENT.safe.size > CFG.CACHE.SENT_MAX) {
        SENT.safe.delete(SENT.safe.keys().next().value);
      }
      metrics.addEq();

      const config = CFG.EMERGENCY[e.level];
      const embed = buildSafeEmbed(e.title, '', e.area, e.level);

      if (config.mention && e.level === 'URGENT') {
        broadcast({ content: '@everyone', embeds: [embed], tempDelete: false });
      } else if (config.mention && e.level === 'CRITICAL') {
        for (let i = 0; i < config.repeats; i++) {
          broadcast({ content: i === 0 ? '@everyone' : '', embeds: [embed], tempDelete: i > 0 }).catch(() => {});
          if (i < config.repeats - 1) await new Promise(r => setTimeout(r, 500));
        }
      } else {
        broadcast({ embeds: [embed] });
      }
    }

    persistSent('safe');
    TRK.safe.streak = 0;
    TRK.safe.lastOk = new Date();
  } catch (err) {
    if (!err?.cbOpen) TRK.safe.streak++;
    notifyErr('safe', err);
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

    for (const e of rows) {
      const id = `${e.tmEqk}_${sane(e.loc, 100)}`;
      if (!e.tmEqk || SENT.kma.has(id)) continue;

      const mag = e.mt != null ? +e.mt : null;
      const lat = e.tmLa != null ? +e.tmLa : null;
      const lon = e.tmLo != null ? +e.tmLo : null;

      if (!getRegion(lat, lon)) continue;
      
      if (isDuplicate({ src: 'KMA', lat, lon, mag, time: Date.now() })) {
        SENT.kma.set(id, Date.now());
        continue;
      }

      SENT.kma.set(id, Date.now());
      if (SENT.kma.size > CFG.CACHE.SENT_MAX) {
        SENT.kma.delete(SENT.kma.keys().next().value);
      }
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

    persistSent('kma');
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

    if (data?.result?.data && Array.isArray(data.result.data)) {
      for (const e of data.result.data.slice(0, 10)) {
        const id = sane(e.id || '', 300);
        if (!id || SENT.jma.has(id)) continue;

        const lat = e.lat || null;
        const lon = e.lon || null;

        if (!getRegion(lat, lon)) continue;
        
        if (isDuplicate({ src: 'JMA', lat, lon, mag: e.mag, time: e.originTime })) {
          SENT.jma.set(id, Date.now());
          continue;
        }

        SENT.jma.set(id, Date.now());
        if (SENT.jma.size > CFG.CACHE.SENT_MAX) {
          SENT.jma.delete(SENT.jma.keys().next().value);
        }
        metrics.addEq();

        const eq = new Earthquake({
          id,
          source: 'JMA',
          location: e.locations?.[0]?.name || '미상',
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

    persistSent('jma');
    TRK.jma.streak = 0;
    TRK.jma.lastOk = new Date();
  } catch (err) {
    if (!err?.cbOpen) TRK.jma.streak++;
    notifyErr('jma', err);
  }
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, data] of TEMP_MESSAGES) {
    if (now - data.at > 10_000) {
      for (const chId of data.channels) {
        try {
          const ch = await discord.channels.fetch(chId);
          if (ch?.isTextBased()) {
            for (const msgId of data.ids) {
              try {
                const msg = await ch.messages.fetch(msgId);
                await msg.delete();
              } catch {}
            }
          }
        } catch {}
      }
      TEMP_MESSAGES.delete(key);
    }
  }
}, 15_000).unref();

const CMDS = [
  { name: '상태', description: '봇 상태' },
  { name: '통계', description: '통계' },
  { name: '알림', description: '알림채널', options: [{ name: 'ch', type: ApplicationCommandOptionType.Channel, required: true }] },
  { name: '로그', description: '로그채널', options: [{ name: 'ch', type: ApplicationCommandOptionType.Channel, required: true }] },
];

discord.on(Events.InteractionCreate, async ix => {
  if (!ix.isChatInputCommand()) return;
  const { commandName: cmd, user, guild } = ix;
  const isOwner = !ENV.OWNER_ID || user.id === ENV.OWNER_ID;

  if (['알림', '로그'].includes(cmd) && !isOwner) {
    return ix.reply({ content: '❌ OWNER전용', ephemeral: true }).catch(() => {});
  }

  try {
    if (cmd === '상태') {
      const up = process.uptime();
      const wsPing = discord.ws.ping;

      return ix.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📊 봇상태')
          .setColor(0x00FF99)
          .addFields(
            { name: '⚡ 핑', value: `${wsPing}ms`, inline: true },
            { name: '⏱️ 가동', value: `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m`, inline: true },
            { name: '🌏 KMA', value: CB.kma.badge(), inline: true },
            { name: '🗾 JMA', value: CB.jma.badge(), inline: true },
            { name: '🛡️ SAFE', value: CB.safe.badge(), inline: true },
          )
          .setTimestamp()],
      });
    }

    if (cmd === '통계') {
      const stats = metrics.getStats();
      return ix.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📈 통계')
          .setColor(0x5865F2)
          .addFields(
            { name: '메시지', value: String(stats.messages), inline: true },
            { name: '메모리', value: `${stats.memory}MB`, inline: true },
            { name: 'KMA', value: `${stats.avgResponseTime.KMA || 0}ms`, inline: true },
            { name: 'JMA', value: `${stats.avgResponseTime.JMA || 0}ms`, inline: true },
          )
          .setTimestamp()],
      });
    }

    if (cmd === '알림') {
      const ch = ix.options.getChannel('ch');
      const gid = guild?.id || 'global';
      if (!GUILD_CFG.has(gid)) GUILD_CFG.set(gid, {});
      GUILD_CFG.get(gid).alertChannel = ch.id;
      persistConfig();
      return ix.reply({ content: `✅ <#${ch.id}>`, ephemeral: true });
    }

    if (cmd === '로그') {
      const ch = ix.options.getChannel('ch');
      const gid = guild?.id || 'global';
      if (!GUILD_CFG.has(gid)) GUILD_CFG.set(gid, {});
      GUILD_CFG.get(gid).logChannel = ch.id;
      persistConfig();
      return ix.reply({ content: `✅ <#${ch.id}>`, ephemeral: true });
    }
  } catch (e) {
    await ix.reply({ content: '❌', ephemeral: true }).catch(() => {});
  }
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
app.use((_, res) => res.status(404).end());

const server = app.listen(ENV.PORT, () => mainLogger.info(`포트 ${ENV.PORT}`));

discord.once(Events.ClientReady, async () => {
  mainLogger.info(`로그인: ${discord.user.tag}`);
  await initStorage();

  const loops = [
    { fn: fetchSafe, ms: CFG.MS.SAFE, id: 'safe' },
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
    setTimeout(tick, Math.random() * 3000).unref();
  });

  if (ENV.APPLICATION_ID) {
    const rest = new REST({ version: '10' }).setToken(ENV.DISCORD_TOKEN);
    rest.put(Routes.applicationCommands(ENV.APPLICATION_ID), { body: CMDS }).catch(() => {});
  }
});

async function shutdown() {
  mainLogger.critical('종료중');
  const timeout = setTimeout(() => mainLogger.fatal('강제종료'), CFG.SHUTDOWN_MS);
  timeout.unref();

  try {
    await new Promise(r => server.close(r));
    await discord.destroy();
    await Promise.all([persistSent('kma'), persistSent('jma'), persistSent('safe'), persistConfig()]);
  } catch (e) {
    mainLogger.error('종료오류');
  } finally {
    clearTimeout(timeout);
    mainLogger.destroy();
    process.exit(0);
  }
}

process.on('uncaughtException', e => mainLogger.fatal('Exception', e.message));
process.on('unhandledRejection', e => mainLogger.fatal('Rejection', String(e)));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

discord.login(ENV.DISCORD_TOKEN).catch(e => mainLogger.fatal('로그인실패', e.message));