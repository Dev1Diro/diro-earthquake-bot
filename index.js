import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import path from 'path';
import dns from 'dns';
import { fileURLToPath } from 'url';
import {
  Client, GatewayIntentBits, Partials, Options,
  EmbedBuilder, REST, Routes, Events, PermissionsBitField,
  ApplicationCommandOptionType
} from 'discord.js';

process.on('warning', (warning) => {
  if (!warning.message.includes('MaxListenersExceeded')) console.warn('WARNING:', warning.message);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dns.setDefaultResultOrder('ipv4first');

const requiredEnv = ['DISCORD_TOKEN', 'KMA_KEY', 'SAFETY_KEY'];
for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`❌ ${env} 필수 환경변수가 누락되었습니다.`);
    process.exit(1);
  }
}

const ENV = Object.freeze({
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  KMA_KEY: process.env.KMA_KEY,
  SAFETY_KEY: process.env.SAFETY_KEY,
  APPLICATION_ID: process.env.APPLICATION_ID || '',
  PORT: Number(process.env.PORT) || 3000,
  CHANNEL_IDS: Object.freeze((process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
});

const CFG = Object.freeze({
  MS: { SAFE: 120_000, KMA: 150_000, JMA: 60_000 },
  RETRY: [200, 400],
  CB_THRESH: 3,
  CACHE_TTL: 86_400_000,
  DEDUP_KM: 80,
  DEDUP_MAG: 0.5,
  DEDUP_MS: 300_000,
  API_TIMEOUT: 2500,
  BROADCAST_CHUNK: 45, 
  BROADCAST_DELAY: 1050,
});

class FastLog {
  constructor(src) {
    this.src = src;
    this.buf = [];
    setInterval(() => this.flush(), 5000);
  }
  log(msg) {
    this.buf.push(`${new Date().toISOString()} [${this.src}] ${msg}`);
    if (this.buf.length >= 20) this.flush();
  }
  error(msg, err) {
    this.buf.push(`${new Date().toISOString()} [${this.src} ERR] ${msg} - ${err?.message || err}`);
    this.flush();
  }
  flush() {
    if (this.buf.length) {
      console.log(this.buf.join('\n'));
      this.buf.length = 0;
    }
  }
}
const logger = new FastLog('BOT');

const sanitize = (v, max = 150) => typeof v === 'string' ? v.replace(/[<>"'`\x00-\x1f]/g, '').slice(0, max) : '';

const DEG2RAD = Math.PI / 180;
function calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const a = Math.sin((lat2 - lat1) * DEG2RAD / 2) ** 2 + 
            Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin((lon2 - lon1) * DEG2RAD / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a)); 
}

function estimateIntensity(mag) {
  if (!mag || mag < 2.0) return 'Ⅰ (무감)';
  if (mag < 3.0) return 'Ⅰ~Ⅱ (조용한 상태에서 소수만 느낌)';
  if (mag < 4.0) return 'Ⅱ~Ⅲ (실내의 일부 사람만 느낌)';
  if (mag < 5.0) return 'Ⅳ~Ⅴ (창문이 흔들리고 잠에서 깸)';
  if (mag < 6.0) return 'Ⅴ~Ⅶ (무거운 가구가 움직이고 벽에 금이 감)';
  return 'Ⅶ 이상 (건물 손상 및 파괴 발생 가능)';
}

function parseKMATime(str) {
  if (!str || str.length !== 14) return Date.now();
  const y = str.slice(0,4), m = str.slice(4,6), d = str.slice(6,8);
  const h = str.slice(8,10), min = str.slice(10,12), s = str.slice(12,14);
  return new Date(`${y}-${m}-${d}T${h}:${min}:${s}+09:00`).getTime();
}

let recentEvents = [];
setInterval(() => {
  const cutoff = Date.now() - CFG.CACHE_TTL;
  recentEvents = recentEvents.filter(e => e.at >= cutoff);
}, 60000);

function isDuplicate({ lat, lon, mag, t }) {
  const now = Date.now();
  for (let i = 0, len = Math.min(5, recentEvents.length); i < len; i++) {
    const e = recentEvents[i];
    if (e.lat && e.lon && Math.abs((mag || 0) - e.mag) <= CFG.DEDUP_MAG && 
        Math.abs((t || 0) - e.t) <= CFG.DEDUP_MS && 
        calcDistance(lat, lon, e.lat, e.lon) <= CFG.DEDUP_KM) {
      return true;
    }
  }
  recentEvents.unshift({ lat, lon, mag, t, at: now });
  return false;
}

class HealthStatus {
  constructor() { this.fails = 0; }
  ok() { this.fails = 0; }
  fail() { this.fails++; }
  isDegraded() { return this.fails >= CFG.CB_THRESH; }
}
const statusSafe = new HealthStatus();
const statusKma = new HealthStatus();
const statusJma = new HealthStatus();

const SENT_CACHE = new Map();
const GUILD_MAP = new Map();
const DATA_DIR = path.resolve(__dirname, 'data');

async function safeSaveFile(filename, dataMap) {
  const filePath = path.join(DATA_DIR, filename);
  const tempPath = `${filePath}.tmp`;
  try {
    const obj = Object.create(null);
    for (const [k, v] of dataMap.entries()) obj[k] = v;
    await fs.writeFile(tempPath, JSON.stringify(obj), 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (e) {
    logger.error(`${filename} 저장 실패`, e);
  }
}

let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const now = Date.now();
    for (const [id, timestamp] of SENT_CACHE.entries()) {
      if (now - timestamp > CFG.CACHE_TTL) SENT_CACHE.delete(id);
    }
    safeSaveFile('sent.json', SENT_CACHE);
    safeSaveFile('guild.json', GUILD_MAP);
  }, 10000);
}

async function initStorage() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const loadFile = async (filename, mapObj) => {
      try {
        const raw = await fs.readFile(path.join(DATA_DIR, filename), 'utf8');
        const parsed = JSON.parse(raw, (k, v) => k === '__proto__' ? undefined : v);
        Object.entries(parsed).forEach(([k, v]) => mapObj.set(k, v));
      } catch (e) {
        if (e.code !== 'ENOENT') logger.error(`${filename} 로드 실패`, e);
      }
    };
    await loadFile('sent.json', SENT_CACHE);
    await loadFile('guild.json', GUILD_MAP);
  } catch (e) {
    logger.error('스토리지 초기화 실패', e);
  }
}

