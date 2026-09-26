import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fixedNow = Date.parse('2026-09-25T15:05:00Z'); // Just after midnight KST.
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
}

function loadBot(fetchImpl = async () => new Response('{}'), env = {}) {
  const context = vm.createContext({
    crypto, dns: { setDefaultResultOrder() {} }, Date: Clock,
    console: { log() {}, warn() {}, error() {} },
    process: {
      env: { DISCORD_TOKEN: 'test-token', CHANNEL_ID: '123456789012345678',
        KMA_KEY: 'test+kma/key=', SAFETY_KEY: 'test-safety', ...env },
      exit(code) { throw new Error(`Unexpected process exit: ${code}`); },
    },
    fetch: fetchImpl, AbortController, TextDecoder, Uint8Array,
    setTimeout, clearTimeout, URL,
  });
  // Exercise the production functions without starting a server or sending real alerts.
  const functions = source.replace(/^import .*;\r?\n/gm, '').split('const server = http.createServer(handleHttp);')[0];
  vm.runInContext(functions + `
    sleep = async () => {};
    globalThis.bot = {
      getKmaRange, parseApiRecords, parseKstLikeTime, keyCandidates, buildUrl,
      checkKmaEarthquakes, checkSafetyMessages, runChecks, kmaId, wasSent,
      handleHttp, verifyDiscordToken,
      state: () => ({ lastKmaStatus, lastSafetyStatus, lastDiscordStatus, checksRunning }),
    };`, context);
  return context.bot;
}

function kmaItem() {
  return { tmEqk: '20260925234500', tmFc: '202609260004', tmSeq: '1',
    loc: '테스트 진앙', mt: '3.0', lat: '36', lon: '128', inT: 'III' };
}

test('KMA date range ends today and crosses KST midnight correctly', () => {
  const range = loadBot().getKmaRange();
  assert.equal(range.fromTmFc, '20260925');
  assert.equal(range.toTmFc, '20260926');
});

test('API envelopes, empty results, and errors are distinguished', () => {
  const bot = loadBot();
  assert.equal(bot.parseApiRecords(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [kmaItem()] } } } })).length, 1);
  assert.equal(bot.parseApiRecords('{"header":{"resultCode":"00"},"body":[]}').length, 0);
  assert.equal(bot.parseApiRecords('{"header":{"resultCode":"00"},"body":[{"SN":"1","MSG_CN":"test"}]}')[0].SN, '1');
  assert.throws(() => bot.parseApiRecords('{"response":{"header":{"resultCode":"30","resultMsg":"INVALID KEY"}}}'), /30.*INVALID KEY/);
  assert.throws(() => bot.parseApiRecords('<response><header><resultCode>22</resultCode><resultMsg>LIMIT</resultMsg></header></response>'), /22.*LIMIT/);
  assert.throws(() => bot.parseApiRecords('<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>'), /30/);
  assert.equal(bot.parseApiRecords('<response><header><resultCode>03</resultCode><resultMsg>NO_DATA</resultMsg></header></response>').length, 0);
  assert.equal(bot.parseApiRecords('<response><item><loc><![CDATA[A & B]]></loc><mt>3</mt></item></response>')[0].loc, 'A & B');
});

test('API keys are encoded once and ISO timezone offsets are respected', () => {
  const bot = loadBot();
  for (const key of ['a+b/c=', 'a%2Bb%2Fc%3D']) {
    const url = bot.buildUrl('https://example.test/api', bot.keyCandidates(key)[0]);
    assert.equal(new URL(url).searchParams.get('serviceKey'), 'a+b/c=');
  }
  assert.equal(bot.parseKstLikeTime('2026-09-25T15:04:00Z'), Date.parse('2026-09-25T15:04:00Z'));
  assert.equal(bot.parseKstLikeTime('2026-09-26 00:04:00'), Date.parse('2026-09-25T15:04:00Z'));
});

