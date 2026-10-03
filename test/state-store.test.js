import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateStore } from '../state-store.js';

const guildUser = '111111111111111111:222222222222222222';
const alertId = '333333333333333333:KMA_test';

async function directoryFor(t) {
  const root = await fs.mkdtemp('/tmp/diro-state-store-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'data');
}

async function diskState(directory) {
  return JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('initializes a real state file and restores warnings, timed bans, and sent alerts after restart', async t => {
  const directory = await directoryFor(t);
  const store = await new StateStore(directory).init();
  assert.deepEqual(await diskState(directory), { warnings: {}, timedBans: {}, alerts: {} });

  await store.update(state => {
    state.warnings[guildUser] = [{ id: 'warning-1', reason: '도배', createdAt: 1_800_000_000_000 }];
    state.timedBans[guildUser] = { marker: 'diro-ban-1', expiresAt: 1_800_000_060_000, status: 'active' };
    state.alerts[alertId] = 1_800_000_000_000;
  });
  const committed = store.read();
  assert.deepEqual(await diskState(directory), committed);

  const restarted = await new StateStore(directory).init();
  assert.deepEqual(restarted.read(), committed);
  const snapshot = restarted.read();
  snapshot.warnings[guildUser][0].reason = 'changed outside the store';
  delete snapshot.timedBans[guildUser];
  assert.deepEqual(restarted.read(), committed);
  assert.deepEqual(await diskState(directory), committed);
});

test('concurrent asynchronous mutations serialize without losing another operation’s records', async t => {
  const directory = await directoryFor(t);
  const store = await new StateStore(directory).init();
  const entered = deferred();
  const release = deferred();
  const order = [];

  const first = store.update(async state => {
    order.push('first');
    state.warnings[guildUser] = [{ id: 'warning-1' }];
    entered.resolve();
    await release.promise;
    return 1;
  });
  await entered.promise;
  const second = store.update(state => {
    order.push('second');
    assert.equal(state.warnings[guildUser].length, 1);
    state.warnings[guildUser].push({ id: 'warning-2' });
    return 2;
  });
  const ban = store.update(state => {
    order.push('ban');
    assert.equal(state.warnings[guildUser].length, 2);
    state.timedBans[guildUser] = { marker: 'diro-ban-2', status: 'pending' };
    return 'ban stored';
  });
  const alert = store.update(state => {
    order.push('alert');
    assert.equal(state.timedBans[guildUser].marker, 'diro-ban-2');
    state.alerts[alertId] = 1_800_000_000_000;
    return 'alert stored';
  });
  assert.deepEqual(order, ['first']);
  assert.deepEqual(store.read(), { warnings: {}, timedBans: {}, alerts: {} });
  release.resolve();

  assert.deepEqual(await Promise.all([first, second, ban, alert]), [1, 2, 'ban stored', 'alert stored']);
  assert.deepEqual(order, ['first', 'second', 'ban', 'alert']);
  assert.deepEqual(await diskState(directory), {
    warnings: { [guildUser]: [{ id: 'warning-1' }, { id: 'warning-2' }] },
    timedBans: { [guildUser]: { marker: 'diro-ban-2', status: 'pending' } },
    alerts: { [alertId]: 1_800_000_000_000 },
  });
});

test('a rejected mutation rolls back its draft and allows the next queued update', async t => {
  const directory = await directoryFor(t);
  const store = await new StateStore(directory).init();
  await store.update(state => { state.alerts[alertId] = 100; });
  const committed = store.read();
  const originalFile = await fs.readFile(store.filename, 'utf8');
  const failure = store.update(state => {
    state.alerts[alertId] = 200;
    state.warnings[guildUser] = [{ id: 'uncommitted' }];
    throw new Error('moderation operation cancelled');
  });
  const recovery = store.update(state => {
    assert.deepEqual(state, committed);
    state.alerts[alertId] = 300;
  });

  await assert.rejects(failure, /moderation operation cancelled/);
  await recovery;
  assert.equal(store.read().alerts[alertId], 300);
  assert.deepEqual(store.read().warnings, {});
  assert.deepEqual(await diskState(directory), store.read());
  assert.notEqual(await fs.readFile(store.filename, 'utf8'), originalFile);
});

test('atomic replacement failure preserves the last valid file and in-memory state, then recovers', async t => {
  const directory = await directoryFor(t);
  const store = await new StateStore(directory).init();
  await store.update(state => { state.warnings[guildUser] = [{ id: 'committed' }]; });
  const committed = store.read();
  const originalFile = await fs.readFile(store.filename, 'utf8');
  const rename = t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error('atomic replacement failed'), { code: 'EIO' });
  });

  await assert.rejects(store.update(state => {
    state.warnings[guildUser].push({ id: 'not committed' });
    state.timedBans[guildUser] = { marker: 'not committed' };
  }), { code: 'EIO' });
  assert.deepEqual(store.read(), committed);
  assert.equal(await fs.readFile(store.filename, 'utf8'), originalFile);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  rename.mock.restore();

  await store.update(state => { state.alerts[alertId] = 400; });
  assert.deepEqual(await diskState(directory), store.read());
  assert.deepEqual((await new StateStore(directory).init()).read(), store.read());
});

test('malformed JSON and invalid state shapes fail closed without overwriting existing records', async t => {
  const directory = await directoryFor(t);
  await fs.mkdir(directory, { mode: 0o700 });
  const filename = path.join(directory, 'state.json');
  for (const content of [
    '{"warnings": {"important":',
    'null',
    '{"warnings":[],"timedBans":{},"alerts":{}}',
    '{"warnings":{},"timedBans":{},"alerts":null}',
    '{"warnings":{},"alerts":{}}',
  ]) {
    await fs.writeFile(filename, content, { mode: 0o600 });
    const store = new StateStore(directory);
    await assert.rejects(store.init());
    assert.throws(() => store.read(), /not initialized/);
    assert.equal(await fs.readFile(filename, 'utf8'), content);
    assert.deepEqual(await fs.readdir(directory), ['state.json']);
  }
});

test('refuses a symlink state file and leaves its target untouched', async t => {
  const directory = await directoryFor(t);
  await fs.mkdir(directory, { mode: 0o700 });
  const target = path.join(path.dirname(directory), 'outside-state.json');
  const content = '{"warnings":{"important":[{"id":"keep"}]},"timedBans":{},"alerts":{}}';
  await fs.writeFile(target, content, { mode: 0o600 });
  const filename = path.join(directory, 'state.json');
  await fs.symlink(target, filename);
  const store = new StateStore(directory);

  await assert.rejects(store.init());
  assert.throws(() => store.read(), /not initialized/);
  assert.equal((await fs.lstat(filename)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), content);
});

test('creates private storage and preserves private file modes on every update', async t => {
  const directory = await directoryFor(t);
  const store = await new StateStore(directory).init();
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(store.filename)).mode & 0o777, 0o600);
  await store.update(state => { state.alerts[alertId] = 500; });
  assert.equal((await fs.stat(store.filename)).mode & 0o777, 0o600);
});

test('secures a reused permissive data directory and state file before allowing operations', async t => {
  const directory = await directoryFor(t);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o777);
  const filename = path.join(directory, 'state.json');
  await fs.writeFile(filename, '{"warnings":{},"timedBans":{},"alerts":{}}', { mode: 0o600 });
  await fs.chmod(filename, 0o666);

  const store = await new StateStore(directory).init();
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(store.filename)).mode & 0o777, 0o600);
});
