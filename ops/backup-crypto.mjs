import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
const [mode, keyFile, input, output] = process.argv.slice(2);
const magic = Buffer.from('PJBGCM1');
if (!['encrypt', 'decrypt'].includes(mode) || !keyFile || !input || !output) {
  throw new Error('Usage: backup-crypto.mjs encrypt|decrypt key-file input-file|- output-file');
}
const key = createHash('sha256')
  .update(await fs.readFile(keyFile))
  .digest();
const temporary = output + '.' + randomBytes(8).toString('hex') + '.tmp';
try {
  if (mode === 'encrypt') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(magic);
    await fs.writeFile(temporary, Buffer.concat([magic, iv]), { mode: 0o600, flag: 'wx' });
    await pipeline(
      input === '-' ? process.stdin : createReadStream(input),
      cipher,
      createWriteStream(temporary, { flags: 'a' }),
    );
    await fs.appendFile(temporary, cipher.getAuthTag());
  } else {
    if (input === '-') {
      throw new Error('Decrypt requires a complete backup file');
    }
    const handle = await fs.open(input, 'r');
    let size;
    let header;
    let tag;
    try {
      size = (await handle.stat()).size;
      if (size < 35) {
        throw new Error('Invalid encrypted backup');
      }
      header = Buffer.alloc(19);
      tag = Buffer.alloc(16);
      await handle.read(header, 0, 19, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally {
      await handle.close();
    }
    if (!header.subarray(0, 7).equals(magic)) {
      throw new Error('Unknown backup format');
    }
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(7));
    cipher.setAAD(magic);
    cipher.setAuthTag(tag);
    await pipeline(
      createReadStream(input, { start: 19, end: size - 17 }),
      cipher,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
  }
  const handle = await fs.open(temporary, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, output);
} catch (error) {
  await fs.unlink(temporary).catch(() => {});
  throw error;
}
