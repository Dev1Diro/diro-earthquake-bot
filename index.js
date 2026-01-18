import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} from 'discord.js';

/* ================= ENV ================= */
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.PORT || 10000;

if (!TOKEN || !CHANNEL_ID) {
  console.error('[ENV] TOKEN or CHANNEL_ID missing');
  process.exit(1);
}

/* ================= WEB SERVER (Render) ================= */
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log(`[WEB] ${PORT}`));

/* ================= DISCORD ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* ================= API ================= */
const KMA_URL = 'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=24bc4012ff20c13ec2e86cf01deeee5fdc93676f4ea9f24bbc87097e0b1a2d40&numOfRows=10&pageNo=1&fromTmFc=20260115&toTmFc=20290115';
const JMA_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json';

const SENT = new Set();

/* ================= UTIL ================= */
function jmaIntensityToNum(v) {
  if (!v) return 0;
  if (v.includes('7')) return 7;
  if (v.includes('6強')) return 6.5;
  if (v.includes('6弱')) return 6;
  if (v.includes('5強')) return 5.5;
  if (v.includes('5弱')) return 5;
  return Number(v) || 0;
}

/* ================= KMA ================= */
async function checkKMA() {
  try {
    const { data } = await axios.get(KMA_URL, { timeout: 10000 });
    const eq = data?.body?.[0];
    if (!eq || SENT.has(eq.tmFc)) return;

    SENT.add(eq.tmFc);
    const mag = Number(eq.mag);
    const mention = mag >= 4 ? '@everyone' : '';

    const embed = new EmbedBuilder()
      .setTitle('🇰🇷 한국 지진')
      .setDescription(`위치: ${eq.loc}\n규모: **${mag}**`)
      .setColor(mag >= 4 ? 0xff0000 : 0xffff00)
      .setFooter({ text: 'KMA' });

    const ch = await client.channels.fetch(CHANNEL_ID);
    await ch.send({ content: mention, embeds: [embed] });

  } catch (e) {
    console.error('[KMA ERROR]', e.message);
  }
}

/* ================= JMA ================= */
async function checkJMA() {
  try {
    const { data } = await axios.get(JMA_URL, { timeout: 10000 });
    const q = data?.[0];
    if (!q || SENT.has(q.eid)) return;

    SENT.add(q.eid);
    const intensity = jmaIntensityToNum(q.maxi);
    const mention = intensity >= 5 ? '@everyone' : '';

    const embed = new EmbedBuilder()
      .setTitle('🇯🇵 일본 지진')
      .setDescription(`지역: ${q.anm}\n최대 진도: **${q.maxi}**`)
      .setColor(intensity >= 5 ? 0xff0000 : 0xffaa00)
      .setFooter({ text: 'JMA' });

    const ch = await client.channels.fetch(CHANNEL_ID);
    await ch.send({ content: mention, embeds: [embed] });

  } catch (e) {
    console.error('[JMA ERROR]', e.message);
  }
}

/* ================= SLASH COMMAND ================= */
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('봇 상태'),
  new SlashCommandBuilder().setName('force').setDescription('지진 수동 체크')
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  setInterval(checkKMA, 60_000);
  setInterval(checkJMA, 60_000);
});

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'ping') {
    await i.reply('🟢 정상 작동 중');
  }

  if (i.commandName === 'force') {
    await i.reply('⏳ 수동 체크');
    await checkKMA();
    await checkJMA();
  }
});

client.login(TOKEN);