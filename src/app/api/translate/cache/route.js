import {
    clearPersistentTranslationCache,
    translationCacheStats,
    verifyTranslationCacheDirectory,
} from '@/lib/translation-cache';

function requestedDirectory(request) {
    return new URL(request.url).searchParams.get('directory') || '';
}

export async function GET(request) {
    try {
        const directory = await verifyTranslationCacheDirectory(requestedDirectory(request));
        return Response.json(await translationCacheStats(directory));
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
}

export async function DELETE(request) {
    try {
        const directory = await verifyTranslationCacheDirectory(requestedDirectory(request));
        return Response.json(await clearPersistentTranslationCache(directory));
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
}
