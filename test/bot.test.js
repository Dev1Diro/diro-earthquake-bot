import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { configureSecrets, redact } from '../security.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fixedNow = Date.parse('2026-09-25T15:05:00Z'); // Just after midnight KST.
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
}

function loadBot(fetchImpl = async () => new Response('{}'), env = {}) {
  const context = vm.createContext({
    crypto, XMLParser, XMLValidator, configureSecrets, redact, dns: { setDefaultResultOrder() {} }, Date: Clock,
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
      handleHttp, fetchTextWithKeyFallback,
      allowHttpRequest, clientIp,
      fetchApiPages, safetyId,
      bucketCount: () => httpBuckets.size,
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

test('XML parser handles namespaces, numeric entities, CDATA, and string IDs', () => {
  const bot = loadBot();
  const rows = bot.parseApiRecords('<ns:response xmlns:ns="urn:test"><ns:body><ns:items><ns:item><SN>000123</SN><MSG_CN>&#xC9C0;&#xC9C4; &amp; 안내</MSG_CN></ns:item><ns:item><SN>000124</SN><MSG_CN><![CDATA[긴급 <안내>]]></MSG_CN></ns:item></ns:items></ns:body></ns:response>');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].SN, '000123');
  assert.equal(rows[0].MSG_CN, '지진 & 안내');
  assert.equal(rows[1].MSG_CN, '긴급 <안내>');
  assert.throws(() => bot.parseApiRecords('<!DOCTYPE x><response/>'), /DOCTYPE/);
});

test('Safety IP denial is actionable, not retried as a key encoding problem, and recovers', async () => {
  let denied = true;
  let safetyRequests = 0;
  let errorLogs = 0;
  const bot = loadBot(async (url, options) => {
    if (url.startsWith('https://discord.com')) {
      const payload = JSON.parse(options.body);
      if (payload.embeds[0].title === '봇 오류 로그') errorLogs++;
      return new Response('{}');
    }
    if (url.startsWith('https://www.safetydata.go.kr')) {
      safetyRequests++;
      if (denied) return new Response('{"header":{"resultCode":"32","resultMsg":"UNREGISTERED IP ERROR"}}');
    }
    return new Response('{"header":{"resultCode":"00"},"body":[]}');
  }, { SAFETY_KEY: 'a%2Bb', LOGS: '234567890123456789' });
  await bot.runChecks();
  assert.equal(safetyRequests, 1);
  assert.match(bot.state().lastSafetyStatus, /Connect.*Outbound/);
  await bot.runChecks();
  assert.equal(safetyRequests, 2);
  assert.equal(errorLogs, 1);
  denied = false;
  await bot.runChecks();
  assert.match(bot.state().lastSafetyStatus, /^ok:/);
});

test('JSON service errors, invalid XML and unsupported response bodies are never healthy empty results', () => {
  const bot = loadBot();
  for (const code of ['10', '12', '22', '30']) {
    assert.throws(() => bot.parseApiRecords(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: code, returnAuthMsg: 'API error' } } })), new RegExp(`API ${code}`));
  }
  for (const body of ['', 'UPSTREAM SERVER UNAVAILABLE', '{"unexpected":true}', '<response><body></response>']) assert.throws(() => bot.parseApiRecords(body));
});

test('a failed alert does not starve later alerts and only successful sends are remembered', async () => {
  const second = { ...kmaItem(), tmSeq: '2', loc: '두 번째 진앙' };
  let attempts = 0;
  const bot = loadBot(async (url, options) => {
    if (!url.startsWith('https://discord.com')) return new Response(JSON.stringify([kmaItem(), second]));
    attempts++;
    const first = JSON.parse(options.body).embeds[0].fields[0].value === '테스트 진앙';
    return new Response('{}', { status: first ? 400 : 200 });
  });
  await assert.rejects(bot.checkKmaEarthquakes(), /failed=1, sent=1/);
  assert.equal(attempts, 2);
  assert.equal(bot.wasSent(bot.kmaId(kmaItem())), false);
  assert.equal(bot.wasSent(bot.kmaId(second)), true);
});

test('extreme Discord rate limits fail promptly rather than freezing polling', async () => {
  let requests = 0;
  const bot = loadBot(async url => {
    if (!url.startsWith('https://discord.com')) return new Response(JSON.stringify([kmaItem()]));
    requests++;
    return new Response('{"retry_after":86400}', { status: 429 });
  });
  await assert.rejects(bot.checkKmaEarthquakes(), /next poll/);
  assert.equal(requests, 1);
});

test('successful polling keeps fetched telemetry out of the guild log channel and defaults to no ping', async () => {
  const payloads = [];
  const bot = loadBot(async (url, options) => {
    if (!url.startsWith('https://discord.com')) return new Response(JSON.stringify([kmaItem()]));
    payloads.push(JSON.parse(options.body));
    assert.match(url, /123456789012345678\/messages$/);
    return new Response('{}');
  }, { LOGS: '234567890123456789' });
  await bot.checkKmaEarthquakes();
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].allowed_mentions.parse, []);
  assert.doesNotMatch(payloads[0].content, /@everyone/);
});

test('pagination retrieves alerts after the first API page', async () => {
  const pages = [];
  const bot = loadBot(async url => {
    const page = Number(new URL(url).searchParams.get('pageNo'));
    pages.push(page);
    return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: 3, items: { item: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] } } } }));
  });
  const records = await bot.fetchApiPages('https://example.test/api', 'test-key', { numOfRows: 2 });
  assert.equal(records.length, 3);
  assert.deepEqual(pages, [1, 2]);
});

test('future safety notifications remain eligible for a subsequent poll', async () => {
  const item = { SN: 'future', MSG_CN: '안내', CRT_DT: '2026-09-26 00:08:00' };
  const bot = loadBot(async () => new Response(JSON.stringify({ header: { resultCode: '00' }, body: [item] })));
  await bot.checkSafetyMessages();
  assert.equal(bot.wasSent(bot.safetyId(item)), false);
});

test('malformed request targets return 400 and attacker Host cannot crash the listener', () => {
  const bot = loadBot();
  for (const [target, expected] of [['/health', 200], ['/%ZZ', 400], ['//evil.test/', 400], ['/%2eenv', 403]]) {
    let status;
    bot.handleHttp({ url: target, method: 'GET', headers: { host: '[', 'x-forwarded-for': 'spoof' }, socket: { remoteAddress: '127.0.0.1' } }, { setHeader() {}, writeHead(code) { status = code; }, end() {} });
    assert.equal(status, expected);
  }
});

test('forwarded address spoofing does not bypass limits and bucket memory is bounded', () => {
  const bot = loadBot();
  for (let i = 0; i < 25; i++) {
    const ip = bot.clientIp({ headers: { 'x-forwarded-for': `1.2.3.${i}` }, socket: { remoteAddress: '10.0.0.1' } });
    assert.equal(ip, '10.0.0.1');
    assert.equal(bot.allowHttpRequest(ip), i < 24);
  }
  for (let i = 0; i < 1200; i++) bot.allowHttpRequest(`unique-${i}`);
  assert.equal(bot.bucketCount(), 1000);
});

test('public health conceals upstream error bodies including configured secrets', async () => {
  const bot = loadBot(async () => new Response('{"header":{"resultCode":"30","resultMsg":"test+kma/key="}}'));
  await bot.runChecks();
  let body;
  bot.handleHttp({ url: '/health', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { setHeader() {}, writeHead() {}, end(text) { body = text; } });
  assert.doesNotMatch(body, /test\+kma|test-token|test-safety/);
  assert.equal(JSON.parse(body).kma, 'error: see server logs or /status');
});
