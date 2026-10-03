let secretVariants = [];

export function configureSecrets(secrets = []) {
  secretVariants = [...new Set(secrets.filter(Boolean).flatMap(value => {
    const text = String(value);
    const forms = [text, encodeURIComponent(text)];
    try { forms.push(decodeURIComponent(text)); } catch {}
    return forms;
  }))].sort((a, b) => b.length - a.length);
}

export function redact(value) {
  let text = String(value ?? '');
  for (const secret of secretVariants) text = text.split(secret).join('[비밀값 숨김]');
  return text
    .replace(/((?:serviceKey|authKey|api[_-]?key|token|authorization)\s*[=:]\s*)(?:Bot\s+|Bearer\s+)?(?:\[비밀값 숨김\]|[^\s&"<>]+)/gi, '$1[비밀값 숨김]')
    .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{23,28}\.[\w-]{6}\.[\w-]{20,})\b/g, '[비밀값 숨김]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function embedText(value, max = 1024) {
  const text = redact(value).replace(/([\\`*_~|\[\]<>])/g, '\\$1').replace(/@/g, '@\u200b');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text || '(내용 없음)';
}
