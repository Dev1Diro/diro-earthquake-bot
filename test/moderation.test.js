import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { createModeration, legacyModerationCommandNames, moderationCommands } from '../moderation.js';
import { configureSecrets } from '../security.js';

const IDS = {
  guild: '111111111111111111', otherGuild: '111111111111111112',
  owner: '222222222222222221', actor: '222222222222222222',
  bot: '333333333333333333', target: '444444444444444444',
};
const ALL = [P.ModerateMembers, P.BanMembers];
const key = `${IDS.guild}:${IDS.target}`;

function member(id, position, flags = ALL, bot = false) {
  const highest = { position, comparePositionTo(other) { return position - other.position; } };
  return { id, user: { id, bot }, roles: { highest }, permissions: { has(flag) { return flags.includes(flag); } }, moderatable: true, bannable: true };
}

function harness(initialState = {}) {
  let state = { warnings: {}, timedBans: {}, alerts: {}, ...structuredClone(initialState) };
  let currentTime = 1_800_000_000_000;
  let failWrite = false;
  const calls = { bans: [], unbans: [], timeouts: [], fetches: [], logs: [], errors: [], writes: 0 };
  const actor = member(IDS.actor, 8);
  const bot = member(IDS.bot, 10, ALL, true);
  const target = member(IDS.target, 2, []);
  target.timeout = async (...args) => { calls.timeouts.push(args); };
  const members = new Map([[actor.id, actor], [bot.id, bot], [target.id, target]]);
  const banned = new Map();
  const guild = {
    id: IDS.guild, ownerId: IDS.owner,
    members: { async fetch(options) {
      calls.fetches.push(options);
      if (!members.has(options.user)) throw Object.assign(new Error('Unknown member'), { code: 10007 });
      return members.get(options.user);
    } },
    bans: {
      async fetch(id) {
        if (!banned.has(id)) throw Object.assign(new Error('Unknown ban'), { code: 10026 });
        return banned.get(id);
      },
      async create(id, options) {
        calls.bans.push([id, options]);
        banned.set(id, { user: { id }, reason: options.reason });
      },
      async remove(id, reason) { calls.unbans.push([id, reason]); banned.delete(id); },
    },
  };
  const store = {
    read() { return structuredClone(state); },
    async update(mutator) {
      calls.writes++;
      if (failWrite) throw new Error('Disk full');
      const draft = structuredClone(state);
      const result = mutator(draft);
      state = draft;
      return result;
    },
  };
  const client = {
    user: { id: IDS.bot }, guilds: { cache: new Map([[guild.id, guild]]) },
    users: { async fetch(id) { return { id, bot: false }; } },
  };
  const dependencies = {
    client, store, now: () => currentTime,
    sendLog: async (payload, logGuild) => { calls.logs.push([payload, logGuild.id]); },
    reportError: async (scope, error) => { calls.errors.push([scope, error]); },
  };
  const moderation = createModeration(dependencies);
  function interaction(commandName, options = {}, selectedGuild = guild) {
    const responses = [];
    return {
      commandName, guild: selectedGuild, user: { id: IDS.actor }, responses,
      member: { permissions: { has() { return true; } } },
      isChatInputCommand: () => true, inGuild: () => Boolean(selectedGuild),
      options: { getString(name) { return options[name] ?? (name === 'user' ? IDS.target : null); }, getInteger(name) { return options[name] ?? 10; } },
      async deferReply(payload) { responses.push(payload); this.deferred = true; },
      async editReply(payload) { responses.push(payload); this.replied = true; },
      async reply(payload) { responses.push(payload); this.replied = true; },
    };
  }
  return {
    ...dependencies, moderation, calls, actor, bot, target, guild, members, banned, interaction,
    snapshot: () => structuredClone(state), advance: ms => { currentTime += ms; },
    failWrites: () => { failWrite = true; },
  };
}

async function run(h, name, options = {}, guild) {
  const interaction = h.interaction(name, options, guild);
  assert.equal(await h.moderation.handleInteraction(interaction), true);
  return interaction;
}

