import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import express from "express";

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Render 핑용 간단 서버
const app = express();
app.get("/", (req, res) => res.send("OK"));
app.listen(3000);

let lastJmaId = null;

// GMT+9 변환
function toGMT9(timeStr) {
  const d = new Date(timeStr);
  d.setHours(d.getHours() + 9);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// 지진 체크
async function checkJMA() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) return;

  const list = await fetch("https://www.jma.go.jp/bosai/quake/data/list.json")
    .then(r => r.json());

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

  // 한국 지진 판정 (JMA 데이터)
  if (/Korea|대한민국|South/i.test(name)) {
    title = "🇰🇷 한국 지진 발생";
    mention = mag >= 4.0 ? "@everyone" : "@here";
  }
  // 일본 지진
  else if (/Japan|일본|Honshu|Hokkaido|Kyushu/i.test(name)) {
    title = "🇯🇵 일본 지진 발생";
    mention = maxScale >= 55 ? "@everyone" : "";
    if (!mention) return; // 조건 안 맞으면 메시지 없음
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

// 봇 준비 완료 이벤트
client.once("ready", async () => {
  console.log("지진 알림 봇 실행됨");

  // 테스트용 강제 메시지
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (channel) {
    await channel.send("🧪 테스트 메시지: 봇 정상 작동 중");
  }

  // 30초마다 지진 체크
  setInterval(checkJMA, 30000);
});

client.login(TOKEN);