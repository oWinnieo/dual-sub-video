import { randomBytes } from 'node:crypto';
import translate from 'google-translate-api-next';
import { geminiTranslate, geminiRefine } from '@/lib/gemini';
import { AdaptiveRequestPool } from '@/lib/adaptive-request-pool';
import {
    buildTranslationEnvelope,
    parseTranslationEnvelope,
    splitTranslationItems,
} from '@/lib/translation-batch';
import {
    readPersistentTranslation,
    readSessionTranslation,
    resolveTranslationCacheDirectory,
    translationCacheHash,
    writePersistentTranslation,
    writeSessionTranslation,
} from '@/lib/translation-cache';

const GOOGLE_MAX_ATTEMPTS = 3;
const GOOGLE_RETRY_DELAYS_MS = [0, 1200, 4000];
const googlePool = new AdaptiveRequestPool({
    initial: 2,
    minimum: 1,
    maximum: 3,
    successesToIncrease: 6,
    minimumStartIntervalMs: 250,
});
let googlePrimaryLimitedUntil = 0;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function translationErrorStatus(error) {
    const explicit = Number(error?.response?.status || error?.status || error?.statusCode);
    if (Number.isFinite(explicit) && explicit >= 400) return explicit;
    const match = String(error?.message || '').match(/(?:status(?: code)?|HTTP)\s+(\d{3})/i);
    return match ? Number(match[1]) : 500;
}

function isRetryableGoogleStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function providerName(llmModel) {
    return llmModel && llmModel !== 'none' ? 'gemini' : 'google-free';
}

function cacheDescriptor(text, from, to, llmModel) {
    return {
        provider: providerName(llmModel),
        model: llmModel || 'none',
        from,
        to,
        text,
    };
}

async function readTranslationCache(directory, descriptor) {
    const cached = readSessionTranslation(directory, descriptor);
    if (cached) return cached;
    try {
        const persistent = await readPersistentTranslation(directory, descriptor);
        if (persistent) {
            writeSessionTranslation(directory, descriptor, persistent);
            return persistent;
        }
    } catch (error) {
        console.warn('[Translate API] Persistent cache read failed; continuing without it.', {
            directory: resolveTranslationCacheDirectory(directory),
            message: error instanceof Error ? error.message : String(error),
        });
    }
    return null;
}

