function normalizePath(path) {
  const normalized = String(path || '')
    .trim()
    .normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function mediaIdentityKeys(file, path = '') {
  const keys = [];
  const normalizedPath = normalizePath(path);
  if (normalizedPath) keys.push(`path:${normalizedPath}`);

  if (file) {
    const name = String(file.name || '').normalize('NFC').toLowerCase();
    const size = Number.isFinite(file.size) ? file.size : 0;
    const lastModified = Number.isFinite(file.lastModified) ? file.lastModified : 0;
    keys.push(`file:${name}\u0000${size}\u0000${lastModified}`);
  }

  return keys;
}

export function partitionDuplicateMediaFiles(files, existingItems, getPath) {
  const knownKeys = new Set(
    (existingItems || []).flatMap((item) => (
      item.identityKeys?.length
        ? item.identityKeys
        : mediaIdentityKeys(item.file, item.path)
    )),
  );
  const unique = [];
  const duplicates = [];

  for (const file of files || []) {
    const path = getPath?.(file) || '';
    const identityKeys = mediaIdentityKeys(file, path);
    if (identityKeys.some((key) => knownKeys.has(key))) {
      duplicates.push(file);
      continue;
    }
    identityKeys.forEach((key) => knownKeys.add(key));
    unique.push({ file, path, identityKeys });
  }

  return { unique, duplicates };
}
