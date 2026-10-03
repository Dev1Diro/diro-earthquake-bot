import { randomUUID } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { embedText, redact } from './security.js';

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const MAX_BAN_MINUTES = 365 * 24 * 60;
const MAX_WARNINGS = 1000;
const USER_OPTION = { type: 3, name: 'user', description: '대상 사용자의 Discord ID', required: true, min_length: 17, max_length: 20 };
const REASON_OPTION = { type: 3, name: 'reason', description: '처리 사유', max_length: 400 };
const MODERATE = PermissionFlagsBits.ModerateMembers;
const BAN = PermissionFlagsBits.BanMembers;

function command(name, description, permission, options) {
  return { name, description, dm_permission: false, default_member_permissions: permission.toString(), options };
}

export const legacyModerationCommandNames = ['경고', '경고조회', '타임벤', '영구벤', '뮤트', '뮤트해제', '벤해제'];

export const moderationCommands = [
  command('warn', '사용자에게 경고를 기록합니다.', MODERATE, [USER_OPTION, REASON_OPTION]),
  command('warnings', '이 서버에서 기록된 사용자의 경고를 확인합니다.', MODERATE, [USER_OPTION]),
  command('timeban', '지정한 시간이 지나면 자동으로 해제되는 차단입니다.', BAN, [USER_OPTION,
    { type: 4, name: 'minutes', description: '차단 기간 (분, 최대 365일)', required: true, min_value: 1, max_value: MAX_BAN_MINUTES }, REASON_OPTION]),
  command('permban', '사용자를 서버에서 영구 차단합니다.', BAN, [USER_OPTION, REASON_OPTION]),
  command('mute', 'Discord 타임아웃으로 사용자의 채팅을 제한합니다.', MODERATE, [USER_OPTION,
    { type: 4, name: 'minutes', description: '뮤트 기간 (분, 최대 28일)', required: true, min_value: 1, max_value: MAX_TIMEOUT_MINUTES }, REASON_OPTION]),
  command('unmute', '사용자의 타임아웃을 해제합니다.', MODERATE, [USER_OPTION, REASON_OPTION]),
  command('unban', '사용자의 서버 차단을 해제합니다.', BAN, [USER_OPTION, REASON_OPTION]),
];

const COMMANDS = new Set(moderationCommands.map(({ name }) => name));
const MUTE_COMMANDS = new Set(['warn', 'warnings', 'mute', 'unmute']);
const safeMentions = { parse: [] };

class UserError extends Error {}