test('English slash command definitions use guild-only defaults and bounded durations', () => {
  assert.deepEqual(moderationCommands.map(c => c.name), ['warn', 'warnings', 'timeban', 'permban', 'mute', 'unmute', 'unban']);
  assert.deepEqual(legacyModerationCommandNames, ['경고', '경고조회', '타임벤', '영구벤', '뮤트', '뮤트해제', '벤해제']);
  for (const command of moderationCommands) {
    assert.equal(command.dm_permission, false);
    assert.ok(command.default_member_permissions);
    assert.equal(command.options[0].name, 'user');
    assert.equal(command.options[0].type, 3);
    assert.ok(command.options.every(option => ['user', 'minutes', 'reason'].includes(option.name)));
  }
  assert.equal(moderationCommands.find(c => c.name === 'mute').options[1].max_value, 40320);
});

test('permissions are refreshed from Discord rather than trusted interaction cache', async () => {
  const h = harness();
  h.actor.permissions.has = () => false;
  const i = await run(h, 'permban');
  assert.match(i.responses.at(-1).content, /권한이 없습니다/);
  assert.equal(h.calls.bans.length, 0);
  assert.ok(h.calls.fetches.some(o => o.user === IDS.actor && o.force === true));
  assert.equal(i.responses[0].flags, MessageFlags.Ephemeral);
});

test('missing bot permissions fail without performing or storing the action', async () => {
  const h = harness();
  h.bot.permissions.has = () => false;
  const i = await run(h, 'warn');
  assert.match(i.responses.at(-1).content, /봇에 필요한/);
  assert.deepEqual(h.snapshot().warnings, {});
});

test('hierarchy, administrators, server owner, self, and bots are protected', async () => {
  for (const targetId of [IDS.actor, IDS.bot, IDS.owner]) {
    const h = harness();
    const i = await run(h, 'permban', { user: targetId });
    assert.equal(h.calls.bans.length, 0);
    assert.match(i.responses.at(-1).content, /지정할 수 없습니다/);
  }
  for (const rule of ['actor', 'bot', 'admin', 'targetBot']) {
    const h = harness();
    if (rule === 'actor') h.actor.roles.highest.comparePositionTo = () => 0;
    if (rule === 'bot') h.bot.roles.highest.comparePositionTo = () => -1;
    if (rule === 'admin') h.target.permissions.has = flag => flag === P.Administrator;
    if (rule === 'targetBot') h.target.user.bot = true;
    const i = await run(h, 'mute');
    assert.equal(h.calls.timeouts.length, 0, rule);
    assert.match(i.responses.at(-1).content, /관리|역할|사용자/);
  }
});

test('malformed IDs, unknown users, direct messages, and unrelated commands fail safely', async () => {
  const h = harness();
  for (const id of ['123', '<@444444444444444444>', '18446744073709551616']) {
    const i = await run(h, 'timeban', { user: id });
    assert.match(i.responses.at(-1).content, /ID/);
  }
  const dm = h.interaction('warn', {}, null);
  await h.moderation.handleInteraction(dm);
  assert.match(dm.responses.at(-1).content, /서버 안/);
  assert.equal(dm.responses[0].flags, MessageFlags.Ephemeral);
  const unknown = h.interaction('unknown');
  assert.equal(await h.moderation.handleInteraction(unknown), false);
  assert.deepEqual(unknown.responses, []);
  h.members.delete(IDS.target);
  const missing = await run(h, 'warn');
  assert.match(missing.responses.at(-1).content, /서버에 없습니다/);
  h.client.users.fetch = async () => { throw new Error('Unknown User'); };
  await run(h, 'permban');
  assert.equal(h.calls.bans.length, 0);
});

test('warning records and warning lookup are scoped to the guild', async () => {
  const h = harness();
  await run(h, 'warn', { reason: '@everyone 테스트' });
  const otherGuild = { ...h.guild, id: IDS.otherGuild };
  const lookup = await run(h, 'warnings', {}, otherGuild);
  assert.match(lookup.responses.at(-1).content, /경고: 0회/);
  const first = await run(h, 'warnings');
  assert.match(first.responses.at(-1).content, /경고: 1회/);
  assert.equal(h.snapshot().warnings[key][0].actorId, IDS.actor);
  assert.deepEqual(h.calls.logs[0][0].allowedMentions, { parse: [] });
  assert.deepEqual(first.responses.at(-1).allowedMentions, { parse: [] });
});

