import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import express from "express";

// ===== 환경변수 =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== Render 핑용 웹서버 =====
const app = express();
app.get("/", (req, res) => res.send("OK"));
app.listen(3000);

// ===== 중복 방지 =====
let lastJmaId = null;

// ===== 유틸 =====
function isKorea(name) {
  return /Korea|대한민국|South/i.test(name);
}

function isJapan(name) {
  return /Japan|일본|Honshu|Hokkaido|Kyushu/i.test(name);
}

function toGMT9(timeStr) {
  const d = new Date(timeStr);
  d.setHours(d.getHours() + 9);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// ===== 지진 체크 =====
async function checkEarthquake() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) return;

  const list = await fetch(
    "https://www.jma.go.jp/bosai/quake/data/list.json"
  ).then(r => r.json());

  const latest = list[0];
  if (!latest || latest.id === lastJmaId) return;
  lastJmaId = latest.id;

  const eq = latest.earthquake;
  if (!eq) return;

  const name = eq.hypocenter.name;
  const mag = eq.magnitude;
  const maxScale = eq.maxScale;
  const time = toGMT9(eq.time);

  let mention = "";
  let title = "";

  // 🇰🇷 한국
  if (isKorea(name)) {
    title = "🇰🇷 한국 지진 발생";
    mention = mag >= 4.0 ? "@everyone" : "@here";
  }
  // 🇯🇵 일본
  else if (isJapan(name)) {
    title = "🇯🇵 일본 지진 발생";
    mention = maxScale >= 55 ? "@everyone" : "";
  } else {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .addFields(
      { name: "위치", value: name },
      { name: "규모", value: mag ? mag.toString() : "정보없음", inline: true },
      { name: "최대진도", value: maxScale ? maxScale.toString() : "해당없음", inline: true },
      { name: "발생 시각 (GMT+9)", value: time }
    )
    .setFooter({ text: "출처: 일본기상청(JMA)" });

  await channel.send({ content: mention, embeds: [embed] });
}

// ===== 실행 =====
client.once("ready", () => {
  console.log("지진 알림 봇 실행됨");
  setInterval(checkEarthquake, 30000);
});

client.login(TOKEN);