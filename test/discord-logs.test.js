import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Client, ChannelType, GatewayIntentBits, Options, Partials } from 'discord.js';
import { createDiscordLogs, MESSAGE_CACHE_MAX_SIZE, MESSAGE_CACHE_TTL_MS } from '../discord-logs.js';
import { configureSecrets } from '../security.js';

const guildId = '123456789012345678';
const channelId = '234567890123456789';
const logChannelId = '345678901234567890';
const authorId = '456789012345678901';
const botId = '567890123456789012';

function message(overrides = {}) {
  return { id: '678901234567890123', guildId, channelId, content: '수정 전 원문',
    partial: false, author: { id: authorId, username: '사용자', bot: false },
    attachments: new Map(), ...overrides };
}
function setup(t, extra = {}) {
  const sent = [];
  const errors = [];
  const logs = createDiscordLogs({ client: { user: { id: botId } }, guildId, logChannelId,
    sendLog: async payload => sent.push(payload), reportError: async (...args) => errors.push(args), ...extra });
  t.after(() => logs.stop());
  return { logs, sent, errors };
}
function field(payload, name) { return payload.embeds[0].fields.find(item => item.name === name)?.value; }
function rendered(payload) { return JSON.stringify(payload); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function sdk(t) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel], makeCache: Options.cacheWithLimits({ MessageManager: 0 }) });
  const guild = client.guilds._add({ id: guildId, name: '테스트 서버', owner_id: authorId, roles: [], emojis: [], members: [] });
  const channel = client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: '채팅' }, guild);
  t.after(() => client.destroy());
  const packet = fields => ({ id: message().id, channel_id: channelId, guild_id: guildId, ...fields });
  const original = client.actions.MessageCreate.handle(packet({ content: 'SDK 원문',
    author: { id: authorId, username: '사용자', discriminator: '0', bot: false },
    attachments: [{ id: '789012345678901234', filename: 'original.png', size: 20,
      url: 'https://cdn.discordapp.com/attachments/1/2/original.png' }], type: 0 })).message;
  return { client, channel, original, packet };
}

test('observed originals survive partial edit events and the changed text is kept for deletion', async t => {
  const { logs, sent } = setup(t);
  const original = message();
  logs.onMessageCreate(original);
  original.content = '객체가 변경되어도 캐시 원문은 유지';
  await logs.onMessageUpdate(message({ partial: true, content: null }), message({ content: '수정된 내용' }));
  assert.equal(field(sent[0], '변경 전 원문'), '수정 전 원문');
  assert.equal(field(sent[0], '변경 후'), '수정된 내용');
  await logs.onMessageDelete(message({ partial: true, content: null, author: null }));
  assert.equal(field(sent[1], '삭제된 원문'), '수정된 내용');
  assert.match(field(sent[1], '작성자'), new RegExp(authorId));
  assert.equal(sent[1].embeds[0].title, '메시지 삭제');
});

test('uncached deletion explicitly says unavailable without fetching deleted messages or guessing actors', async t => {
  const { logs, sent } = setup(t, { client: { user: { id: botId }, fetchAuditLogs() { throw new Error('must not infer actor'); } } });
  let fetches = 0;
  await logs.onMessageDelete(message({ partial: true, content: null, fetch() { fetches++; throw new Error('gone'); } }));
  assert.equal(fetches, 0);
  assert.match(field(sent[0], '삭제된 원문'), /원문 확인 불가/);
  assert.match(sent[0].embeds[0].description, /추정하지 않습니다/);
  assert.equal(sent[0].embeds[0].fields.some(item => item.name === '삭제 실행자'), false);
});

test('only new partial messages may be fetched; fetched current contents are never labeled as an original', async t => {
  const { logs, sent } = setup(t);
  let oldFetches = 0;
  let currentFetches = 0;
  const old = message({ partial: true, content: null, fetch() { oldFetches++; return message({ content: '잘못된 원문' }); } });
  const edited = message({ partial: true, content: null,
    async fetch() { currentFetches++; return message({ content: '조회된 최신 메시지' }); } });
  await logs.onMessageUpdate(old, edited);
  assert.equal(oldFetches, 0);
  assert.equal(currentFetches, 1);
  assert.match(field(sent[0], '변경 전 원문'), /원문 확인 불가/);
  assert.equal(field(sent[0], '변경 후 (현재 조회)'), '조회된 최신 메시지');
});

