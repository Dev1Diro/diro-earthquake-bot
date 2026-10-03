import { AuditLogEvent } from 'discord.js';
import { embedText, redact } from './security.js';

// Privacy boundary: originals stay only in memory, for at most six hours and
// 5,000 observed messages. Restarting the bot loses this cache. No message
// history is fetched, no attachment is downloaded, and no content is persisted.
export const MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MESSAGE_CACHE_MAX_SIZE = 5_000;
const UNKNOWN_ORIGINAL = '원문 확인 불가: 봇이 보관하지 않은 메시지입니다. 재시작 전 또는 오프라인 중 메시지는 복구할 수 없습니다.';
const UNKNOWN_CURRENT = '변경된 내용 확인 불가: 메시지를 조회할 수 없습니다.';
const AUDIT_TTL_MS = 10 * 60 * 1000;
const AUDIT_MAX_SIZE = 1_000;

const ACTION_NAMES = {
  GuildUpdate: '서버 설정 변경', ChannelCreate: '채널 생성', ChannelUpdate: '채널 변경',
  ChannelDelete: '채널 삭제', ChannelOverwriteCreate: '채널 권한 추가',
  ChannelOverwriteUpdate: '채널 권한 변경', ChannelOverwriteDelete: '채널 권한 삭제',
  MemberKick: '멤버 추방', MemberPrune: '멤버 정리', MemberBanAdd: '멤버 차단',
  MemberBanRemove: '멤버 차단 해제', MemberUpdate: '멤버 변경 (타임아웃 등)',
  MemberRoleUpdate: '멤버 역할 변경', MemberMove: '음성 채널 이동',
  MemberDisconnect: '음성 연결 해제', BotAdd: '봇 추가', RoleCreate: '역할 생성',
  RoleUpdate: '역할 변경', RoleDelete: '역할 삭제', InviteCreate: '초대 생성',
  InviteUpdate: '초대 변경', InviteDelete: '초대 삭제', WebhookCreate: '웹훅 생성',
  WebhookUpdate: '웹훅 변경', WebhookDelete: '웹훅 삭제', EmojiCreate: '이모지 생성',
  EmojiUpdate: '이모지 변경', EmojiDelete: '이모지 삭제', MessageDelete: '메시지 삭제',
  MessageBulkDelete: '메시지 일괄 삭제', MessagePin: '메시지 고정',
  MessageUnpin: '메시지 고정 해제', ThreadCreate: '스레드 생성', ThreadUpdate: '스레드 변경',
  ThreadDelete: '스레드 삭제', AutoModerationRuleCreate: '자동 관리 규칙 생성',
  AutoModerationRuleUpdate: '자동 관리 규칙 변경', AutoModerationRuleDelete: '자동 관리 규칙 삭제',
  AutoModerationBlockMessage: '자동 관리 메시지 차단',
  AutoModerationFlagToChannel: '자동 관리 경고', AutoModerationUserCommunicationDisabled: '자동 관리 타임아웃',
};

function guildOf(message) { return message?.guildId || message?.guild?.id; }
function channelOf(message) { return message?.channelId || message?.channel?.id; }
function toArray(value) {
  if (!value) return [];
  if (typeof value.values === 'function') return [...value.values()];
  return Array.isArray(value) ? value : [];
}
function bounded(value, max = 4_000) { return redact(value).slice(0, max); }

function attachmentMetadata(message) {
  return toArray(message?.attachments).slice(0, 10).map(attachment => {
    let path = '';
    try {
      const url = new URL(attachment.url);
      // Exclude credentials and signed query parameters from the content cache.
      if (url.protocol === 'https:' && !url.username && !url.password) {
        path = `${url.origin}${url.pathname}`.slice(0, 400);
      }
    } catch {}
    return `${bounded(attachment.name || attachment.filename || '이름 없는 첨부파일', 150)}${path ? ` — ${bounded(path, 400)}` : ''}`;
  });
}