async function writeTranslationCache(directory, descriptor, text) {
    writeSessionTranslation(directory, descriptor, text);
    try {
        await writePersistentTranslation(directory, descriptor, text);
    } catch (error) {
        console.warn('[Translate API] Persistent cache write failed; keeping the session cache only.', {
            directory: resolveTranslationCacheDirectory(directory),
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

async function translateWithGoogleGet(text, from, to) {
    const params = new URLSearchParams({ client: 'gtx', sl: from, tl: to, dt: 't', q: text });
    const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (!response.ok) {
        const error = new Error(`Google GET translation returned HTTP ${response.status}`);
        error.status = response.status;
        const retryAfterSeconds = Number(response.headers.get('Retry-After'));
        if (response.status === 429) {
            error.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? retryAfterSeconds * 1000
                : 8000;
        }
        throw error;
    }
    const data = await response.json();
    const translatedText = Array.isArray(data?.[0])
        ? data[0].map((segment) => segment?.[0] || '').join('').trim()
        : '';
    if (!translatedText) throw new Error('Google GET translation returned an empty result.');
    return translatedText;
}

async function translateGoogleOnce(text, from, to) {
    if (Date.now() >= googlePrimaryLimitedUntil) {
        try {
            const result = await translate(text, { from, to });
            if (result?.text) return result.text;
            throw new Error('The primary Google channel returned an empty result.');
        } catch (error) {
            const primaryStatus = translationErrorStatus(error);
            if (primaryStatus === 429) {
                error.status = 429;
                error.retryAfterMs = Math.max(1000, Number(error?.retryAfterMs) || 8000);
                throw error;
            }
            googlePrimaryLimitedUntil = Date.now() + 60_000;
            console.warn('[Translate API] Primary Google channel failed; using GET fallback for 60 seconds.', {
                status: primaryStatus,
            });
        }
    }
    return translateWithGoogleGet(text, from, to);
}

async function translateWithAdaptiveRateLimit(text, from, to) {
    let lastError = null;
    for (let attempt = 1; attempt <= GOOGLE_MAX_ATTEMPTS; attempt += 1) {
        const retryDelay = GOOGLE_RETRY_DELAYS_MS[attempt - 1];
        if (retryDelay) await wait(retryDelay + Math.floor(Math.random() * 300));
        try {
            return await googlePool.run(() => translateGoogleOnce(text, from, to));
        } catch (error) {
            lastError = error;
            const status = translationErrorStatus(error);
            console.warn('[Translate API] Google batch request failed', {
                status,
                attempt,
                maxAttempts: GOOGLE_MAX_ATTEMPTS,
                pool: googlePool.snapshot(),
            });
            if (!isRetryableGoogleStatus(status) || attempt === GOOGLE_MAX_ATTEMPTS) break;
            if (status === 429) {
                await wait(Math.max(1000, Number(error?.retryAfterMs) || 8000));
            }
        }
    }
    const status = translationErrorStatus(lastError);
    if (lastError && typeof lastError === 'object') {
        lastError.status = status;
        if (status === 429 && !lastError.retryAfterMs) lastError.retryAfterMs = 8000;
    }
    throw lastError;
}

async function translateTextWithProvider(text, from, to, llmModel, apiKey) {
    const useGemini = Boolean(llmModel && llmModel !== 'none' && (apiKey || process.env.GEMINI_API_KEY));
    let resultText = '';
    if (useGemini) resultText = await geminiTranslate(text, from, to, llmModel, apiKey);
    if (!resultText) {
        const sourceLang = from === 'zh' ? 'zh-CN' : from;
        const targetLang = to === 'zh' ? 'zh-CN' : to;
        resultText = await translateWithAdaptiveRateLimit(text, sourceLang, targetLang);
    }
    if (llmModel && llmModel !== 'none') {
        resultText = await geminiRefine(text, resultText, from, to, llmModel, apiKey);
    }
    return resultText;
}

async function translateAlignedBatch(items, from, to, llmModel, apiKey) {
    if (items.length === 1) {
        return [await translateTextWithProvider(items[0].text, from, to, llmModel, apiKey)];
    }
    const token = randomBytes(5).toString('hex');
    const envelope = buildTranslationEnvelope(items, token);
    try {
        const translated = await translateTextWithProvider(envelope, from, to, llmModel, apiKey);
        return parseTranslationEnvelope(translated, items.length, token);
    } catch (error) {
        const status = translationErrorStatus(error);
        if (status === 429) throw error;
        const midpoint = Math.ceil(items.length / 2);
        console.warn('[Translate API] Batch could not be aligned; splitting it safely.', {
            size: items.length,
            left: midpoint,
            right: items.length - midpoint,
            message: error instanceof Error ? error.message : String(error),
        });
        const [left, right] = await Promise.all([
            translateAlignedBatch(items.slice(0, midpoint), from, to, llmModel, apiKey),
            translateAlignedBatch(items.slice(midpoint), from, to, llmModel, apiKey),
        ]);
        return [...left, ...right];
    }
}

function normalizeItems(body) {
    if (Array.isArray(body.items)) {
        if (!body.items.length || body.items.length > 40) {
            throw Object.assign(new Error('A translation batch must contain between 1 and 40 items.'), { status: 400 });
        }
        const seen = new Set();
        return body.items.map((item, index) => {
            const id = String(item?.id ?? index);
            const text = typeof item?.text === 'string' ? item.text.trim() : '';
            if (!text) throw Object.assign(new Error(`Translation item ${id} has no text.`), { status: 400 });
            if (seen.has(id)) throw Object.assign(new Error(`Translation item id ${id} is duplicated.`), { status: 400 });
            seen.add(id);
            return { id, text };
        });
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
        throw Object.assign(new Error('Text is required.'), { status: 400 });
    }
    return [{ id: 'single', text: body.text.trim() }];
}

export async function POST(request) {
    try {
        const body = await request.json();
        const items = normalizeItems(body);
        const from = typeof body.from === 'string' && body.from ? body.from : 'auto';
        const to = typeof body.to === 'string' && body.to ? body.to : 'en';
        const llmModel = body.llmModel || 'none';
        const apiKey = body.apiKey || null;
        const useCache = body.useCache !== false;
        const cacheDirectory = resolveTranslationCacheDirectory(body.cacheDirectory);
        const results = new Array(items.length);
        const missing = [];
        const pendingByHash = new Map();

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if (from === to || (from === 'zh' && to.startsWith('zh'))) {
                results[index] = { id: item.id, text: item.text, unchanged: true };
                continue;
            }
            const descriptor = cacheDescriptor(item.text, from, to, llmModel);
            const cachedText = useCache ? await readTranslationCache(cacheDirectory, descriptor) : null;
            if (cachedText) results[index] = { id: item.id, text: cachedText, cached: true };
            else {
                const hash = translationCacheHash(descriptor);
                const duplicate = pendingByHash.get(hash);
                if (duplicate) duplicate.outputIndexes.push(index);
                else {
                    const pending = { ...item, outputIndexes: [index], descriptor };
                    pendingByHash.set(hash, pending);
                    missing.push(pending);
                }
            }
        }

        const safeBatches = splitTranslationItems(missing, 40, 6000);
        for (const batch of safeBatches) {
            const translatedTexts = await translateAlignedBatch(batch, from, to, llmModel, apiKey);
            if (translatedTexts.length !== batch.length) {
                throw new Error('The translated batch did not preserve its input length.');
            }
            for (let index = 0; index < batch.length; index += 1) {
                const item = batch[index];
                const translatedText = String(translatedTexts[index] || '').trim();
                if (!translatedText) throw new Error(`Translation item ${item.id} returned an empty result.`);
                item.outputIndexes.forEach((outputIndex) => {
                    results[outputIndex] = {
                        id: items[outputIndex].id,
                        text: translatedText,
                        cached: false,
                        deduplicated: outputIndex !== item.outputIndexes[0],
                    };
                });
                if (useCache) await writeTranslationCache(cacheDirectory, item.descriptor, translatedText);
            }
        }

        const payload = {
            items: results,
            cacheDirectory,
            pool: googlePool.snapshot(),
        };
        if (!Array.isArray(body.items)) {
            payload.text = results[0].text;
            payload.cached = Boolean(results[0].cached);
        }
        return Response.json(payload);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = translationErrorStatus(error);
        const retryAfterMs = Number(error?.retryAfterMs) || (status === 429 ? 8000 : 0);
        console.warn('[Translate API] Request exhausted its retries', {
            message,
            status,
            retryAfterMs,
            pool: googlePool.snapshot(),
        });
        return Response.json({ error: message, retryAfterMs, pool: googlePool.snapshot() }, {
            status,
            headers: retryAfterMs ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } : {},
        });
    }
}
