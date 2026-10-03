import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, PermissionFlagsBits as P, MessageFlags } from 'discord.js';
import { createDiscordRuntime } from '../discord-runtime.js';

const ids = { guild: '111111111111111111', alert: '222222222222222222', log: '333333333333333333', bot: '444444444444444444', actor: '555555555555555555' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const sent = [], registered = [], removed = [], errors = [];
  const client = new EventEmitter();
  let ready = false;
  client.isReady = () => ready;
  client.user = { id: ids.bot, setPresence(presence) { client.presence = presence; } };
  const actor = { id: ids.actor, permissions: { has: flag => flag === P.ModerateMembers } };
  const me = { permissions: { has: flag => options.audit !== false || flag !== P.ViewAuditLog } };
  const guild = { id: ids.guild, members: { async fetchMe() { return me; }, async fetch() { return actor; } } };
  const alert = { guild, guildId: guild.id, isTextBased: () => true, permissionsFor: () => ({ has: () => options.alertPermissions !== false }), async send(payload) { sent.push(['alert', payload]); } };
  const log = { ...alert, guildId: options.foreignLog ? '999999999999999999' : guild.id, async send(payload) { sent.push(['log', payload]); } };
  client.channels = { async fetch(id) { return id === ids.alert ? alert : log; } };
  client.guilds = { cache: new Map([[guild.id, guild]]) };
  client.application = { commands: { async create(command, guildId) {
    if (options.registrationFails) throw new Error('Missing Access');
    registered.push([command, guildId]);
  }, async fetch({ guildId }) {
    assert.equal(guildId, ids.guild);
    return new Map((options.existingCommands || []).map(command => [command.id, command]));
  }, async delete(id, guildId) { removed.push([id, guildId]); } } };
  client.login = async () => {
    if (options.loginFails) throw new Error('Disallowed intents');
    ready = true;
    client.emit(Events.ClientReady, client);
  };
  client.destroy = async () => { ready = false; };
  const runtime = createDiscordRuntime({ env: { DISCORD_TOKEN: 'mock', CHANNEL_ID: ids.alert, LOGS: ids.log, ...options.env }, store: { read: () => ({ timedBans: {}, warnings: {}, alerts: {} }), update: async callback => callback({ timedBans: {}, warnings: {}, alerts: {} }) }, client, reportError: (scope, error) => errors.push([scope, error.message]), getSourceStatus: () => ({ kma: 'disabled', safety: 'disabled', discord: 'idle' }) });
  async function start() {
    await runtime.start();
    for (let i = 0; i < 20 && runtime.health().commands === 'pending'; i++) await tick();
    await tick();
  }
  return { runtime, client, guild, start, sent, registered, removed, errors };
}

test('Gateway readiness registers English commands in the selected server and wires real event callbacks', async t => {
  const h = fixture();
  t.after(() => h.runtime.stop());
  await h.start();
  assert.equal(h.runtime.health().gateway, 'ready');
  assert.equal(h.runtime.health().commands, 'ok');
  assert.equal(h.registered.length, 8);
  assert.deepEqual(h.registered.map(([command]) => command.name), ['warn', 'warnings', 'timeban', 'permban', 'mute', 'unmute', 'unban', 'status']);
  assert.ok(h.registered.every(([, guild]) => guild === ids.guild));
  assert.deepEqual(h.client.presence, { status: 'online' });
  const message = { id: '666666666666666666', guildId: ids.guild, channelId: ids.alert, author: { id: ids.actor, username: 'user', bot: false }, content: '원래 내용', partial: false, attachments: new Map() };
  h.client.emit(Events.MessageCreate, message);
  await tick();
  h.client.emit(Events.MessageDelete, { ...message, partial: true, content: null });
  await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0], 'log');
  assert.match(JSON.stringify(h.sent[0][1]), /원래 내용/);
  assert.deepEqual(h.sent[0][1].allowedMentions.parse, []);
  h.client.emit(Events.ShardDisconnect, {}, 0);
  assert.equal(h.runtime.health().gateway, 'disconnected');
  h.client.emit(Events.ShardReconnecting, 0);
  assert.equal(h.runtime.health().gateway, 'reconnecting');
  h.client.emit(Events.ShardReady, 0);
  assert.equal(h.runtime.health().gateway, 'ready');
});

test('failed login or command registration remains visible without claiming command readiness', async t => {
  for (const options of [{ loginFails: true }, { registrationFails: true }]) {
    const h = fixture(options);
    t.after(() => h.runtime.stop());
    await h.start();
    assert.notEqual(h.runtime.health().commands, 'ok');
    assert.ok(h.errors.length > 0);
    assert.equal(h.removed.length, 0);
    if (options.loginFails) assert.match(h.runtime.health().gateway, /^error/);
  }
});

test('English command registration selectively removes legacy Korean slash commands from the same guild', async t => {
  const h = fixture({ existingCommands: [
    { id: 'legacy-warn', name: '경고', type: 1 },
    { id: 'legacy-status', name: '상태', type: 1 },
    { id: 'english-warn', name: 'warn', type: 1 },
    { id: 'other', name: 'custom-command', type: 1 },
    { id: 'context', name: '경고', type: 2 },
  ] });
  t.after(() => h.runtime.stop());
  await h.start();
  assert.equal(h.runtime.health().commands, 'ok');
  assert.deepEqual(h.removed, [['legacy-warn', ids.guild], ['legacy-status', ids.guild]]);
});

test('channel access and guild mismatches fail closed while a foreign log channel is never sent to', async t => {
  for (const options of [{ alertPermissions: false }, { env: { GUILD_ID: '999999999999999999' } }]) {
    const h = fixture(options);
    t.after(() => h.runtime.stop());
    await h.start();
    assert.match(h.runtime.health().commands, /^error/);
    assert.equal(h.registered.length, 0);
  }
  const h = fixture({ foreignLog: true });
  t.after(() => h.runtime.stop());
  await h.start();
  assert.equal(h.runtime.health().commands, 'ok');
  assert.match(h.runtime.health().logs, /^error/);
  h.client.emit(Events.MessageDelete, { id: '666666666666666666', guildId: ids.guild, channelId: ids.alert, partial: true });
  await tick();
  assert.equal(h.sent.length, 0);
});

test('status command is acknowledged privately and interactions in other servers are rejected', async t => {
  const h = fixture({ audit: false });
  t.after(() => h.runtime.stop());
  await h.start();
  assert.match(h.runtime.health().audit, /ViewAuditLog/);
  const responses = [];
  const interaction = { guildId: ids.guild, guild: h.guild, commandName: 'status', user: { id: ids.actor }, isChatInputCommand: () => true, async deferReply(payload) { responses.push(payload); }, async editReply(payload) { responses.push(payload); }, async reply(payload) { responses.push(payload); } };
  h.client.emit(Events.InteractionCreate, interaction);
  await tick();
  assert.equal(responses[0].flags, MessageFlags.Ephemeral);
  assert.match(responses.at(-1).content, /Gateway: ready/);
  responses.length = 0;
  h.client.emit(Events.InteractionCreate, { ...interaction, guildId: '999999999999999999' });
  await tick();
  assert.match(responses[0].content, /준비가 되지/);
  assert.equal(responses[0].flags, MessageFlags.Ephemeral);
});