function getTargetChannels() {
  const channels = new Set(ENV.CHANNEL_IDS);
  for (const channelId of GUILD_MAP.values()) channels.add(channelId);
  return [...channels];
}

async function fetchJSON(url, timeoutMs = CFG.API_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

const getJitter = ms => Math.floor(ms * (0.8 + Math.random() * 0.4));
async function fetchWithRetry(fn) {
  for (let i = 0; i <= CFG.RETRY.length; i++) {
    try { return await fn(); } 
    catch (e) {
      if (i < CFG.RETRY.length) await new Promise(r => setTimeout(r, getJitter(CFG.RETRY[i])));
      else throw e;
    }
  }
}

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
  makeCache: Options.cacheWithLimits({ MessageManager: 0, ThreadManager: 0 }),
});

const broadcastQueue = [];
let isBroadcasting = false;

async function broadcastMessage(payload) {
  return new Promise((resolve, reject) => {
    broadcastQueue.push({ payload, resolve, reject });
    if (!isBroadcasting) processBroadcastQueue();
  });
}

async function processBroadcastQueue() {
  isBroadcasting = true;
  while (broadcastQueue.length) {
    const { payload, resolve, reject } = broadcastQueue.shift();
    try {
      const channels = getTargetChannels();
      for (let i = 0; i < channels.length; i += CFG.BROADCAST_CHUNK) {
        const chunk = channels.slice(i, i + CFG.BROADCAST_CHUNK);
        
        await Promise.allSettled(chunk.map(async id => {
          try {
            let ch = discordClient.channels.cache.get(id);
            if (!ch) ch = await discordClient.channels.fetch(id).catch(() => null);
            
            if (ch?.isTextBased()) {
              const perms = ch.permissionsFor(discordClient.user);
              if (perms && perms.has(PermissionsBitField.Flags.SendMessages)) {
                await ch.send(payload);
              }
            }
          } catch (e) {}
        }));
        
        if (i + CFG.BROADCAST_CHUNK < channels.length) {
          await new Promise(r => setTimeout(r, CFG.BROADCAST_DELAY));
        }
      }
      resolve();
    } catch (e) {
      logger.error('Broadcast 에러', e);
      reject(e);
    }
  }
  isBroadcasting = false;
}

