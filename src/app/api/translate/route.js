import translate from 'google-translate-api-next';
import { geminiTranslate, geminiRefine } from '@/lib/gemini';

const GOOGLE_MIN_INTERVAL_MS = 250;
const GOOGLE_MAX_ATTEMPTS = 3;
const GOOGLE_RETRY_DELAYS_MS = [0, 1200, 4000];
const TRANSLATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSLATION_CACHE_MAX_ENTRIES = 5000;
let googleQueue = Promise.resolve();
let lastGoogleRequestAt = 0;
let googlePrimaryLimitedUntil = 0;
const translationCache = new Map();

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function translationErrorStatus(error) {
    const explicit = Number(error?.response?.status || error?.status || error?.statusCode);
    if (Number.isFinite(explicit) && explicit >= 400) return explicit;
    const match = String(error?.message || '').match(/status(?: code)?\s+(\d{3})/i);
    return match ? Number(match[1]) : 500;
}

function translationCacheKey(text, from, to) {
    return `${from}\u0000${to}\u0000${text}`;
}

function readTranslationCache(key) {
    const cached = translationCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.createdAt > TRANSLATION_CACHE_TTL_MS) {
        translationCache.delete(key);
        return null;
    }
    return cached.text;
}

function writeTranslationCache(key, text) {
    if (translationCache.size >= TRANSLATION_CACHE_MAX_ENTRIES) {
        const oldestKey = translationCache.keys().next().value;
        if (oldestKey) translationCache.delete(oldestKey);
    }
    translationCache.set(key, { text, createdAt: Date.now() });
}

function isRetryableGoogleStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function enqueueGoogleTranslation(task) {
    const run = googleQueue.catch(() => {}).then(async () => {
        const spacing = GOOGLE_MIN_INTERVAL_MS - (Date.now() - lastGoogleRequestAt);
        if (spacing > 0) await wait(spacing);
        lastGoogleRequestAt = Date.now();
        return task();
    });
    googleQueue = run.then(() => {}, () => {});
    return run;
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
        throw error;
    }
    const data = await response.json();
    const translatedText = Array.isArray(data?.[0])
        ? data[0].map((segment) => segment?.[0] || '').join('').trim()
        : '';
    if (!translatedText) throw new Error('Google GET translation returned an empty result.');
    return { text: translatedText };
}

async function translateWithRateLimit(text, from, to) {
    return enqueueGoogleTranslation(async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= GOOGLE_MAX_ATTEMPTS; attempt += 1) {
            const retryDelay = GOOGLE_RETRY_DELAYS_MS[attempt - 1];
            if (retryDelay) await wait(retryDelay);
            try {
                lastGoogleRequestAt = Date.now();
                if (Date.now() >= googlePrimaryLimitedUntil) {
                    try {
                        return await translate(text, { from, to });
                    } catch (error) {
                        const primaryStatus = translationErrorStatus(error);
                        googlePrimaryLimitedUntil = Date.now() + 60_000;
                        console.warn('[Translate API] Primary Google channel failed; using GET fallback for 60 seconds.', {
                            status: primaryStatus,
                        });
                    }
                }
                return await translateWithGoogleGet(text, from, to);
            } catch (error) {
                lastError = error;
                const status = translationErrorStatus(error);
                console.warn('[Translate API] Google request failed', {
                    status,
                    attempt,
                    maxAttempts: GOOGLE_MAX_ATTEMPTS,
                });
                if (!isRetryableGoogleStatus(status) || attempt === GOOGLE_MAX_ATTEMPTS) break;
            }
        }
        const status = translationErrorStatus(lastError);
        if (lastError && typeof lastError === 'object') {
            lastError.status = status;
            if (status === 429) lastError.retryAfterMs = 8000;
        }
        throw lastError;
    });
}

export async function POST(request) {
    try {
        const body = await request.json();
        const { text, from, llmModel, apiKey } = body;
        const to = typeof body.to === 'string' && body.to ? body.to : 'en';
        const useCache = body.useCache !== false;

        if (!text) {
            return new Response(JSON.stringify({ error: "Text is required" }), { status: 400 });
        }

        if (from === to || (from === 'zh' && to.startsWith('zh'))) {
            return new Response(JSON.stringify({ text, unchanged: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const cacheKey = translationCacheKey(text, from, to);
        const cachedText = useCache ? readTranslationCache(cacheKey) : null;
        if (cachedText) {
            return new Response(JSON.stringify({ text: cachedText, cached: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        let resultText = '';

        // Only call Gemini when a real model was explicitly selected. The
        // client sends "none" for the default translator, which must not be
        // interpreted as a Gemini model id.
        const useGemini = Boolean(llmModel && llmModel !== 'none' && (apiKey || process.env.GEMINI_API_KEY));
        if (useGemini) {
            console.log("[API] Using Gemini for Chinese translation...");
            resultText = await geminiTranslate(text, from, to, llmModel, apiKey);
        }

        // If not Chinese or if Gemini failed, use the default translator
        if (!resultText) {
            console.log("[API] Using fallback google-translate-api-next...");
            // google-translate-api-next requires 'zh-CN' or 'zh-TW', 'zh' is not supported
            const sourceLang = from === 'zh' ? 'zh-CN' : from;
            const targetLang = to === 'zh' ? 'zh-CN' : to;
            const res = await translateWithRateLimit(text, sourceLang, targetLang);
            resultText = res.text;
        }

        // Apply LLM refinement if a model is selected and it's not already handled by Gemini translation refinedly
        if (llmModel && llmModel !== 'none') {
            console.log(`[API] Applying Gemini refinement with model: ${llmModel}`);
            resultText = await geminiRefine(text, resultText, from, to, llmModel, apiKey);
        }

        const unchanged = resultText.trim() === text.trim();
        if (unchanged) {
            console.warn('[Translate API] Warning: translated text is identical to the original', {
                from,
                to,
                original: text,
                translated: resultText,
            });
        } else {
            console.log('[Translate API] Success', {
                from,
                to,
                original: text,
                translated: resultText,
            });
        }


        if (useCache) writeTranslationCache(cacheKey, resultText);

        return new Response(JSON.stringify({ text: resultText }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = translationErrorStatus(error);
        const retryAfterMs = Number(error?.retryAfterMs) || (status === 429 ? 8000 : 0);
        console.warn("[Translate API] Request exhausted its retries", {
            message,
            status,
            retryAfterMs,
        });
        return new Response(JSON.stringify({ error: message, retryAfterMs }), {
            status,
            headers: {
                'Content-Type': 'application/json',
                ...(retryAfterMs ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } : {}),
            },
        });
    }
}
