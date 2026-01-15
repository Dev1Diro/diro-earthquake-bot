const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

/* ===== ENV ===== */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;
const APPLICATION_ID = process.env.APPLICATION_ID;

/* ===== CLIENT ===== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ===== ERROR SAFETY + DEBUG ===== */
client.on('error', err => {
  console.error('[DISCORD ERROR]', err);
  adminAlert(`Discord error\n${err.message}`);
});

process.on('unhandledRejection', err => {
  console.error('[UNHANDLED REJECTION]', err?.rawError?.errors || err);
  adminAlert(`UnhandledRejection\n${err}`);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  adminAlert(`UncaughtException\n${err}`);
});

/* ===== URL ===== */
const NHK_EEW = 'https://www3.nhk.or.jp/sokuho/jishin/data/JishinEEW.json';
const NHK_REPORT = 'https://www3.nhk.or.jp/sokuho/jishin/data/JishinReport.json';
const JMA_FAST = 'https://www.jma.go.jp/bosai/quake/data/earthquake_recent.json';

const KMA_URL =
'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg' +
'?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40' +
'&numOfRows=10&pageNo=1&fromTmFc=20260115&toTmFc=20270115';

const SEOUL_EMER =
'https://news.seoul.go.kr/safety/archives/category/emergency';

/* ===== STATE ===== */
const sent = new Set();
const eewMap = new Map();
const apiFail = { NHK: 0, JMA: 0, KMA: 0 };

/* ===== UTIL ===== */
const isStr = v => typeof v === 'string' && v.trim() !== '';
const key = (...v) => v.join('|');

async function adminAlert(msg) {
  try {
    const ch = await client.channels.fetch(ADMIN_CHANNEL_ID);
    if (ch) ch.send(`⚠️ 운영 알림\n${msg}`);
  } catch {}
}

/* ===== SAFE SEND (중요) ===== */
async function send(title, desc, mention=false) {
  if (!isStr(desc)) return null;

  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch) return null;

  const payload = {
    embeds: [
      new EmbedBuilder()
        .setTitle(String(title).slice(0, 256))
        .setDescription(String(desc).slice(0, 4000))
        .setTimestamp()
    ]
  };

  if (mention === true) {
    payload.content = '@everyone';
  }

  return ch.send(payload);
}

/* ===== SLASH COMMANDS ===== */
const commands = [
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('봇 종료'),

  new SlashCommandBuilder()
    .setName('청소')
    .setDescription('메시지 삭제')
    .addIntegerOption(o =>
      o.setName('수량')
       .setDescription('1~100')
       .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
  await rest.put(
    Routes.applicationCommands(APPLICATION_ID),
    { body: commands }
  );
  console.log('봇 온라인');
});

/* ===== COMMAND HANDLER ===== */
client.on('interactionCreate', async i => {
  if (!i.isCommand()) return;

  if (i.commandName === 'stop') {
    await i.reply('봇 종료');
    process.exit(0);
  }

  if (i.commandName === '청소') {
    const n = i.options.getInteger('수량');
    if (n < 1 || n > 100) {
      return i.reply({ content: '1~100만 가능', ephemeral: true });
    }
    const msgs = await i.channel.messages.fetch({ limit: n });
    await i.channel.bulkDelete(msgs, true);
    await i.reply({ content: `${msgs.size}개 삭제`, ephemeral: true });
  }
});

/* ===== PING ===== */
setInterval(() => {
  axios.get('https://www.google.com').catch(()=>{});
}, 60_000);

/* ===== NHK EEW ===== */
setInterval(async () => {
  try {
    const { data } = await axios.get(NHK_EEW);
    apiFail.NHK = 0;

    for (const e of data) {
      if (!isStr(e.hypocenter) || !isStr(e.maxint) || !isStr(e.origin_time)) continue;
      const k = key('EEW', e.origin_time, e.hypocenter);
      if (sent.has(k)) continue;
      sent.add(k);

      const msg = await send(
        '🇯🇵 NHK 지진 예보(EEW)',
        `위치: ${e.hypocenter}\n예상 최대진도: ${e.maxint}`,
        e.maxint.includes('5')
      );

      if (msg) eewMap.set(k, msg.id);
    }
  } catch {
    if (++apiFail.NHK === 3) adminAlert('NHK EEW API 3회 연속 실패');
  }
}, 15_000);

