import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';

/* ===== ENV CHECK ===== */
const { TOKEN, CHANNEL_ID, PORT } = process.env;
if (!TOKEN || !CHANNEL_ID || !PORT) {
  console.error('[ENV] Missing required environment variable');
  process.exit(1);
}

/* ===== DISCORD CLIENT ===== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* ===== EXPRESS (Render 포트 바인딩) ===== */
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log(`[WEB] Listening on ${PORT}`));

/* ===== JMA CONFIG ===== */
const JMA_FEED = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';
const CHECK_INTERVAL = 5 * 60 * 1000;
let lastEventId = null;

/* ===== XML PARSER ===== */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ''
});

/* ===== JAPANESE AUTO TRANSLATION ===== */
function translateJP(text) {
  if (!text) return '정보 없음';
  return text
    .replace(/沖/g, '해역')
    .replace(/付近/g, '인근')
    .replace(/北/g, '북')
    .replace(/南/g, '남')
    .replace(/東/g, '동')
    .replace(/西/g, '서');
}

/* ===== FETCH JMA ===== */
async function fetchJMA() {
  try {
    const xml = await axios.get(JMA_FEED, { timeout: 10000 });
    const data = parser.parse(xml.data);
    const entry = data.feed.entry?.[0];
    if (!entry) return;

    if (entry.id === lastEventId) return;
    lastEventId = entry.id;

    const detailXML = await axios.get(entry.link.href, { timeout: 10000 });
    const detail = parser.parse(detailXML.data);

    const eq = detail.Report.Body.Earthquake;
    const intensity = detail.Report.Body.Intensity?.Observation?.MaxInt || '0';

    const maxInt = parseInt(intensity.replace('+', '').replace('-', ''), 10);
    const mention = maxInt >= 5 ? '@everyone' : '';

    const jpLoc = eq.Hypocenter.Area.Name;
    const krLoc = translateJP(jpLoc);

    const embed = new EmbedBuilder()
      .setTitle('🌏 지진 발생 (일본)')
      .setColor(0xff0000)
      .addFields(
        { name: '진원지', value: `${krLoc} (${jpLoc})`, inline: false },
        { name: '규모', value: `M ${eq.Magnitude}`, inline: true },
        { name: '최대 진도', value: intensity, inline: true },
        { name: '발생 시각', value: eq.OriginTime, inline: false }
      )
      .setFooter({ text: '출처: 일본 기상청(JMA)' })
      .setTimestamp(new Date());

    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({ content: mention, embeds: [embed] });

  } catch (e) {
    console.error('[JMA ERROR]', e.message);
  }
}

/* ===== SLASH COMMAND ===== */
const commands = [
  new SlashCommandBuilder()
    .setName('지진')
    .setDescription('일본 최신 지진 정보 확인')
];

client.once('ready', async () => {
  console.log(`[DISCORD] Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  setInterval(fetchJMA, CHECK_INTERVAL);
});

/* ===== INTERACTION ===== */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === '지진') {
    await interaction.reply('최근 일본 지진 감시 중입니다.');
  }
});

/* ===== LOGIN ===== */
client.login(TOKEN);