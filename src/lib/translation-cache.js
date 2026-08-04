import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CACHE_VERSION = 'translations-v1';
const DEFAULT_CACHE_DIRECTORY = path.join(os.homedir(), '.lingoloop', 'cache', 'translations');
const SESSION_CACHE_KEY = Symbol.for('lingoloop.translationSessionCache');
const sessionCache = globalThis[SESSION_CACHE_KEY] || new Map();
globalThis[SESSION_CACHE_KEY] = sessionCache;

export function resolveTranslationCacheDirectory(requestedDirectory = '') {
  const requested = typeof requestedDirectory === 'string' ? requestedDirectory.trim() : '';
  return path.resolve(requested || DEFAULT_CACHE_DIRECTORY);
}

export function translationCacheHash({ provider = 'google-free', model = 'none', from, to, text }) {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    provider,
    model,
    from,
    to,
    text,
  })).digest('hex');
}

function sessionCacheKey(directory, descriptor) {
  return `${resolveTranslationCacheDirectory(directory)}\u0000${translationCacheHash(descriptor)}`;
}

export function readSessionTranslation(directory, descriptor, ttlMs = 6 * 60 * 60 * 1000) {
  const key = sessionCacheKey(directory, descriptor);
  const cached = sessionCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > ttlMs) {
    sessionCache.delete(key);
    return null;
  }
  return cached.text;
}

export function writeSessionTranslation(directory, descriptor, text, maxEntries = 5000) {
  if (sessionCache.size >= maxEntries) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey) sessionCache.delete(oldestKey);
  }
  sessionCache.set(sessionCacheKey(directory, descriptor), { text, createdAt: Date.now() });
}

export function clearSessionTranslationCache(directory) {
  const prefix = `${resolveTranslationCacheDirectory(directory)}\u0000`;
  let cleared = 0;
  for (const key of sessionCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    sessionCache.delete(key);
    cleared += 1;
  }
  return cleared;
}

function cacheVersionDirectory(directory) {
  return path.join(resolveTranslationCacheDirectory(directory), CACHE_VERSION);
}

function cacheFilePath(directory, hash) {
  return path.join(cacheVersionDirectory(directory), hash.slice(0, 2), `${hash}.json`);
}

export async function readPersistentTranslation(directory, descriptor) {
  const hash = translationCacheHash(descriptor);
  try {
    const data = JSON.parse(await fs.readFile(cacheFilePath(directory, hash), 'utf8'));
    return typeof data?.text === 'string' && data.text ? data.text : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writePersistentTranslation(directory, descriptor, translatedText) {
  const hash = translationCacheHash(descriptor);
  const filePath = cacheFilePath(directory, hash);
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
  const temporaryPath = path.join(parent, `.${hash}.${randomUUID()}.tmp`);
  const payload = JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    descriptor,
    text: translatedText,
  });
  try {
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return filePath;
}

export async function verifyTranslationCacheDirectory(directory) {
  const resolved = resolveTranslationCacheDirectory(directory);
  await fs.mkdir(cacheVersionDirectory(resolved), { recursive: true });
  const probe = path.join(cacheVersionDirectory(resolved), `.write-test-${randomUUID()}`);
  try {
    await fs.writeFile(probe, 'ok', { flag: 'wx' });
  } finally {
    await fs.rm(probe, { force: true }).catch(() => {});
  }
  return resolved;
}

export async function translationCacheStats(directory) {
  const resolved = resolveTranslationCacheDirectory(directory);
  const root = cacheVersionDirectory(resolved);
  let entries = 0;
  let bytes = 0;
  try {
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const files = await fs.readdir(path.join(root, prefix.name), { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        entries += 1;
        const stat = await fs.stat(path.join(root, prefix.name, file.name));
        bytes += stat.size;
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { directory: resolved, entries, bytes };
}

export async function clearPersistentTranslationCache(directory) {
  const resolved = resolveTranslationCacheDirectory(directory);
  clearSessionTranslationCache(resolved);
  await fs.rm(cacheVersionDirectory(resolved), { recursive: true, force: true });
  await fs.mkdir(cacheVersionDirectory(resolved), { recursive: true });
  return { directory: resolved, entries: 0, bytes: 0 };
}

export const TRANSLATION_CACHE_DEFAULT_DIRECTORY = DEFAULT_CACHE_DIRECTORY;