function snapshot(message, capturedAt, { allowPartial = false, fallback = null, attachments } = {}) {
  if (!message?.id || (!allowPartial && message.partial) || typeof message.content !== 'string') return null;
  return {
    id: String(message.id), guildId: guildOf(message), channelId: channelOf(message),
    authorId: message.author?.id || fallback?.authorId || '알 수 없음',
    authorName: bounded(message.author?.tag || message.author?.username || fallback?.authorName || '알 수 없음', 150),
    content: bounded(message.content), attachments: attachments ?? attachmentMetadata(message),
    capturedAt,
  };
}

function originalText(saved) {
  if (!saved) return UNKNOWN_ORIGINAL;
  return saved.content || '(본문 없음)';
}

function metadataFields(message, saved) {
  return [
    { name: '메시지 ID', value: embedText(message?.id || saved?.id || '알 수 없음', 100), inline: true },
    { name: '채널 ID', value: embedText(channelOf(message) || saved?.channelId || '알 수 없음', 100), inline: true },
    { name: '작성자', value: embedText(`${saved?.authorName || message?.author?.tag || message?.author?.username || '알 수 없음'}\n사용자 ID: ${saved?.authorId || message?.author?.id || '알 수 없음'}`, 300), inline: false },
  ];
}

function describeValue(value, depth = 0) {
  if (value === undefined) return '(없음)';
  if (value === null) return 'null';
  if (typeof value !== 'object') return bounded(value, 250);
  if (depth >= 2) return '[객체]';
  if (Array.isArray(value)) return `[${value.slice(0, 5).map(item => describeValue(item, depth + 1)).join(', ')}${value.length > 5 ? ', …' : ''}]`;
  return `{${Object.entries(value).slice(0, 6).map(([key, item]) =>
    `${bounded(key, 50)}: ${/token|secret|password|authorization|api.?key|servicekey/i.test(key) ? '[민감정보 숨김]' : describeValue(item, depth + 1)}`
  ).join(', ')}}`;
}