async function fetchKMA() {
  try {
    const now = new Date(Date.now() + 9 * 3600000);
    const to = now.toISOString().slice(0, 10).replace(/-/g, '');
    const from = new Date(+now - 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const url = `http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${encodeURIComponent(ENV.KMA_KEY)}&numOfRows=10&pageNo=1&dataType=JSON&fromTmFc=${from}&toTmFc=${to}`;
    
    const data = await fetchWithRetry(() => fetchJSON(url));
    statusKma.ok();

    let items = data?.response?.body?.items?.item;
    if (!items) return;
    items = Array.isArray(items) ? items : [items];

    for (const e of items) {
      if (!e) continue;
      const id = `KMA_${e.tmEqk}_${e.tmSeq}`;
      if (SENT_CACHE.has(id)) continue;

      const lat = Number(e.lat) || null;
      const lon = Number(e.lon) || null;
      const mag = Number(e.mt) || null;
      const t = parseKMATime(String(e.tmEqk));

      if (!lat || !lon) continue;
      if (isDuplicate({ lat, lon, mag, t })) { SENT_CACHE.set(id, Date.now()); continue; }
      SENT_CACHE.set(id, Date.now());

      const mapLink = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
      const estInt = estimateIntensity(mag);
      const color = mag >= 6 ? 0xCC0000 : mag >= 5 ? 0xFF6600 : mag >= 4 ? 0xFFAA00 : 0x00AAFF;
      const emoji = mag >= 6 ? '🔴' : mag >= 5 ? '🟠' : mag >= 4 ? '🟡' : '🔵';

      const embed = new EmbedBuilder()
        .setTitle(`${emoji} 기상청 지진 정보`)
        .setColor(color)
        .addFields(
          { name: '📍 진원지', value: `${sanitize(e.loc, 100)}\n[🗺️ 구글 지도에서 보기](${mapLink})`, inline: false },
          { name: '📈 규모', value: `M${mag.toFixed(1)}`, inline: true },
          { name: '📉 깊이', value: `${e.dep || '? '}km`, inline: true },
          { name: '⚠️ 예상 최대진도', value: estInt, inline: false }
        )
        .setTimestamp(t);

      if (e.rem) embed.addFields({ name: '📝 참고사항', value: sanitize(e.rem, 200), inline: false });

      const payload = mag >= 5.0 ? { content: '@everyone 🚨 강진 발생!', embeds: [embed] } : { embeds: [embed] };
      broadcastMessage(payload).catch(() => {});
    }
    scheduleSave();
  } catch (e) {
    statusKma.fail();
  }
}

async function fetchJMA() {
  try {
    const data = await fetchWithRetry(() => fetchJSON('https://www.jma.go.jp/bosai/quake/data/latest_quakes.json'));
    statusJma.ok();
    
    const items = Array.isArray(data) ? data : [];
    for (const e of items.slice(0, 5)) {
      if (!e) continue;
      const id = `JMA_${e.id || e.eid}`;
      if (SENT_CACHE.has(id)) continue;

      let lat = null, lon = null;
      if (typeof e.lat === 'string' && e.lat.includes('+')) {
        const match = e.lat.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
        if (match) { lat = Number(match[1]); lon = Number(match[2]); }
      } else {
        lat = Number(e.lat); lon = Number(e.lon);
      }
      
      const mag = Number(e.mag) || null;
      const t = new Date(e.originTime || e.at || Date.now()).getTime();

      if (!lat || !lon) continue;
      if (isDuplicate({ lat, lon, mag, t })) { SENT_CACHE.set(id, Date.now()); continue; }
      SENT_CACHE.set(id, Date.now());

      const mapLink = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
      const locName = e.en_loc || e.loc || (e.locations && e.locations[0]?.name) || '일본 해역/내륙';
      const color = mag >= 6 ? 0xCC0000 : mag >= 5 ? 0xFF6600 : 0x00AAFF;

      const embed = new EmbedBuilder()
        .setTitle(`🇯🇵 일본 기상청 지진 정보`)
        .setColor(color)
        .addFields(
          { name: '📍 진원지', value: `${sanitize(locName, 100)}\n[🗺️ 구글 지도에서 보기](${mapLink})`, inline: false },
          { name: '📈 규모', value: `M${mag?.toFixed(1) || '?'}`, inline: true },
          { name: '⚠️ 최대진도', value: sanitize(e.maxInt || e.intensity || '알 수 없음', 20), inline: true }
        )
        .setTimestamp(t);

      broadcastMessage({ embeds: [embed] }).catch(() => {});
    }
    scheduleSave();
  } catch (e) {
    statusJma.fail();
  }
}

async function fetchSafetyData() {
  try {
    const data = await fetchWithRetry(() => fetchJSON(`https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=${encodeURIComponent(ENV.SAFETY_KEY)}&returnType=json&numOfRows=30`));
    statusSafe.ok();
    
    let items = data?.body?.data || data?.data;
    if (!items) return;
    items = Array.isArray(items) ? items : [items];

    for (const e of items) {
      if (!e) continue;
      const id = `SAFE_${sanitize(e.MD101_SN || e.id || '', 50)}`;
      if (!id || SENT_CACHE.has(id)) continue;
      SENT_CACHE.set(id, Date.now());

      const level = (e.MSG_CN || '').includes('위급') ? 'CRITICAL' : (e.MSG_CN || '').includes('긴급') ? 'URGENT' : 'SAFE';
      const colors = { SAFE: 0xFFDD00, URGENT: 0xFF8800, CRITICAL: 0xFF0000 };
      
      const embed = new EmbedBuilder()
        .setTitle(sanitize(e.DSSTR_SE_NM || '재난 알림', 100))
        .setColor(colors[level] || 0xFFDD00)
        .setDescription(sanitize(e.MSG_CN || '', 1000))
        .addFields({ name: '지역', value: sanitize(e.RCV_AREA_NM || '전국', 100), inline: true })
        .setTimestamp();

      const payload = level !== 'SAFE' ? { content: '@everyone', embeds: [embed] } : { embeds: [embed] };
      broadcastMessage(payload).catch(() => {});
    }
    scheduleSave();
  } catch (e) {
    statusSafe.fail();
  }
}

discordClient.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild } = interaction;

  try {
    if (commandName === '상태') {
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('📊 시스템 상태').setColor(0x00FF99).addFields(
          { name: '⚡ 핑 (WS)', value: `${discordClient.ws.ping}ms`, inline: true },
          { name: '⏱️ 가동 시간', value: `${Math.floor(process.uptime() / 3600)}시간`, inline: true },
          { name: '📡 KMA (기상청)', value: statusKma.isDegraded() ? '❌ 오류' : '✅ 정상', inline: true },
          { name: '📡 JMA (일본)', value: statusJma.isDegraded() ? '❌ 오류' : '✅ 정상', inline: true },
          { name: '📡 SAFE (재난)', value: statusSafe.isDegraded() ? '❌ 오류' : '✅ 정상', inline: true },
        ).setTimestamp()],
      });
    }

    if (commandName === '알림') {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ 이 명령어를 사용할 권한(서버 관리하기)이 없습니다.', ephemeral: true });
      }
      const targetChannel = interaction.options.getChannel('channel');
      const guildId = guild?.id || 'global';
      
      GUILD_MAP.set(guildId, targetChannel.id);
      scheduleSave();
      
      return interaction.reply({ content: `✅ 이제부터 지진/재난 알림이 <#${targetChannel.id}> 채널로 전송됩니다.`, ephemeral: true });
    }
  } catch (e) {
    logger.error('명령어 처리 실패', e);
    await interaction.reply({ content: '❌ 처리 중 오류가 발생했습니다.', ephemeral: true }).catch(() => {});
  }
});