test('timeouts validate Discord bounds at runtime and unmute clears the timeout', async () => {
  for (const duration of [0, -1, 1.5, 40321, NaN]) {
    const h = harness();
    const i = await run(h, 'mute', { minutes: duration });
    assert.match(i.responses.at(-1).content, /28일/);
    assert.equal(h.calls.timeouts.length, 0);
  }
  const h = harness();
  await run(h, 'mute', { minutes: 40320 });
  await run(h, 'unmute');
  assert.equal(h.calls.timeouts[0][0], 28 * 24 * 60 * 60 * 1000);
  assert.equal(h.calls.timeouts[1][0], null);
});

test('failed persistence prevents warnings, bans, and timeouts', async () => {
  for (const command of ['warn', 'mute', 'unmute', 'permban', 'timeban', 'unban']) {
    const h = harness();
    if (command === 'unban') h.banned.set(IDS.target, { reason: 'Permanent ban' });
    h.failWrites();
    const i = await run(h, command);
    assert.match(i.responses.at(-1).content, /완료하지 못했습니다/);
    assert.equal(h.calls.bans.length + h.calls.unbans.length + h.calls.timeouts.length, 0, command);
    assert.deepEqual(h.snapshot().warnings, {});
  }
});

test('timeban schedule is durable before ban and survives a restart', async () => {
  const h = harness();
  const originalBan = h.guild.bans.create;
  h.guild.bans.create = async (id, options) => {
    const schedule = h.snapshot().timedBans[key];
    assert.equal(schedule.status, 'pending');
    assert.ok(options.reason.startsWith(`${schedule.marker} `));
    await originalBan(id, options);
  };
  const i = await run(h, 'timeban', { minutes: 2, reason: '도배' });
  assert.match(i.responses.at(-1).content, /예약을 저장/);
  assert.equal(h.snapshot().timedBans[key].status, 'active');
  const restarted = createModeration(h);
  await restarted.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 0);
  h.advance(120000);
  await restarted.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 1);
  assert.deepEqual(h.snapshot().timedBans, {});
});

test('pending timeban after a lost response is recovered only by its unique ban marker', async () => {
  const h = harness();
  const originalBan = h.guild.bans.create;
  h.guild.bans.create = async (...args) => { await originalBan(...args); throw new Error('Response lost'); };
  const i = await run(h, 'timeban', { minutes: 1 });
  assert.match(i.responses.at(-1).content, /성공 여부를 확인하지 못했습니다/);
  assert.equal(h.snapshot().timedBans[key].status, 'pending');
  h.advance(60000);
  await createModeration(h).sweepTimedBans();
  assert.equal(h.calls.unbans.length, 1);
});

test('failure to confirm an active schedule does not lose a successfully created timed ban', async () => {
  const h = harness();
  const originalUpdate = h.store.update;
  let updates = 0;
  h.store.update = async mutator => {
    if (++updates === 2) throw new Error('Disk temporarily unavailable');
    return originalUpdate(mutator);
  };
  const i = await run(h, 'timeban', { minutes: 1 });
  assert.match(i.responses.at(-1).content, /예약을 저장/);
  assert.equal(h.snapshot().timedBans[key].status, 'pending');
  h.advance(60000);
  await h.moderation.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 1);
});

test('existing bans cannot be replaced and later permanent bans cannot be auto-unbanned', async () => {
  for (const command of ['timeban', 'permban']) {
    const h = harness();
    h.banned.set(IDS.target, { reason: 'Unrelated permanent ban' });
    const i = await run(h, command);
    assert.match(i.responses.at(-1).content, /이미 차단/);
    assert.equal(h.calls.bans.length, 0);
  }
  const h = harness();
  await run(h, 'timeban', { minutes: 1 });
  h.banned.set(IDS.target, { reason: 'Replaced manually with a permanent ban' });
  h.advance(60000);
  await h.moderation.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 0);
  assert.equal(h.banned.has(IDS.target), true);
  assert.deepEqual(h.snapshot().timedBans, {});
});