/* ===== NHK REPORT ===== */
setInterval(async () => {
  try {
    const { data } = await axios.get(NHK_REPORT);
    apiFail.NHK = 0;

    const ch = await client.channels.fetch(CHANNEL_ID);

    for (const e of data) {
      if (!isStr(e.hypocenter) || !isStr(e.magnitude) || !isStr(e.maxint)) continue;
      const k = key('NHK', e.origin_time, e.hypocenter);
      if (sent.has(k)) continue;
      sent.add(k);

      const eewKey = key('EEW', e.origin_time, e.hypocenter);
      if (eewMap.has(eewKey) && ch) {
        const old = await ch.messages.fetch(eewMap.get(eewKey));
        await old.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🔁 예보 → 관측 확정')
              .setDescription(
                `위치: ${e.hypocenter}\n규모: ${e.magnitude}\n최대진도: ${e.maxint}`
              )
              .setTimestamp()
          ]
        });
        eewMap.delete(eewKey);
      }

      await send(
        '🇯🇵 NHK 지진 속보',
        `위치: ${e.hypocenter}\n규모: ${e.magnitude}\n최대진도: ${e.maxint}`,
        e.maxint.includes('5')
      );
    }
  } catch {
    if (++apiFail.NHK === 3) adminAlert('NHK REPORT API 3회 연속 실패');
  }
}, 30_000);

/* ===== JMA ===== */
setInterval(async () => {
  try {
    const { data } = await axios.get(JMA_FAST);
    apiFail.JMA = 0;

    for (const e of data) {
      if (!isStr(e.place) || !isStr(e.intensity) || !isStr(e.time)) continue;
      const k = key('JMA', e.time, e.place);
      if (sent.has(k)) continue;
      sent.add(k);

      await send(
        '🇯🇵 JMA 실시간 지진',
        `위치: ${e.place}\n규모: ${e.magnitude}\n최대진도: ${e.intensity}`,
        e.intensity.includes('5+')
      );
    }
  } catch {
    if (++apiFail.JMA === 3) adminAlert('JMA API 3회 연속 실패');
  }
}, 45_000);

/* ===== KMA ===== */
setInterval(async () => {
  try {
    const { data } = await axios.get(KMA_URL);
    apiFail.KMA = 0;

    const items = data?.response?.body?.items?.item || [];
    for (const e of items) {
      if (!isStr(e.eqPlace) || !isStr(e.eqMagnitude) || !isStr(e.maxInten)) continue;
      const k = key('KMA', e.earthquakeNo);
      if (sent.has(k)) continue;
      sent.add(k);

      await send(
        '🇰🇷 KMA 지진',
        `위치: ${e.eqPlace}\n규모: ${e.eqMagnitude}\n진도: ${e.maxInten}`,
        Number(e.maxInten) >= 4
      );
    }
  } catch {
    if (++apiFail.KMA === 3) adminAlert('KMA API 3회 연속 실패');
  }
}, 60_000);

/* ===== SEOUL ===== */
setInterval(async () => {
  try {
    const html = await axios.get(SEOUL_EMER);
    const $ = cheerio.load(html.data);
    $('.list_body li').slice(0,3).each((_, el) => {
      const title = $(el).find('a').text().trim();
      const date = $(el).find('.date').text().trim();
      if (!isStr(title) || !isStr(date)) return;
      const k = key('SEOUL', title, date);
      if (sent.has(k)) return;
      sent.add(k);

      send('⚠️ 서울 안전안내문자', `${title}\n(${date})`, true);
    });
  } catch {}
}, 90_000);

client.login(TOKEN);