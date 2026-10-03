import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid stored state');
  for (const key of ['warnings', 'timedBans', 'alerts']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Invalid stored ${key}`);
  }
  return state;
}

// One running bot per DATA_DIR. Writes are serialized and replace the file atomically.
export class StateStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'state.json');
    this.state = null;
    this.pending = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('DATA_DIR must be a real directory');
    await fs.chmod(this.directory, 0o700);
    let file;
    try {
      file = await fs.open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await file.stat()).isFile()) throw new Error('State must be a regular file');
      this.state = validate(JSON.parse(await file.readFile('utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { warnings: {}, timedBans: {}, alerts: {} };
    } finally {
      await file?.close();
    }
    // Verify durable writes before allowing moderation or automatic expiry.
    await this.update(() => {});
    return this;
  }

  read() {
    if (!this.state) throw new Error('State store is not initialized');
    return structuredClone(this.state);
  }

  update(mutate) {
    const operation = this.pending.then(async () => {
      const next = this.read();
      const result = await mutate(next);
      validate(next);
      const temporary = path.join(this.directory, `.state-${crypto.randomUUID()}.tmp`);
      let file;
      try {
        file = await fs.open(temporary, 'wx', 0o600);
        await file.writeFile(JSON.stringify(next), 'utf8');
        await file.sync();
        await file.close();
        file = null;
        await fs.rename(temporary, this.filename);
        this.state = next;
      } finally {
        await file?.close();
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
