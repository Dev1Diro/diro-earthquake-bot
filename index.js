diff --git a/index.js b/index.js
index f306fe13f25896d8aa7e93b01da61a17dac65497..c284892a440748ab665edbc088343590192aa81f 100644
--- a/index.js
+++ b/index.js
@@ -1,219 +1,270 @@
 /*************************************************
  * Earthquake Alert Discord Bot
  * FINAL STABLE VERSION
  * KMA (Korea) + JMA (Japan)
  *************************************************/
 
 import 'dotenv/config';
 import express from 'express';
 import axios from 'axios';
 import {
   Client,
   GatewayIntentBits,
   EmbedBuilder,
   REST,
   Routes,
   PermissionsBitField
 } from 'discord.js';
 
 /* =========================
    ENV VALIDATION
 ========================= */
 const {
   DISCORD_TOKEN,
   APPLICATION_ID,
   OWNER_ID,
-  DISCORD_CHANNEL_ID,
-  PORT
-} = process.env;
-
-if (!DISCORD_TOKEN || !APPLICATION_ID || !OWNER_ID || !DISCORD_CHANNEL_ID) {
-  console.error('[ENV] Missing required environment variable');
-  process.exit(1);
-}
+  PORT
+} = process.env;
+
+const CHANNEL_IDS = ['1460620799055495352', '1468559204217520150'];
+
+if (!DISCORD_TOKEN || !APPLICATION_ID || !OWNER_ID) {
+  console.error('[ENV] Missing required environment variable');
+  process.exit(1);
+}
 
 /* =========================
    EXPRESS (Render Port Bind)
 ========================= */
 const app = express();
 app.get('/', (_, res) => res.send('OK'));
 app.listen(PORT || 3000);
 
 /* =========================
    DISCORD CLIENT
 ========================= */
 const client = new Client({
   intents: [
     GatewayIntentBits.Guilds,
     GatewayIntentBits.GuildMessages,
     GatewayIntentBits.MessageContent
   ]
 });
 
 /* =========================
    STATE
 ========================= */
 const sent = {
   kma: new Set(),
   jma: new Set()
 };
 let running = true;
 
-/* =========================
-   UTIL
-========================= */
-const isOwner = id => id === OWNER_ID;
-
-async function sendEmbed(embed, everyone = false) {
-  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
-  await channel.send({
-    content: everyone ? '@everyone' : undefined,
-    embeds: [embed]
-  });
-}
+/* =========================
+   UTIL
+========================= */
+const isOwner = id => id === OWNER_ID;
+const api = axios.create({
+  timeout: 8000,
+  validateStatus: status => status >= 200 && status < 300
+});
+const channelCache = new Map();
+
+async function getChannel(id) {
+  const now = Date.now();
+  const cached = channelCache.get(id);
+  if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
+    return cached.channel;
+  }
+
+  try {
+    const channel = await client.channels.fetch(id);
+    channelCache.set(id, { channel: channel ?? null, fetchedAt: now });
+    return channel ?? null;
+  } catch (err) {
+    console.error('[DISCORD ERROR] 채널 조회 실패', err?.message);
+    return null;
+  }
+}
+
+async function sendEmbed(embed, everyone = false) {
+  try {
+    await Promise.all(
+      CHANNEL_IDS.map(async id => {
+        const channel = await getChannel(id);
+        if (!channel) return;
+        await channel.send({
+          content: everyone ? '@everyone' : undefined,
+          embeds: [embed]
+        });
+      })
+    );
+  } catch (err) {
+    console.error('[DISCORD ERROR] 메시지 전송 실패', err?.message);
+  }
+}
 
 /* =========================
    KMA (Korea)
 ========================= */
 const KMA_URL =
   'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg';
 
