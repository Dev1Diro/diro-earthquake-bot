import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
async function availablePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('npm start entry serves real HTTP and restarts against persisted storage with offline Discord', { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diro-http-'));
  try {
    for (let run = 0; run < 2; run++) {
      const port = await availablePort();
      const env = { ...process.env, DISCORD_TOKEN: 'offline-fixture', CHANNEL_ID: '222222222222222222', LOGS: '333333333333333333', DATA_DIR: directory, PORT: String(port), GUILD_ID: '', KMA_KEY: '', SAFETY_KEY: '', CHANNEL_IDS: '', LOG_CHANNEL_ID: '', logs: '' };
      const child = spawn(process.execPath, ['--import', './test/fixtures/offline-discord.mjs', 'index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => child.once('close', resolve));
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      try {
        let health;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (child.exitCode !== null) throw new Error(`Startup failed: ${output}`);
          try {
            health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
            if (health.lastCheckAt && health.discordConnection.commands === 'ok') break;
          } catch {}
          await delay(50);
        }
        assert.equal(health?.status, 'ok', output);
        assert.ok(health.lastCheckAt);
        assert.equal(health.discordConnection.gateway, 'ready');
        assert.equal(health.discordConnection.commands, 'ok');
        assert.match(health.kma, /^disabled/);
        assert.match(health.safety, /^disabled/);
        assert.doesNotMatch(JSON.stringify(health), /offline-fixture/);
        assert.equal((await fetch(`http://127.0.0.1:${port}/unknown`)).status, 404);
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' })).status, 405);
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Host: '[' } })).status, 200);
        assert.equal((await fs.stat(path.join(directory, 'state.json'))).mode & 0o777, 0o600);
      } finally {
        child.kill('SIGTERM');
        const fallback = setTimeout(() => child.kill('SIGKILL'), 2_000);
        await exited;
        clearTimeout(fallback);
      }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
