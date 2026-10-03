import { Client, Events, GatewayIntentBits, Partials, Options, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createModeration, moderationCommands, legacyModerationCommandNames } from './moderation.js';
import { createDiscordLogs } from './discord-logs.js';
import { redact } from './security.js';

const channelPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
function requiredPermissions(channel) {
  return channel.isThread?.() ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.EmbedLinks] : channelPermissions;
}

export function createDiscordRuntime({ env, store, reportError = () => {}, getSourceStatus = () => ({}), client }) {
  client ??= new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration],
    partials: [Partials.Message, Partials.Channel],
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
    allowedMentions: { parse: [], repliedUser: false },
  });
  let status = 'connecting';
  let commandStatus = 'pending';
  let logStatus = env.LOGS ? 'pending' : 'disabled: LOGS is missing';
  let guildId;
  let logChannel;
  let timer;
  let started = false;
  let stopped = false;
  let discordLogs;
  let moderation;
  let initializing;
  let auditPermission = false;
  let pendingLogs = 0;
  let droppedLogs = 0;
  const errorTimes = new Map();

  const report = (scope, error) => {
    const message = redact(error?.message || error).slice(0, 500);
    const key = `${scope}:${message}`;
    const previous = errorTimes.get(key);
    if (previous && Date.now() - previous < 60_000) return;
    if (errorTimes.size >= 100) errorTimes.delete(errorTimes.keys().next().value);
    errorTimes.set(key, Date.now());
    reportError(scope, new Error(message));
  };
  const run = (scope, fn) => (...args) => { Promise.resolve().then(() => fn(...args)).catch(error => report(scope, error)); };
  const sendLog = async (payload, guild) => {
    if (!logChannel) return;
    if (guild && guild.id !== guildId) throw new Error('Log guild mismatch');
    if (pendingLogs >= 100) {
      droppedLogs++;
      throw new Error('관리 로그 대기열 한도 초과; 일부 로그 전송 생략');
    }
    pendingLogs++;
    try {
      await logChannel.send({ ...payload, allowedMentions: { parse: [], repliedUser: false } });
      logStatus = 'ok';
    } catch (error) {
      logStatus = 'error: log delivery failed';
      throw error;
    } finally { pendingLogs--; }
  };

  client.on(Events.Error, error => report('Discord client', error));
  client.on(Events.ShardError, error => report('Discord Gateway', error));
  client.on(Events.ShardDisconnect, (_event, _shard) => { status = 'disconnected'; });
  client.on(Events.ShardReconnecting, () => { status = 'reconnecting'; });
  client.on(Events.ShardResume, () => { status = 'ready'; });
  client.on(Events.ShardReady, () => { if (guildId) status = 'ready'; });
  client.on(Events.Raw, packet => { discordLogs?.onRaw?.(packet); });
  client.on(Events.MessageCreate, run('메시지 기록', message => discordLogs?.onMessageCreate(message)));
  client.on(Events.MessageUpdate, run('메시지 수정 로그', (oldMessage, newMessage) => discordLogs?.onMessageUpdate(oldMessage, newMessage)));
  client.on(Events.MessageDelete, run('메시지 삭제 로그', message => discordLogs?.onMessageDelete(message)));
  client.on(Events.MessageBulkDelete, run('메시지 일괄 삭제 로그', messages => discordLogs?.onMessageDeleteBulk(messages)));
  client.on(Events.GuildAuditLogEntryCreate, run('감사 로그', (entry, guild) => discordLogs?.onAuditLogEntryCreate(entry, guild)));
  client.on(Events.InteractionCreate, run('관리 명령어', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!moderation || !client.isReady() || interaction.guildId !== guildId) {
      await interaction.reply({ content: '이 서버에서 명령어를 사용할 준비가 되지 않았습니다. 봇 설정을 확인해 주세요.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    if (interaction.commandName === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.editReply({ content: '멤버 관리 권한이 필요합니다.', allowedMentions: { parse: [] } });
        return;
      }
      const sources = getSourceStatus();
      await interaction.editReply({ content: redact(`Gateway: ${status}\n명령어: ${commandStatus}\n관리 로그: ${logStatus}\n감사 로그 권한: ${auditPermission ? '있음' : '없음'}\n지진: ${sources.kma}\n재난문자: ${sources.safety}\n알림 전송: ${sources.discord}`).slice(0, 1900), allowedMentions: { parse: [] } });
      return;
    }
    if (!await moderation.handleInteraction(interaction)) {
      await interaction.reply({ content: '지원하지 않는 명령어입니다. /warn, /timeban, /permban, /mute 또는 /status를 사용해 주세요.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }));

  async function initialize() {
    status = 'ready';
    try {
      const alertChannel = await client.channels.fetch(env.CHANNEL_ID);
      if (!alertChannel?.guild || !alertChannel.isTextBased() || typeof alertChannel.send !== 'function') throw new Error('CHANNEL_ID must be a server text channel');
      guildId = alertChannel.guildId;
      if (env.GUILD_ID && env.GUILD_ID !== guildId) throw new Error('GUILD_ID and CHANNEL_ID belong to different servers');
      const me = await alertChannel.guild.members.fetchMe({ force: true });
      auditPermission = me.permissions.has(PermissionFlagsBits.ViewAuditLog);
      if (!alertChannel.permissionsFor(me)?.has(requiredPermissions(alertChannel))) throw new Error('Alert channel requires ViewChannel, SendMessages (SendMessagesInThreads for threads) and EmbedLinks');
      if (env.LOGS) {
        try {
          logChannel = await client.channels.fetch(env.LOGS);
          if (!logChannel || logChannel.guildId !== guildId || !logChannel.isTextBased() || typeof logChannel.send !== 'function') throw new Error('LOGS must be a text channel in the alert server');
          if (!logChannel.permissionsFor(me)?.has(requiredPermissions(logChannel))) throw new Error('Log channel requires ViewChannel, SendMessages (SendMessagesInThreads for threads) and EmbedLinks');
          logStatus = 'ok';
        } catch (error) {
          logChannel = null;
          logStatus = 'error: log channel configuration';
          report('로그 채널 설정', error);
        }
      }
      discordLogs = createDiscordLogs({ client, guildId, logChannelId: env.LOGS, sendLog, reportError: report });
      moderation = createModeration({ client, guildId, store, sendLog, reportError: report });
      const commands = [...moderationCommands, { name: 'status', description: 'Discord 연결과 지진·재난문자 상태를 확인합니다.', default_member_permissions: String(PermissionFlagsBits.ModerateMembers) }];
      // Upsert only our commands; preserve unrelated commands already installed for this application.
      try {
        for (const command of commands) await client.application.commands.create(command, guildId);
        const legacyNames = new Set([...legacyModerationCommandNames, '상태']);
        const existing = await client.application.commands.fetch({ guildId });
        for (const command of existing.values()) {
          if (command.type === 1 && legacyNames.has(command.name)) await client.application.commands.delete(command.id, guildId);
        }
        commandStatus = 'ok';
      } catch (error) {
        commandStatus = 'error: command registration failed';
        report('명령어 등록 (applications.commands 초대 범위 확인)', error);
      }
      await moderation.sweepTimedBans();
      timer = setInterval(() => { if (client.isReady()) void moderation.sweepTimedBans().catch(error => report('타임벤 만료 처리', error)); }, 30_000);
      timer.unref?.();
      client.user.setPresence({ status: 'online' });
    } catch (error) {
      commandStatus = 'error: server configuration';
      report('Discord 서버 설정', error);
    }
  }

  return {
    client,
    health: () => ({ gateway: client.isReady() ? status : (status === 'ready' ? 'disconnected' : status), commands: commandStatus, logs: logStatus, audit: logChannel ? (auditPermission ? 'enabled' : 'disabled: ViewAuditLog permission missing') : 'disabled: log channel unavailable', pendingLogs, droppedLogs }),
    async start() {
      if (started) throw new Error('Discord runtime already started');
      started = true;
      client.once(Events.ClientReady, () => {
        if (stopped) return;
        initializing = initialize();
        void initializing.catch(error => report('Discord 초기화', error));
      });
      try { await client.login(env.DISCORD_TOKEN); if (initializing) await initializing; }
      catch (error) {
        status = 'error: Gateway login failed (check token and Message Content Intent)';
        report('Discord 로그인', error);
      }
    },
    async stop() {
      stopped = true;
      await initializing?.catch(() => {});
      clearInterval(timer);
      discordLogs?.stop?.();
      moderation?.stop?.();
      await client.destroy();
      status = 'stopped';
    },
  };
}