test('failed partial fetch keeps unavailable states and does not fail the gateway callback', async t => {
  const { logs, sent } = setup(t);
  await logs.onMessageUpdate(message({ partial: true, content: null }),
    message({ partial: true, content: null, async fetch() { throw new Error('Unknown Message'); } }));
  assert.match(field(sent[0], '변경 전 원문'), /원문 확인 불가/);
  assert.match(field(sent[0], '변경 후'), /확인 불가/);
});

test('actual SDK updates with MessageManager 0 retain event content despite missing author and preserve omitted attachments', async t => {
  const { client, channel, original, packet } = sdk(t);
  const { logs, sent } = setup(t, { client });
  logs.onMessageCreate(original);
  const first = packet({ content: 'Gateway가 보낸 정확한 수정문', edited_timestamp: '2026-10-03T03:00:00Z' });
  logs.onRaw({ t: 'MESSAGE_UPDATE', d: first });
  const update = client.actions.MessageUpdate.handle(first);
  assert.equal(channel.messages.cache.size, 0);
  assert.equal(update.old.partial, true);
  assert.equal(update.updated.partial, true);
  assert.equal(update.updated.author, null);
  update.updated.fetch = () => { throw new Error('Must use gateway content, not REST'); };
  await logs.onMessageUpdate(update.old, update.updated);
  assert.equal(field(sent[0], '변경 전 원문'), 'SDK 원문');
  assert.equal(field(sent[0], '변경 후'), 'Gateway가 보낸 정확한 수정문');
  assert.match(field(sent[0], '변경 후 첨부파일'), /original\.png/);
  assert.match(field(sent[0], '작성자'), new RegExp(authorId));

  const removal = packet({ content: '첨부파일 삭제', attachments: [], edited_timestamp: '2026-10-03T03:01:00Z' });
  logs.onRaw({ t: 'MESSAGE_UPDATE', d: removal });
  const removed = client.actions.MessageUpdate.handle(removal);
  await logs.onMessageUpdate(removed.old, removed.updated);
  assert.match(field(sent[1], '변경 전 첨부파일'), /original\.png/);
  assert.equal(field(sent[1], '변경 후 첨부파일'), undefined);
  await logs.onMessageDelete(message({ partial: true, content: null, author: null }));
  assert.equal(field(sent[2], '삭제된 원문'), '첨부파일 삭제');
  assert.equal(field(sent[2], '첨부파일'), undefined);
});

test('raw metadata follows FIFO updates for the same message when update handlers run on later microtasks', async t => {
  const { client, original, packet } = sdk(t);
  const { logs, sent } = setup(t, { client });
  logs.onMessageCreate(original);
  const one = packet({ content: '첫 번째 수정', attachments: [], edited_timestamp: '2026-10-03T03:00:00Z' });
  logs.onRaw({ t: 'MESSAGE_UPDATE', d: one });
  const first = client.actions.MessageUpdate.handle(one);
  const two = packet({ content: '두 번째 수정', attachments: [{ id: '789012345678901235', filename: 'second.png',
    url: 'https://cdn.discordapp.com/attachments/1/2/second.png', size: 1 }], edited_timestamp: '2026-10-03T03:01:00Z' });
  logs.onRaw({ t: 'MESSAGE_UPDATE', d: two });
  const second = client.actions.MessageUpdate.handle(two);
  await Promise.all([
    Promise.resolve().then(() => logs.onMessageUpdate(first.old, first.updated)),
    Promise.resolve().then(() => logs.onMessageUpdate(second.old, second.updated)),
  ]);
  assert.equal(field(sent[0], '변경 전 원문'), 'SDK 원문');
  assert.equal(field(sent[0], '변경 후'), '첫 번째 수정');
  assert.equal(field(sent[0], '변경 후 첨부파일'), undefined);
  assert.equal(field(sent[1], '변경 전 원문'), '첫 번째 수정');
  assert.equal(field(sent[1], '변경 후'), '두 번째 수정');
  assert.match(field(sent[1], '변경 후 첨부파일'), /second\.png/);
});