/** Receives gateway events for one explicitly configured guild. */
export function createDiscordLogs({ client, guildId, logChannelId, sendLog, reportError, now = Date.now }) {
  const messages = new Map();
  const auditEntries = new Map();
  const versions = new Map();
  const rawUpdates = new Map();
  let rawUpdateCount = 0;
  let nextVersion = 0;
  let stopped = false;

  function prune(cache, ttl, limit) {
    const time = now();
    for (const [key, saved] of cache) {
      const capturedAt = typeof saved === 'number' ? saved : saved.capturedAt;
      if (time - capturedAt >= ttl) cache.delete(key);
      else break;
    }
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  }
  const cleanup = setInterval(() => {
    prune(messages, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE);
    prune(auditEntries, AUDIT_TTL_MS, AUDIT_MAX_SIZE);
    prune(versions, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE);
    for (const [id, queue] of rawUpdates) {
      if (now() - queue.capturedAt >= 60_000) {
        rawUpdateCount -= queue.records.length;
        rawUpdates.delete(id);
      }
    }
  }, 60_000);
  cleanup.unref?.();

  function inScope(message) {
    return !stopped && Boolean(guildId && logChannelId)
      && Boolean(message?.id && channelOf(message))
      && guildOf(message) === guildId && channelOf(message) !== logChannelId;
  }
  function accepts(message) {
    if (!inScope(message) || message?.author?.bot) return false;
    prune(messages, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE);
    return !messages.get(String(message.id))?.ignoredBot;
  }
  function cached(id) {
    prune(messages, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE);
    return messages.get(String(id));
  }
  function remember(saved) {
    if (!saved) return;
    messages.delete(saved.id);
    messages.set(saved.id, saved);
    prune(messages, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE);
  }
  function beginEvent(id) {
    const version = ++nextVersion;
    versions.delete(String(id));
    versions.set(String(id), { capturedAt: now(), version });
    prune(versions, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE);
    return version;
  }
  function isCurrent(id, version) { return !stopped && versions.get(String(id))?.version === version; }

  // The SDK fills in empty Collections for absent update fields. Keep only
  // bounded field-presence metadata from raw packets to distinguish omission
  // from an explicit attachments: [] removal. Runtime must bind this callback
  // synchronously; the normal update callback may run on a later microtask.
  function onRaw(packet) {
    if (stopped || packet?.t !== 'MESSAGE_UPDATE') return;
    const data = packet.d;
    const scope = { id: data?.id, channelId: data?.channel_id,
      guildId: data?.guild_id || client?.channels?.cache?.get(data?.channel_id)?.guildId };
    if (!inScope(scope)) return;
    const id = String(data.id);
    let queue = rawUpdates.get(id);
    if (!queue) {
      // Drop new metadata under saturation, never associate an evicted old
      // record with a different update. Actual event text remains usable.
      if (rawUpdates.size >= 1_000 || rawUpdateCount >= 1_000) return;
      queue = { capturedAt: now(), records: [], skippedTail: 0 };
      rawUpdates.set(id, queue);
    }
    queue.capturedAt = now();
    if (queue.skippedTail || queue.records.length >= 64 || rawUpdateCount >= 1_000) {
      queue.skippedTail++;
      return;
    }
    const hasAttachments = Object.hasOwn(data, 'attachments');
    queue.records.push({ hasContent: typeof data.content === 'string',
      content: typeof data.content === 'string' ? bounded(data.content) : null,
      hasAttachments, attachments: hasAttachments ? attachmentMetadata({ attachments: data.attachments }) : null,
      editedTimestamp: data.edited_timestamp ? Date.parse(data.edited_timestamp) : null,
      bot: Boolean(data.author?.bot) });
    rawUpdateCount++;
  }
  function takeRaw(message) {
    const id = String(message.id);
    const queue = rawUpdates.get(id);
    if (!queue) return null;
    let record = null;
    if (queue.records.length) {
      record = queue.records.shift();
      rawUpdateCount--;
    } else if (queue.skippedTail) queue.skippedTail--;
    if (!queue.records.length && !queue.skippedTail) rawUpdates.delete(id);
    // Fail closed if a missing SDK event or an unusual dispatch order broke
    // correspondence; never assign another event's attachment metadata.
    if (record?.hasContent && bounded(message.content) !== record.content) return null;
    if (record?.editedTimestamp && message.editedTimestamp && record.editedTimestamp !== message.editedTimestamp) return null;
    return record;
  }
  function timestamp() {
    const time = Number(now());
    return new Date(Number.isFinite(time) && Math.abs(time) < 8.64e15 ? time : Date.now()).toISOString();
  }
  async function publish(embed) {
    if (stopped) return;
    try {
      await sendLog({ embeds: [{ ...embed, timestamp: timestamp() }], allowedMentions: { parse: [], repliedUser: false } });
    } catch (error) {
      // Error reporting itself must not reject a gateway callback or recur.
      try { await reportError?.('Discord 로그 전송 실패', error); } catch {}
    }
  }

  function onMessageCreate(message) {
    if (!inScope(message)) return;
    beginEvent(message.id);
    // Retain just a bounded ID marker for observed bots, so a later partial
    // delete without author information still cannot produce a bot log.
    if (message.author?.bot) remember({ id: String(message.id), capturedAt: now(), ignoredBot: true });
    else remember(snapshot(message, now()));
  }

  async function onMessageUpdate(oldMessage, newMessage) {
    if (!inScope(newMessage)) return;
    const raw = takeRaw(newMessage);
    // Link-preview, embed and pin updates are not message-content edits and
    // do not supersede a pending lookup for an actual content edit.
    if (raw && !raw.hasContent && !raw.hasAttachments && !raw.bot && !newMessage.author?.bot) return;
    const version = beginEvent(newMessage.id);
    if (inScope(newMessage) && newMessage.author?.bot) {
      remember({ id: String(newMessage.id), capturedAt: now(), ignoredBot: true });
      return;
    }
    if (!accepts(newMessage) || oldMessage?.author?.bot) return;
    const old = cached(newMessage.id) || (accepts(oldMessage) && channelOf(oldMessage) === channelOf(newMessage)
      ? snapshot(oldMessage, now()) : null);
    if (raw?.bot) {
      remember({ id: String(newMessage.id), capturedAt: now(), ignoredBot: true });
      return;
    }
    let currentMessage = newMessage;
    let fetched = false;
    let content = typeof newMessage.content === 'string' ? newMessage.content
      : (raw && !raw.hasContent && old ? old.content : null);
    const needsAuthor = !currentMessage.author && (!old || old.authorId === '알 수 없음');
    if ((content === null || needsAuthor) && currentMessage.partial && typeof currentMessage.fetch === 'function') {
      try {
        currentMessage = await currentMessage.fetch();
        // Author-only fetches may identify an unobserved bot. Preserve any
        // exact text in the gateway event even if REST already sees a later edit.
        if (content === null) {
          fetched = true;
          content = typeof currentMessage.content === 'string' ? currentMessage.content : null;
        }
      } catch { /* A failed current-message fetch cannot recover the original. */ }
    }
    // A newer update or deletion supersedes a delayed REST result. In
    // particular, a deleted original must never be resurrected in the cache.
    if (!isCurrent(newMessage.id, version)) return;
    if (inScope(currentMessage) && currentMessage.author?.bot) {
      remember({ id: String(currentMessage.id), capturedAt: now(), ignoredBot: true });
      return;
    }
    if (!accepts(currentMessage)) return;
    const attachments = raw?.hasAttachments ? raw.attachments
      : raw && old ? old.attachments
        : currentMessage.partial && !toArray(currentMessage.attachments).length && old ? old.attachments
          : attachmentMetadata(currentMessage);
    const current = content === null ? null : snapshot({
      id: currentMessage.id, guildId: guildOf(currentMessage), channelId: channelOf(currentMessage),
      author: currentMessage.author, content, partial: currentMessage.partial,
    }, now(), { allowPartial: true, fallback: old, attachments });
    if (current) remember(current);
    if (old && current && old.content === current.content
      && JSON.stringify(old.attachments) === JSON.stringify(current.attachments)) return;
    const fields = metadataFields(currentMessage, current || old);
    fields.push({ name: '변경 전 원문', value: embedText(originalText(old), 1_024) });
    fields.push({ name: fetched ? '변경 후 (현재 조회)' : '변경 후', value: embedText(current ? originalText(current) : UNKNOWN_CURRENT, 1_024) });
    if (old?.attachments?.length) fields.push({ name: '변경 전 첨부파일', value: embedText(old.attachments.join('\n'), 800) });
    if (current?.attachments?.length) fields.push({ name: '변경 후 첨부파일', value: embedText(current.attachments.join('\n'), 800) });
    await publish({ title: '메시지 수정', color: 0xf1c40f, fields });
  }

  async function onMessageDelete(message) {
    if (!inScope(message)) return;
    beginEvent(message.id);
    if (!accepts(message)) return;
    const old = cached(message.id) || snapshot(message, now());
    messages.delete(String(message.id));
    const fields = metadataFields(message, old);
    fields.push({ name: '삭제된 원문', value: embedText(originalText(old), 1_024) });
    if (old?.attachments?.length) fields.push({ name: '첨부파일', value: embedText(old.attachments.join('\n'), 800) });
    await publish({ title: '메시지 삭제', color: 0xe74c3c,
      description: '삭제 실행자는 별도의 서버 감사 로그에서 확인하세요. 메시지 이벤트만으로 실행자를 추정하지 않습니다.', fields });
  }

  async function onMessageDeleteBulk(collection) {
    // Discord bulk deletions contain at most 100 messages. Capture before the
    // first await, then release every removed original from our cache.
    const removed = toArray(collection).filter(accepts).slice(0, 100).map(message => {
      beginEvent(message.id);
      const saved = cached(message.id) || snapshot(message, now());
      messages.delete(String(message.id));
      return { message, saved };
    });
    for (let offset = 0; offset < removed.length; offset += 5) {
      const batch = removed.slice(offset, offset + 5);
      const fields = batch.map(({ message, saved }) => ({
        name: embedText(`메시지 ${message.id}`, 100),
        value: embedText(`채널 ID: ${channelOf(message) || saved?.channelId || '알 수 없음'}\n사용자 ID: ${saved?.authorId || message.author?.id || '알 수 없음'}\n원문: ${originalText(saved)}${saved?.attachments?.length ? `\n첨부파일: ${saved.attachments.join('\n')}` : ''}`, 1_000),
      }));
      await publish({ title: '메시지 일괄 삭제', color: 0xe74c3c,
        description: `${removed.length}개 삭제 · ${offset + 1}–${offset + batch.length}번째 메시지\n삭제 실행자는 별도의 서버 감사 로그에서 확인하세요.`, fields });
    }
  }

  async function onAuditLogEntryCreate(entry, guild) {
    if (stopped || !guildId || !logChannelId || (guild?.id || entry?.guildId) !== guildId || !entry) return;
    const actorId = entry.executorId || entry.executor?.id;
    const targetId = entry.targetId || entry.target?.id;
    const channelId = entry.extra?.channel?.id || entry.extra?.channelId;
    if ((client?.user?.id && actorId === client.user.id) || targetId === logChannelId || channelId === logChannelId) return;
    prune(auditEntries, AUDIT_TTL_MS, AUDIT_MAX_SIZE);
    if (entry.id && auditEntries.has(entry.id)) return;
    if (entry.id) auditEntries.set(entry.id, now());
    prune(auditEntries, AUDIT_TTL_MS, AUDIT_MAX_SIZE);
    const actionName = AuditLogEvent[entry.action] || String(entry.action);
    const fields = [
      { name: '작업', value: embedText(`${ACTION_NAMES[actionName] || actionName} (${entry.action})`, 250) },
      { name: '실행자', value: embedText(`${entry.executor?.tag || entry.executor?.username || '알 수 없음'}\n사용자 ID: ${actorId || '알 수 없음'}`, 300) },
      { name: '대상', value: embedText(`${entry.target?.name || entry.target?.tag || entry.target?.username || '이름 없음'}\n대상 ID: ${targetId || '알 수 없음'}`, 300) },
      { name: '사유', value: embedText(entry.reason || '(사유 없음)', 800) },
    ];
    if (channelId) fields.push({ name: '채널 ID', value: embedText(channelId, 100), inline: true });
    if (entry.extra?.count !== undefined) fields.push({ name: '횟수', value: embedText(entry.extra.count, 100), inline: true });
    for (const change of (Array.isArray(entry.changes) ? entry.changes : []).slice(0, 6)) {
      const sensitive = /token|secret|password|authorization|api.?key|servicekey/i.test(String(change.key));
      fields.push({ name: embedText(`변경: ${change.key}`, 100),
        value: embedText(sensitive ? '[민감정보 숨김]' : `이전: ${describeValue(change.old)}\n이후: ${describeValue(change.new)}`, 500) });
    }
    await publish({ title: '서버 감사 로그', color: 0x5865f2,
      description: embedText(`감사 로그 ID: ${entry.id || '알 수 없음'}\n메시지 삭제 로그와 자동으로 연결하지 않습니다.`, 250), fields });
  }

  return { onRaw, onMessageCreate, onMessageUpdate, onMessageDelete, onMessageDeleteBulk, onAuditLogEntryCreate,
    stop() { stopped = true; clearInterval(cleanup); messages.clear(); auditEntries.clear(); versions.clear(); rawUpdates.clear(); rawUpdateCount = 0; } };
}
