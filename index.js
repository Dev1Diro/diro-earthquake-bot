  );
}

async function checkSafetyMessages() {
  const text = await fetchTextWithKeyFallback('https://www.safetydata.go.kr//V2/api/DSSP-IF-00247', ENV.SAFETY_KEY);
  const items = parseApiRecords(text);
  let sent = 0;

  for (const item of items.slice(0, 30)) {
    const message = safetyMessage(item);
    if (!message) continue;

    const id = safetyId(item);
    if (wasSent(id)) continue;

    const messageTime = safetyTime(item);
    if (firstSafetyCheck && (!messageTime || Date.now() - messageTime > FIVE_MINUTES_MS)) {
      remember(id);
      continue;
    }

    remember(id);

    await enqueuePriorityDiscordMessage(ENV.CHANNEL_ID, {
      content: T.safetyContent,
      embeds: [
        {
          title: sanitize(safetyTitle(item), 100),
          color: 0xffcc00,
          description: sanitize(message, 1800),
          fields: [{ name: T.area, value: sanitize(safetyArea(item), 200), inline: false }],
          timestamp: messageTime ? new Date(messageTime).toISOString() : nowIso(),
        },
      ],
      allowed_mentions: { parse: ['everyone'] },
    });

    sent++;
  }

  firstSafetyCheck = false;
  lastSafetyStatus = `ok: fetched=${items.length}, sent=${sent}`;
  await log('INFO', `Safety check complete (${lastSafetyStatus})`);
}

async function runChecks() {
  if (checksRunning) {
    rerunRequested = true;
    return;
  }

  checksRunning = true;

  do {
    rerunRequested = false;
    lastCheckAt = nowIso();

    const [kmaResult, safetyResult] = await Promise.allSettled([
      checkKmaEarthquakes(),
      checkSafetyMessages(),
    ]);

    if (kmaResult.status === 'rejected') {
      const error = kmaResult.reason;
      lastKmaStatus = `error: ${error?.message || error}`;
      await log('ERROR', 'KMA earthquake API check failed', error);
    }

    if (safetyResult.status === 'rejected') {
      const error = safetyResult.reason;
      lastSafetyStatus = `error: ${error?.message || error}`;
      await log('ERROR', 'Safety API check failed', error);
    }
  } while (rerunRequested);

  checksRunning = false;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function allowHttpRequest(ip) {
  const now = Date.now();
  const bucket = httpBuckets.get(ip) || { tokens: CFG.HTTP_RATE_BURST, at: now };
  const refill = ((now - bucket.at) / 1000) * CFG.HTTP_RATE_REFILL_PER_SEC;

  bucket.tokens = Math.min(CFG.HTTP_RATE_BURST, bucket.tokens + refill);
  bucket.at = now;

  if (bucket.tokens < 1) {
    httpBuckets.set(ip, bucket);
    return false;
  }

  bucket.tokens -= 1;
  httpBuckets.set(ip, bucket);

  if (httpBuckets.size > 1000) {
    for (const [key, value] of httpBuckets.entries()) {
      if (now - value.at > 30 * 60 * 1000) httpBuckets.delete(key);
    }
  }

  return true;
}

function isSuspiciousPath(pathname) {
  return /(?:\.env|wp-|php|admin|login|shell|cgi-bin|\.git|config|backup|passwd)/i.test(pathname);
}

function writeSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
}

function sendText(res, status, text) {
  writeSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, body) {
  writeSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function handleHttp(req, res) {
  const ip = clientIp(req);

  if (!allowHttpRequest(ip)) {
    blockedRequests++;
    return sendText(res, 429, 'rate limited');
  }

  if (!['GET', 'HEAD'].includes(req.method || '')) {
    blockedRequests++;
    return sendText(res, 405, 'method not allowed');
  }

  if (String(req.url || '').length > CFG.MAX_URL_LENGTH) {
    blockedRequests++;
    return sendText(res, 414, 'uri too long');
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (isSuspiciousPath(url.pathname)) {
    blockedRequests++;
    console.warn(`[BLOCKED HTTP] ip=${ip} path=${url.pathname}`);
    return sendText(res, 403, 'forbidden');
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      lastCheckAt,
      kma: lastKmaStatus,
      safety: lastSafetyStatus,
      queuedMessages: sendQueue.length,
      blockedRequests,
    });
  }

  if (url.pathname === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /\n');
  if (url.pathname === '/favicon.ico') return sendText(res, 204, '');

  blockedRequests++;
  return sendText(res, 404, 'not found');
}

const server = http.createServer(handleHttp);
server.maxHeadersCount = 32;
server.requestTimeout = 5000;
server.headersTimeout = 6000;
server.keepAliveTimeout = 3000;

server.listen(ENV.PORT, '0.0.0.0', async () => {
  console.log(`Render web server started on port ${ENV.PORT}`);
  await verifyDiscordToken();
  await runChecks();
  setInterval(runChecks, FIVE_MINUTES_MS);
});