test('partial content strings are used directly with cached author metadata even without raw packets', async t => {
  const { logs, sent } = setup(t);
  logs.onMessageCreate(message());
  await logs.onMessageUpdate(message({ partial: true, content: null, author: null }),
    message({ partial: true, content: '관측된 실제 수정문', author: null, fetch() { throw new Error('Do not replace available content'); } }));
  assert.equal(field(sent[0], '변경 전 원문'), '수정 전 원문');
  assert.equal(field(sent[0], '변경 후'), '관측된 실제 수정문');
  assert.match(field(sent[0], '작성자'), new RegExp(authorId));
});

test('author-only lookups preserve exact event text and filter otherwise unobserved bot messages', async t => {
  const { logs, sent } = setup(t);
  await logs.onMessageUpdate(message({ partial: true, content: null, author: null }), message({ partial: true,
    content: '실제 Gateway 수정문', author: null, async fetch() { return message({ content: 'REST는 이미 다음 수정문을 보고 있음' }); } }));
  assert.equal(field(sent[0], '변경 후'), '실제 Gateway 수정문');
  assert.match(field(sent[0], '변경 전 원문'), /원문 확인 불가/);
  await logs.onMessageDelete(message({ partial: true, content: null, author: null }));
  assert.equal(field(sent[1], '삭제된 원문'), '실제 Gateway 수정문');

  await logs.onMessageUpdate(message({ id: 'unobserved-bot', partial: true, content: null, author: null }),
    message({ id: 'unobserved-bot', partial: true, content: '봇의 수정문', author: null,
      async fetch() { return message({ id: 'unobserved-bot', content: '봇의 현재 수정문', author: { id: botId, bot: true } }); } }));
  await logs.onMessageDelete(message({ id: 'unobserved-bot', partial: true, content: null, author: null }));
  assert.equal(sent.length, 2);
});

test('a delayed fetch cannot overwrite a newer event or emit an outdated edit log', async t => {
  const { logs, sent } = setup(t);
  logs.onMessageCreate(message());
  const pending = deferred();
  const first = logs.onMessageUpdate(message({ partial: true, content: null }),
    message({ partial: true, content: null, fetch: () => pending.promise }));
  await logs.onMessageUpdate(message({ partial: true, content: null }), message({ content: '가장 최신 수정문' }));
  pending.resolve(message({ content: '늦게 도착한 오래된 조회 결과' }));
  await first;
  assert.equal(sent.length, 1);
  assert.equal(field(sent[0], '변경 후'), '가장 최신 수정문');
  await logs.onMessageDelete(message({ partial: true, content: null }));
  assert.equal(field(sent[1], '삭제된 원문'), '가장 최신 수정문');
});

test('single and bulk deletion invalidate pending fetches so deleted snapshots cannot be resurrected', async t => {
  for (const bulk of [false, true]) {
    const { logs, sent } = setup(t);
    logs.onMessageCreate(message());
    const pending = deferred();
    const first = logs.onMessageUpdate(message({ partial: true, content: null }),
      message({ partial: true, content: null, fetch: () => pending.promise }));
    const removed = message({ partial: true, content: null });
    if (bulk) await logs.onMessageDeleteBulk(new Map([[removed.id, removed]]));
    else await logs.onMessageDelete(removed);
    pending.resolve(message({ content: '삭제된 뒤 도착한 조회 결과' }));
    await first;
    assert.equal(sent.length, 1);
    assert.doesNotMatch(rendered(sent[0]), /삭제된 뒤 도착한 조회 결과/);
    await logs.onMessageDelete(removed);
    assert.match(field(sent[1], '삭제된 원문'), /원문 확인 불가/);
  }
});

test('raw embed-only SDK updates do not fetch or log a fabricated edit', async t => {
  const { client, original, packet } = sdk(t);
  const { logs, sent } = setup(t, { client });
  logs.onMessageCreate(original);
  const data = packet({ embeds: [{ title: '자동 링크 미리보기' }] });
  logs.onRaw({ t: 'MESSAGE_UPDATE', d: data });
  const update = client.actions.MessageUpdate.handle(data);
  update.updated.fetch = () => { throw new Error('Do not fetch embed-only updates'); };
  await logs.onMessageUpdate(update.old, update.updated);
  assert.equal(sent.length, 0);
  await logs.onMessageDelete(message({ partial: true, content: null }));
  assert.equal(field(sent[0], '삭제된 원문'), 'SDK 원문');
});