const app = express();
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60_000, max: 50, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_, res) => {
  const isHealthy = !statusSafe.isDegraded() && !statusKma.isDegraded() && !statusJma.isDegraded();
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
  });
});

app.listen(ENV.PORT, '0.0.0.0', () => logger.log(`웹 서버 시작됨 (Port: ${ENV.PORT})`));

discordClient.once(Events.ClientReady, async () => {
  logger.log(`디스코드 로그인 완료: ${discordClient.user.tag}`);
  await initStorage();

  setInterval(async () => { try { await fetchSafetyData(); } catch (e) {} }, CFG.MS.SAFE);
  setInterval(async () => { try { await fetchKMA(); } catch (e) {} }, CFG.MS.KMA);
  setInterval(async () => { try { await fetchJMA(); } catch (e) {} }, CFG.MS.JMA);

  if (ENV.APPLICATION_ID) {
    const SLASH_COMMANDS = [
      { name: '상태', description: '봇의 현재 상태와 API 연동 상태를 확인합니다.' },
      { name: '알림', description: '이 채널에 알림을 설정합니다. (관리자 전용)', options: [{ name: 'channel', type: ApplicationCommandOptionType.Channel, required: true }] },
    ];
    const rest = new REST({ version: '10' }).setToken(ENV.DISCORD_TOKEN);
    rest.put(Routes.applicationCommands(ENV.APPLICATION_ID), { body: SLASH_COMMANDS }).catch(e => logger.error('명령어 등록 실패', e));
  }
});

discordClient.on(Events.Error, err => logger.error('디스코드 클라이언트 에러', err));
process.on('unhandledRejection', err => logger.error('Unhandled Rejection', err));

async function gracefulShutdown() {
  logger.log('종료 시그널 수신, 안전하게 종료합니다...');
  await discordClient.destroy();
  
  const now = Date.now();
  for (const [id, timestamp] of SENT_CACHE.entries()) {
    if (now - timestamp > CFG.CACHE_TTL) SENT_CACHE.delete(id);
  }
  await safeSaveFile('sent.json', SENT_CACHE);
  await safeSaveFile('guild.json', GUILD_MAP);
  process.exit(0);
}

process.once('SIGTERM', gracefulShutdown);
process.once('SIGINT', gracefulShutdown);

discordClient.login(ENV.DISCORD_TOKEN).catch(e => logger.error('로그인 실패', e));