function isUnknown(error, code) { return Number(error?.code) === code; }
function isValidId(id) { return typeof id === 'string' && /^\d{17,20}$/.test(id) && BigInt(id) <= 18446744073709551615n; }
function keyFor(guildId, userId) { return `${guildId}:${userId}`; }
function permission(member, required) { return Boolean(member?.permissions?.has(required)); }
function above(a, b) { return a?.roles?.highest?.comparePositionTo(b?.roles?.highest) > 0; }
export function createModeration({ client, store, sendLog, reportError = () => {}, now = Date.now, guildId }) {
  let sweeping = false;
  const processing = new Set();

  async function report(scope, error) {
    try { await reportError(scope, error); } catch { /* Reporting must not alter the moderation result. */ }
  }

  async function log(guild, title, actorId, userId, reason, extra = '') {
    try {
      await sendLog({ embeds: [{ title, color: 0xe09d26, fields: [
        { name: '대상 ID', value: userId, inline: true },
        { name: '처리자 ID', value: actorId, inline: true },
        { name: '사유', value: embedText(reason) },
        ...(extra ? [{ name: '처리 내용', value: embedText(extra) }] : []),
      ], timestamp: new Date(now()).toISOString() }], allowedMentions: safeMentions }, guild);
    } catch (error) { await report('moderation-log', error); }
  }

  async function fetchMember(guild, id, optional = false) {
    try { return await guild.members.fetch({ user: id, force: true }); }
    catch (error) {
      if (optional && isUnknown(error, 10007)) return null;
      if (isUnknown(error, 10007)) throw new UserError('대상 사용자가 이 서버에 없습니다.');
      throw error;
    }
  }

  async function fetchBan(guild, id) {
    try { return await guild.bans.fetch(id); }
    catch (error) { if (isUnknown(error, 10026)) return null; throw error; }
  }

  async function deleteSchedule(key, marker) {
    await store.update(data => { if (data.timedBans[key]?.marker === marker) delete data.timedBans[key]; });
  }

  async function reply(interaction, content) {
    content = redact(content);
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: safeMentions });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: safeMentions });
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.() || !COMMANDS.has(interaction.commandName)) return false;
    let operationKey;
    let ownsLock = false;
    try {
      if (!interaction.guild || !interaction.inGuild?.()) throw new UserError('이 명령어는 서버 안에서만 사용할 수 있습니다.');
      if (guildId && interaction.guild.id !== guildId) throw new UserError('이 서버에서는 봇 관리 명령어를 사용할 수 없습니다.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const name = interaction.commandName;
      const userId = interaction.options.getString('user', true)?.trim();
      if (!isValidId(userId)) throw new UserError('올바른 Discord 사용자 ID를 입력해 주세요.');
      if (!isValidId(interaction.user?.id) || !client.user?.id) throw new UserError('사용자 또는 봇 정보를 확인할 수 없습니다.');
      operationKey = keyFor(guild.id, userId);
      if (processing.has(operationKey)) throw new UserError('이 사용자에 대한 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
      processing.add(operationKey);
      ownsLock = true;
      const required = MUTE_COMMANDS.has(name) ? MODERATE : BAN;
      const [actor, me, member] = await Promise.all([
        fetchMember(guild, interaction.user.id), fetchMember(guild, client.user.id),
        fetchMember(guild, userId, !MUTE_COMMANDS.has(name)),
      ]);
      if (!permission(actor, required)) throw new UserError('이 명령어를 실행할 권한이 없습니다.');
      if (!permission(me, required)) throw new UserError('봇에 필요한 관리 권한이 없습니다. 서버의 봇 역할 권한을 확인해 주세요.');
      if (userId === interaction.user.id || userId === client.user.id || userId === guild.ownerId) {
        throw new UserError('본인, 봇 또는 서버 소유자는 대상으로 지정할 수 없습니다.');
      }
      const user = member?.user ?? await client.users.fetch(userId, { force: true });
      if (user?.id !== userId || user.bot) throw new UserError('유효한 일반 사용자를 대상으로 지정해 주세요.');
      if (member) {
        if (permission(member, PermissionFlagsBits.Administrator)) throw new UserError('관리자에게는 이 명령어를 적용할 수 없습니다.');
        if (actor.id !== guild.ownerId && !above(actor, member)) throw new UserError('본인보다 같거나 높은 역할을 가진 사용자를 관리할 수 없습니다.');
        if (!above(me, member)) throw new UserError('봇 역할을 대상 사용자의 역할보다 위로 이동해 주세요.');
      }
      const rawReason = interaction.options.getString('reason') || '사유 없음';
      if (rawReason.length > 400) throw new UserError('사유는 400자 이내로 입력해 주세요.');
      // Only sanitized reasons may reach persistent records, Discord audit reasons,
      // command replies, or moderation logs.
      const reason = redact(rawReason).slice(0, 400);
      const auditReason = `${reason} (처리자: ${actor.id})`;

      if (name === 'warn') {
        const result = await store.update(data => {
          const warnings = data.warnings[operationKey] ??= [];
          if (!Array.isArray(warnings) || warnings.length >= MAX_WARNINGS) throw new UserError('경고 저장 한도에 도달했습니다. 관리자에게 기록 정리를 요청해 주세요.');
          warnings.push({ id: randomUUID(), guildId: guild.id, userId, actorId: actor.id, reason, createdAt: now() });
          return warnings.length;
        });
        await log(guild, '사용자 경고', actor.id, userId, reason, `이 서버의 누적 경고: ${result}회`);
        await reply(interaction, `${userId} 사용자에게 경고를 기록했습니다. 누적 ${result}회입니다.`);
      } else if (name === 'warnings') {
        const warnings = store.read().warnings[operationKey] || [];
        const recent = warnings.slice(-5).map((warning, i) => `${warnings.length - Math.min(5, warnings.length) + i + 1}. ${embedText(warning.reason, 220)} (처리자 ${embedText(warning.actorId, 30)})`).join('\n');
        await reply(interaction, `${userId} 사용자 경고: ${warnings.length}회${recent ? `\n최근 경고:\n${recent}` : ''}`);
      } else if (name === 'mute' || name === 'unmute') {
        const minutes = name === 'mute' ? interaction.options.getInteger('minutes', true) : null;
        if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES)) throw new UserError('뮤트 시간은 1분부터 28일(40,320분)까지 지정할 수 있습니다.');
        if (member.moderatable === false) throw new UserError('봇이 이 사용자의 타임아웃을 관리할 수 없습니다.');
        // Verify storage is usable before applying a moderation action.
        await store.update(() => {});
        await member.timeout(minutes === null ? null : minutes * 60_000, auditReason);
        await log(guild, name === 'mute' ? '사용자 뮤트' : '사용자 뮤트 해제', actor.id, userId, reason, minutes === null ? '타임아웃 해제' : `${minutes}분`);
        await reply(interaction, `${userId} 사용자의 ${minutes === null ? '뮤트를 해제했습니다.' : `뮤트를 ${minutes}분 적용했습니다.`}`);
      } else if (name === 'unban') {
        const ban = await fetchBan(guild, userId);
        if (!ban) throw new UserError('이 사용자는 현재 차단되어 있지 않습니다.');
        await store.update(() => {});
        await guild.bans.remove(userId, auditReason);
        let cleared = true;
        try { await store.update(data => { delete data.timedBans[operationKey]; }); }
        catch (error) { cleared = false; await report('unban-schedule-cleanup', error); }
        await log(guild, '사용자 벤 해제', actor.id, userId, reason);
        await reply(interaction, `${userId} 사용자의 차단을 해제했습니다.${cleared ? '' : ' 예약 기록 정리는 다음 점검에서 다시 시도합니다.'}`);
      } else {
        if (member?.bannable === false) throw new UserError('봇이 이 사용자를 차단할 수 없습니다.');
        if (await fetchBan(guild, userId)) throw new UserError('이미 차단된 사용자입니다. 기존 차단을 먼저 해제해 주세요.');
        if (name === 'permban') {
          await store.update(data => { delete data.timedBans[operationKey]; });
          await guild.bans.create(userId, { reason: auditReason });
          await log(guild, '사용자 영구 벤', actor.id, userId, reason);
          await reply(interaction, `${userId} 사용자를 영구 차단했습니다.`);
        } else {
          const minutes = interaction.options.getInteger('minutes', true);
          if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_BAN_MINUTES) throw new UserError('타임벤 시간은 1분부터 365일(525,600분)까지 지정할 수 있습니다.');
          const marker = `[diro-timeban:${randomUUID()}]`;
          const entry = { guildId: guild.id, userId, actorId: actor.id, reason, marker, expiresAt: now() + minutes * 60_000, createdAt: now(), status: 'pending' };
          await store.update(data => { data.timedBans[operationKey] = entry; });
          try { await guild.bans.create(userId, { reason: `${marker} ${auditReason}` }); }
          catch (error) {
            // The request may have reached Discord even if its response was lost. Keep
            // the durable schedule; its exact marker decides whether recovery may unban.
            await report('timeban-discord', error);
            throw new UserError('차단 요청의 성공 여부를 확인하지 못했습니다. 예약은 보존했으며, Discord 차단 목록을 확인해 주세요.');
          }
          try {
            await store.update(data => { if (data.timedBans[operationKey]?.marker === marker) data.timedBans[operationKey].status = 'active'; });
          } catch (error) { await report('timeban-confirm-persistence', error); }
          await log(guild, '사용자 타임벤', actor.id, userId, reason, `${minutes}분, 만료 후 봇이 온라인일 때 자동 해제`);
          await reply(interaction, `${userId} 사용자를 ${minutes}분 차단했습니다. 해제 예약을 저장했으며, 만료 후 봇이 온라인일 때 자동 해제합니다.`);
        }
      }
    } catch (error) {
      if (!(error instanceof UserError)) await report('moderation-command', error);
      try { await reply(interaction, error instanceof UserError ? error.message : '처리를 완료하지 못했습니다. 봇의 권한과 저장소 상태를 확인한 뒤 다시 시도해 주세요.'); }
      catch (replyError) { await report('moderation-reply', replyError); }
    } finally { if (ownsLock) processing.delete(operationKey); }
    return true;
  }

  async function sweepTimedBans() {
    if (sweeping) return;
    sweeping = true;
    try {
      const schedules = Object.entries(store.read().timedBans || {});
      for (const [key, entry] of schedules) {
        if (guildId && entry?.guildId !== guildId) continue;
        if (!entry || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt > now() || processing.has(key)) continue;
        if (key !== keyFor(entry.guildId, entry.userId) || !isValidId(entry.guildId) || !isValidId(entry.userId) || !/^\[diro-timeban:[0-9a-f-]{36}\]$/.test(entry.marker)) {
          await report('timeban-invalid-schedule', new Error('Invalid timeban schedule; no Discord action taken'));
          continue;
        }
        processing.add(key);
        try {
          const guild = client.guilds.cache.get(entry.guildId) ?? await client.guilds.fetch(entry.guildId);
          const me = await fetchMember(guild, client.user.id);
          if (!permission(me, BAN)) throw new Error('Missing BanMembers permission for scheduled unban');
          const ban = await fetchBan(guild, entry.userId);
          if (!ban || !ban.reason?.startsWith(`${entry.marker} `)) {
            await deleteSchedule(key, entry.marker);
            continue;
          }
          // Prove the schedule is still current and writable before touching Discord.
          const current = await store.update(data => data.timedBans[key]?.marker === entry.marker);
          if (!current) continue;
          await guild.bans.remove(entry.userId, `타임벤 기간 만료 ${entry.marker}`);
          await deleteSchedule(key, entry.marker);
          await log(guild, '타임벤 자동 해제', client.user.id, entry.userId, entry.reason || '기간 만료');
        } catch (error) { await report('timeban-recovery', error); }
        finally { processing.delete(key); }
      }
    } catch (error) { await report('timeban-sweep', error); }
    finally { sweeping = false; }
  }

  return { handleInteraction, sweepTimedBans };
}