test('unchanged content updates are skipped but attachment changes are recorded', async t => {
  const { logs, sent } = setup(t);
  logs.onMessageCreate(message());
  await logs.onMessageUpdate(message(), message());
  assert.equal(sent.length, 0);
  const attachments = new Map([['attachment', { name: '스크린샷.png', url: 'https://cdn.discordapp.com/attachments/1/2/image.png?hm=signed-token', async fetch() { throw new Error('must not download'); } }]]);
  await logs.onMessageUpdate(message(), message({ attachments }));
  assert.equal(sent.length, 1);
  assert.match(field(sent[0], '변경 후 첨부파일'), /스크린샷\.png/);
  assert.doesNotMatch(rendered(sent[0]), /signed-token/);
});

test('cross-guild messages, DMs, bots, and log-channel messages cannot create logs or cache originals', async t => {
  const { logs, sent } = setup(t);
  for (const ignored of [message({ guildId: 'other-guild' }), message({ guildId: null }),
    message({ channelId: logChannelId }), message({ author: { id: botId, bot: true } })]) {
    logs.onMessageCreate(ignored);
    await logs.onMessageUpdate(ignored, { ...ignored, content: '다른 내용' });
    await logs.onMessageDelete(ignored);
  }
  assert.equal(sent.length, 0);
  await logs.onMessageDelete(message({ author: null, partial: true, content: null }));
  assert.equal(sent.length, 0); // An observed bot remains ignored after its author becomes unavailable.
  await logs.onMessageUpdate(message({ id: 'another-message', guildId: 'other-guild', content: '다른 서버의 비밀 원문' }), message({ id: 'another-message', content: '새 메시지' }));
  assert.doesNotMatch(rendered(sent[0]), /다른 서버의 비밀 원문/);
  assert.match(field(sent[0], '변경 전 원문'), /원문 확인 불가/);
});

test('missing configured guild or log channel disables logging', async t => {
  const { logs, sent } = setup(t, { guildId: '' });
  logs.onMessageCreate(message());
  await logs.onMessageDelete(message());
  await logs.onAuditLogEntryCreate({ id: 'audit', action: AuditLogEvent.MemberBanAdd }, { id: guildId });
  assert.equal(sent.length, 0);
});

test('mentions, markdown, credentials, and long originals stay safe inside Discord payload limits', async t => {
  configureSecrets(['configured-private-token']);
  t.after(() => configureSecrets([]));
  const { logs, sent } = setup(t);
  logs.onMessageCreate(message({ content: '@everyone <@123> **bold** configured-private-token token=unlisted-secret ' + '긴'.repeat(8_000),
    author: { id: authorId, username: '@everyone **운영자**', bot: false } }));
  await logs.onMessageDelete(message({ partial: true, content: null }));
  assert.deepEqual(sent[0].allowedMentions, { parse: [], repliedUser: false });
  assert.doesNotMatch(rendered(sent[0]), /configured-private-token|unlisted-secret|@everyone/);
  assert.match(field(sent[0], '삭제된 원문'), /@\u200beveryone/);
  assert.ok(field(sent[0], '삭제된 원문').length <= 1_024);
  for (const item of sent[0].embeds[0].fields) assert.ok(item.value.length <= 1_024);
  assert.ok(sent[0].embeds[0].fields.reduce((sum, item) => sum + item.name.length + item.value.length, 0) < 6_000);
});