test('scheduled unbans require bot permissions and writable current schedules', async () => {
  const h = harness();
  await run(h, 'timeban', { minutes: 1 });
  h.advance(60000);
  h.bot.permissions.has = () => false;
  await h.moderation.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 0);
  assert.ok(h.snapshot().timedBans[key]);
  h.bot.permissions.has = () => true;
  h.failWrites();
  await h.moderation.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 0);
});

test('manual unban clears its timed schedule and permanent ban does not schedule an unban', async () => {
  const h = harness();
  await run(h, 'timeban');
  await run(h, 'unban');
  assert.deepEqual(h.snapshot().timedBans, {});
  await run(h, 'permban');
  assert.deepEqual(h.snapshot().timedBans, {});
  assert.equal(h.calls.bans.length, 2);
  h.advance(366 * 24 * 60 * 60 * 1000);
  await h.moderation.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 1);
});

test('logging failures do not misreport successfully applied actions', async () => {
  const h = harness();
  h.sendLog = async () => { throw new Error('Log channel unavailable'); };
  h.moderation = createModeration(h);
  const i = await run(h, 'warn');
  assert.match(i.responses.at(-1).content, /경고를 기록했습니다/);
  assert.equal(h.snapshot().warnings[key].length, 1);
  assert.equal(h.calls.errors[0][0], 'moderation-log');
});

test('secret reasons are redacted before persistence, audit submission, logs, and replies', async () => {
  configureSecrets(['test-secret-value']);
  try {
    const h = harness();
    const reason = '@everyone **대상** test-secret-value';
    await run(h, 'warn', { reason: reason });
    assert.ok(!h.snapshot().warnings[key][0].reason.includes('test-secret-value'));
    assert.match(h.snapshot().warnings[key][0].reason, /비밀값 숨김/);
    const log = h.calls.logs[0][0].embeds[0].fields.find(field => field.name === '사유').value;
    assert.ok(!log.includes('test-secret-value'));
    assert.ok(log.includes('@\u200beveryone'));
    assert.ok(log.includes('\\*\\*대상\\*\\*'));
    const lookup = await run(h, 'warnings');
    assert.ok(!lookup.responses.at(-1).content.includes('test-secret-value'));
    assert.ok(lookup.responses.at(-1).content.includes('@\u200beveryone'));
    await run(h, 'timeban', { reason: reason });
    assert.ok(!h.calls.bans[0][1].reason.includes('test-secret-value'));
    assert.ok(!h.snapshot().timedBans[key].reason.includes('test-secret-value'));
  } finally { configureSecrets([]); }
});

test('configured guild restriction rejects other servers before member fetch or action', async () => {
  const h = harness();
  h.moderation = createModeration({ ...h, guildId: IDS.guild });
  const otherGuild = { ...h.guild, id: IDS.otherGuild };
  const i = await run(h, 'permban', {}, otherGuild);
  assert.match(i.responses.at(-1).content, /이 서버에서는/);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.calls.bans.length, 0);
  assert.equal(h.calls.writes, 0);
});

test('scheduled recovery touches only the configured guild and preserves other schedules', async () => {
  const h = harness();
  await run(h, 'timeban', { minutes: 1 });
  const otherKey = `${IDS.otherGuild}:${IDS.target}`;
  await h.store.update(data => {
    data.timedBans[otherKey] = { ...data.timedBans[key], guildId: IDS.otherGuild };
  });
  let otherGuildLookups = 0;
  h.client.guilds.fetch = async () => { otherGuildLookups++; throw new Error('Unexpected guild access'); };
  h.advance(60000);
  const restricted = createModeration({ ...h, guildId: IDS.guild });
  await restricted.sweepTimedBans();
  assert.equal(h.calls.unbans.length, 1);
  assert.equal(otherGuildLookups, 0);
  assert.equal(h.snapshot().timedBans[key], undefined);
  assert.ok(h.snapshot().timedBans[otherKey]);
});