-async function fetchKMA() {
-  try {
-    const res = await axios.get(KMA_URL, {
-      params: {
-        serviceKey: '24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40',
-        numOfRows: 10,
-        pageNo: 1,
-        dataType: 'JSON',
-        fromTmFc: '20260115',
-        toTmFc: '20280115'
-      },
-      timeout: 8000
-    });
-
-    const items = res.data?.response?.body?.items?.item;
-    if (!Array.isArray(items)) return;
-
-    for (const e of items) {
-      if (sent.kma.has(e.tmEqk)) continue;
-      sent.kma.add(e.tmEqk);
-
-      const mag = Number(e.mt);
-      const embed = new EmbedBuilder()
-        .setTitle('🌏 지진 발생 (대한민국)')
-        .setColor(0xffffff)
-        .setDescription(
-          `📍 위치: ${e.loc}\n` +
-          `📏 규모: **${mag}**\n` +
-          `🕒 발생시각: ${e.tmEqk}`
-        )
-        .setFooter({ text: 'KMA / 기상청' });
-
-      await sendEmbed(embed, mag >= 4.0);
+async function fetchKMA() {
+  try {
+    const res = await api.get(KMA_URL, {
+      params: {
+        serviceKey: '24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40',
+        numOfRows: 10,
+        pageNo: 1,
+        dataType: 'JSON',
+        fromTmFc: '20260115',
+        toTmFc: '20280115'
+      }
+    });
+
+    const items = res.data?.response?.body?.items?.item;
+    if (!Array.isArray(items)) return;
+
+    for (const e of items) {
+      if (!e?.tmEqk || !e?.loc) continue;
+      if (sent.kma.has(e.tmEqk)) continue;
+      sent.kma.add(e.tmEqk);
+
+      const mag = Number(e.mt);
+      const color = mag >= 5 ? 0xd32f2f : mag >= 4 ? 0xf57c00 : 0x1976d2;
+      const embed = new EmbedBuilder()
+        .setTitle('🌏 지진 발생 (대한민국)')
+        .setColor(color)
+        .setDescription('지진 관측 정보가 업데이트되었습니다.')
+        .addFields(
+          { name: '📍 위치', value: e.loc, inline: false },
+          { name: '📏 규모', value: Number.isFinite(mag) ? `**${mag.toFixed(1)}**` : '정보 없음', inline: true },
+          { name: '🕒 발생시각', value: e.tmEqk, inline: true }
+        )
+        .setFooter({ text: 'KMA / 기상청' })
+        .setTimestamp(new Date(e.tmEqk));
+
+      await sendEmbed(embed, mag >= 4.0);
     }
-  } catch (e) {
-    console.error('[KMA ERROR]', e.message);
-  }
-}
+  } catch (e) {
+    console.error('[KMA ERROR]', e?.message || e);
+  }
+}
 
 /* =========================
    JMA (Japan)
 ========================= */
 const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';
 
-async function fetchJMA() {
-  try {
-    const res = await axios.get(JMA_URL, { timeout: 8000 });
-    if (!Array.isArray(res.data)) return;
-
-    const now = Date.now();
-
-    for (const e of res.data) {
-      const id = e.time + e.lat + e.lon;
-      if (sent.jma.has(id)) continue;
-
-      const t = new Date(e.time).getTime();
-      if (now - t > 10 * 60 * 1000) continue;
-
-      sent.jma.add(id);
-
-      const intensity = Number(e.maxi || 0);
-      const embed = new EmbedBuilder()
-        .setTitle('🌋 지진 발생 (일본)')
-        .setColor(0xff0000)
-        .setDescription(
-          `📍 위치: ${e.place}\n` +
-          `📏 규모: **${e.mag}**\n` +
-          `🕒 발생시각: ${e.time}`
-        )
-        .setFooter({ text: 'JMA / Japan Meteorological Agency' });
-
-      await sendEmbed(embed, intensity >= 5);
+async function fetchJMA() {
+  try {
+    const res = await api.get(JMA_URL);
+    if (!Array.isArray(res.data)) return;
+
+    const now = Date.now();
+
+    for (const e of res.data) {
+      if (!e?.time || !e?.place) continue;
+      const id = `${e.time}-${e.lat}-${e.lon}-${e.place}`;
+      if (sent.jma.has(id)) continue;
+
+      const t = new Date(e.time).getTime();
+      if (!Number.isFinite(t) || now - t > 10 * 60 * 1000) continue;
+
+      sent.jma.add(id);
+
+      const intensity = Number(e.maxi || 0);
+      const mag = Number(e.mag);
+      const color = intensity >= 5 ? 0xd32f2f : intensity >= 4 ? 0xf57c00 : 0x1976d2;
+      const embed = new EmbedBuilder()
+        .setTitle('🌋 지진 발생 (일본)')
+        .setColor(color)
+        .setDescription('일본 기상청 지진 정보를 전송합니다.')
+        .addFields(
+          { name: '📍 위치', value: e.place, inline: false },
+          { name: '📏 규모', value: Number.isFinite(mag) ? `**${mag.toFixed(1)}**` : '정보 없음', inline: true },
+          { name: '💥 최대진도', value: e.maxi ? `${e.maxi}` : '정보 없음', inline: true },
+          { name: '🕒 발생시각', value: e.time, inline: true }
+        )
+        .setFooter({ text: 'JMA / Japan Meteorological Agency' })
+        .setTimestamp(new Date(e.time));
+
+      await sendEmbed(embed, intensity >= 5);
     }
-  } catch (e) {
-    console.error('[JMA ERROR]', e.message);
-  }
-}
+  } catch (e) {
+    console.error('[JMA ERROR]', e?.message || e);
+  }
+}
 
 /* =========================
    SCHEDULER
 ========================= */
-setInterval(async () => {
-  if (!running) return;
-  await fetchKMA();
-  await fetchJMA();
-}, 60_000);
+let pollInFlight = false;
+setInterval(async () => {
+  if (!running || pollInFlight) return;
+  pollInFlight = true;
+  try {
+    await fetchKMA();
+    await fetchJMA();
+  } finally {
+    pollInFlight = false;
+  }
+}, 60_000);
 
 /* =========================
    SLASH COMMANDS
 ========================= */
 const commands = [
   { name: '상태', description: '봇 상태 확인' },
   { name: '청소', description: '캐시 초기화' },
   { name: 'stop', description: '봇 종료' }
 ];
 
 const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
 await rest.put(
   Routes.applicationCommands(APPLICATION_ID),
   { body: commands }
 );
 
 /* =========================
    COMMAND HANDLER
 ========================= */
 client.on('interactionCreate', async i => {
   if (!i.isChatInputCommand()) return;
   if (!isOwner(i.user.id)) return i.reply({ content: '권한 없음', ephemeral: true });
 
   if (i.commandName === '상태') {
     await i.reply('🟢 정상 작동 중');
   }
 
   if (i.commandName === '청소') {
     sent.kma.clear();
     sent.jma.clear();
     await i.reply('🧹 캐시 초기화 완료');
   }
 
   if (i.commandName === 'stop') {
     await i.reply('⛔ 봇 종료');
     process.exit(0);
   }
 });
 
 /* =========================
    READY
 ========================= */
 client.once('ready', () => {
   console.log(`로그인 완료: ${client.user.tag}`);
 });
 
 /* =========================
    SAFETY
 ========================= */
-process.on('unhandledRejection', () => {});
-process.on('uncaughtException', () => {});
-
-client.login(DISCORD_TOKEN);
\ No newline at end of file
+process.on('unhandledRejection', err => {
+  console.error('[UNHANDLED REJECTION]', err);
+});
+process.on('uncaughtException', err => {
+  console.error('[UNCAUGHT EXCEPTION]', err);
+});
+
+client.login(DISCORD_TOKEN);