test('snapshot retention expires at the documented TTL and is bounded by message count', async t => {
  let time = 1_000;
  const { logs, sent } = setup(t, { now: () => time });
  logs.onMessageCreate(message());
  time += MESSAGE_CACHE_TTL_MS;
  await logs.onMessageDelete(message({ partial: true, content: null }));
  assert.match(field(sent[0], '삭제된 원문'), /원문 확인 불가/);
  for (let index = 0; index <= MESSAGE_CACHE_MAX_SIZE; index++) {
    logs.onMessageCreate(message({ id: String(index), content: `원문-${index}` }));
  }
  await logs.onMessageDelete(message({ id: '0', partial: true, content: null }));
  await logs.onMessageDelete(message({ id: String(MESSAGE_CACHE_MAX_SIZE), partial: true, content: null }));
  assert.match(field(sent[1], '삭제된 원문'), /원문 확인 불가/);
  assert.equal(field(sent[2], '삭제된 원문'), `원문-${MESSAGE_CACHE_MAX_SIZE}`);
});

test('bulk deletions contain every retained original in bounded batches and release snapshots', async t => {
  const { logs, sent } = setup(t);
  const originals = Array.from({ length: 12 }, (_, index) => message({ id: String(index), content: `일괄 원문 ${index}` }));
  originals.forEach(logs.onMessageCreate);
  await logs.onMessageDeleteBulk(new Map(originals.map(item => [item.id, { ...item, partial: true, content: null }])));
  assert.equal(sent.length, 3);
  for (let index = 0; index < originals.length; index++) {
    assert.ok(sent.some(payload => payload.embeds[0].fields.some(item => item.name === `메시지 ${index}` && item.value.includes(`일괄 원문 ${index}`))));
  }
  for (const payload of sent) {
    assert.ok(payload.embeds[0].fields.length <= 5);
    assert.ok(payload.embeds[0].fields.reduce((sum, item) => sum + item.name.length + item.value.length, 0) < 6_000);
  }
  await logs.onMessageDelete({ ...originals[0], partial: true, content: null });
  assert.match(field(sent[3], '삭제된 원문'), /원문 확인 불가/);
});

test('dedicated audits report actor, action, target, reasons, and bounded changes without log-channel or bot feedback', async t => {
  const { logs, sent } = setup(t);
  const entry = { id: 'audit-id', action: AuditLogEvent.MemberUpdate, executorId: authorId,
    executor: { username: '관리자' }, targetId: 'another-user', target: { username: '대상' },
    reason: '반복 도배', changes: [{ key: 'communication_disabled_until', old: null, new: '2026-10-03T12:00:00Z' },
      { key: 'token', old: 'original-private-token', new: 'new-private-token' }] };
  await logs.onAuditLogEntryCreate(entry, { id: 'other-guild' });
  await logs.onAuditLogEntryCreate({ ...entry, executorId: botId }, { id: guildId });
  await logs.onAuditLogEntryCreate({ ...entry, targetId: logChannelId }, { id: guildId });
  await logs.onAuditLogEntryCreate({ ...entry, extra: { channel: { id: logChannelId } } }, { id: guildId });
  assert.equal(sent.length, 0);
  await logs.onAuditLogEntryCreate(entry, { id: guildId });
  await logs.onAuditLogEntryCreate(entry, { id: guildId });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].title, '서버 감사 로그');
  assert.match(field(sent[0], '실행자'), new RegExp(authorId));
  assert.match(field(sent[0], '작업'), /타임아웃/);
  assert.equal(field(sent[0], '사유'), '반복 도배');
  assert.match(field(sent[0], '변경: communication\_disabled\_until') || rendered(sent[0]), /2026-10-03T12:00:00Z/);
  assert.doesNotMatch(rendered(sent[0]), /original-private-token|new-private-token/);
  await logs.onAuditLogEntryCreate({ ...entry, id: 'ban-audit', action: AuditLogEvent.MemberBanAdd, changes: [] }, { id: guildId });
  assert.match(field(sent[1], '작업'), /멤버 차단/);
  assert.doesNotMatch(field(sent[1], '작업'), /영구/);
});

test('delivery failures are isolated and stopping the logger clears callbacks', async t => {
  let attempts = 0;
  const { logs, errors } = setup(t, { sendLog: async () => { attempts++; throw new Error('Missing Permissions'); } });
  await logs.onMessageDelete(message());
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Discord 로그 전송 실패');
  logs.stop();
  logs.onMessageCreate(message());
  await logs.onMessageDelete(message());
  await logs.onAuditLogEntryCreate({ id: 'audit', action: AuditLogEvent.MemberBanAdd }, { id: guildId });
  assert.equal(attempts, 1);
});
