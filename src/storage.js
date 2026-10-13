import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(directory, name, fallback) {
  try { return JSON.parse(await readFile(path.join(directory, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${name}. Rename the damaged file in data/ and restart.`); }
}
export async function saveJson(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