test('failed delivery is retried next poll; successful delivery is deduplicated', async () => {
  let fail = true;
  let successfulSends = 0;
  const bot = loadBot(async (url) => {
    if (url.startsWith('https://discord.com')) {
      if (fail) return new Response('{"message":"Missing Permissions"}', { status: 403 });
      successfulSends++;
      return new Response('{"id":"test-message"}');
    }
    const params = new URL(url).searchParams;
    assert.equal(params.get('toTmFc'), '20260926');
    assert.equal(params.get('dataType'), 'JSON');
    assert.equal(params.get('serviceKey'), 'test+kma/key=');
    return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [kmaItem()] } } } }));
  });
  await assert.rejects(bot.checkKmaEarthquakes(), /403/);
  assert.equal(bot.wasSent(bot.kmaId(kmaItem())), false);
  fail = false;
  await bot.checkKmaEarthquakes();
  await bot.checkKmaEarthquakes();
  assert.equal(successfulSends, 1); // Event was older than five minutes; recent announcement is accepted.
});

test('rate-limited Discord sends only become sent after success', async () => {
  let attempts = 0;
  const bot = loadBot(async (url) => {
    if (!url.startsWith('https://discord.com')) return new Response(JSON.stringify([kmaItem()]));
    attempts++;
    return attempts === 1 ? new Response('{"retry_after":0.01}', { status: 429 }) : new Response('{}');
  });
  await bot.checkKmaEarthquakes();
  assert.equal(attempts, 2);
  assert.equal(bot.wasSent(bot.kmaId(kmaItem())), true);
});

test('safety API uses official region field and does not replay stale or future messages', async () => {
  const payloads = [];
  const bot = loadBot(async (url, options) => {
    if (url.startsWith('https://discord.com')) {
      payloads.push(JSON.parse(options.body));
      return new Response('{}');
    }
    const params = new URL(url).searchParams;
    assert.equal(new URL(url).pathname, '/V2/api/DSSP-IF-00247');
    assert.equal(params.get('returnType'), 'json');
    assert.equal(params.get('numOfRows'), '100');
    return new Response(JSON.stringify({ header: { resultCode: '00' }, body: [
      { SN: '1', MSG_CN: '최근 안내', RCPTN_RGN_NM: '서울', CRT_DT: '2026-09-26 00:04:00' },
      { SN: '2', MSG_CN: '오래된 안내', CRT_DT: '2026-09-25 12:00:00' },
      { SN: '3', MSG_CN: '미래 안내', CRT_DT: '2026-09-27 00:04:00' },
    ] }));
  });
  await bot.checkSafetyMessages();
  await bot.checkSafetyMessages();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].embeds[0].fields[0].value, '서울');
});

test('API failure is visible and subsequent checks recover, even with broken log channel', async () => {
  let fail = true;
  const bot = loadBot(async (url) => {
    if (url.startsWith('https://discord.com')) return new Response('{}', { status: 403 });
    if (fail) return new Response('{"header":{"resultCode":"30","resultMsg":"INVALID KEY"}}');
    return new Response('{"header":{"resultCode":"00"},"body":[]}');
  }, { LOGS: '234567890123456789' });
  await bot.runChecks();
  assert.match(bot.state().lastKmaStatus, /^error:/);
  assert.equal(bot.state().checksRunning, false);
  fail = false;
  await bot.runChecks();
  assert.match(bot.state().lastKmaStatus, /^ok:/);
  assert.equal(bot.state().checksRunning, false);
});

test('one missing API key does not terminate the other source or health endpoint', async () => {
  const bot = loadBot(async () => new Response('{"header":{"resultCode":"00"},"body":[]}'), { SAFETY_KEY: '' });
  await bot.runChecks();
  assert.match(bot.state().lastSafetyStatus, /^disabled:/);
  assert.match(bot.state().lastKmaStatus, /^ok:/);
  let body;
  const response = { setHeader() {}, writeHead(status) { assert.equal(status, 200); }, end(text) { body = JSON.parse(text); } };
  bot.handleHttp({ url: '/health', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response);
  assert.equal(body.status, 'ok');
  assert.match(body.safety, /^disabled:/);
  assert.ok('discord' in body);
});
