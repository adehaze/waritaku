/**
 * Stored Response (R2)
 *
 * Keeps generated XML/text responses (sitemaps) in the R2 render-cache bucket
 * under the key prefix `generated/`. Visitors and crawlers read the stored copy,
 * so D1 is only queried when the copy is missing or older than the TTL.
 *
 * If the build function fails (for example D1 is over its limit), the function
 * serves the old stored copy instead of an error.
 *
 * All functions are no-ops when env.RENDER_CACHE is absent (local dev).
 */

export async function serveStoredResponse(
    env: any,
    key: string,
    ttlSeconds: number,
    contentType: string,
    build: () => Promise<Response>,
    ctx?: { waitUntil?: (p: Promise<any>) => void }
): Promise<Response> {
    const bucket = env?.RENDER_CACHE;
    const storeKey = `generated/${key}`;
    const headers = {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${Math.min(ttlSeconds, 3600)}`,
    };

    // Local dev or no binding: build every time.
    if (!bucket || import.meta.env.DEV) return build();

    let stale: R2ObjectBody | null = null;
    try {
        const stored = await bucket.get(storeKey);
        if (stored) {
            const cachedAt = Date.parse(stored.customMetadata?.cachedAt || '') || 0;
            if (Date.now() - cachedAt < ttlSeconds * 1000) {
                return new Response(stored.body, { status: 200, headers: { ...headers, 'X-Cache': 'HIT' } });
            }
            stale = stored;
        }
    } catch (err) {
        console.error('[stored-response] read error:', err);
    }

    // Copy the stale body now. A stream cannot be read twice.
    const staleText = stale ? await stale.text() : null;

    try {
        const fresh = await build();
        if (fresh.status !== 200) throw new Error(`build returned ${fresh.status}`);
        const body = await fresh.text();
        const save = bucket.put(storeKey, body, {
            httpMetadata: { contentType },
            customMetadata: { cachedAt: new Date().toISOString() },
        }).catch((err: unknown) => console.error('[stored-response] write error:', err));
        if (ctx?.waitUntil) ctx.waitUntil(save); else await save;
        return new Response(body, { status: 200, headers: { ...headers, 'X-Cache': 'MISS' } });
    } catch (err) {
        console.error('[stored-response] build error:', err);
        if (staleText !== null) {
            return new Response(staleText, { status: 200, headers: { ...headers, 'X-Cache': 'STALE' } });
        }
        return new Response('Service temporarily unavailable', { status: 503, headers: { 'Retry-After': '300' } });
    }
}

/** Delete all stored sitemap copies. Call this after content changes. */
export async function invalidateStoredResponses(env: any, keys: string[]): Promise<void> {
    if (!env?.RENDER_CACHE || import.meta.env.DEV) return;
    try {
        await Promise.all(keys.map(k => env.RENDER_CACHE.delete(`generated/${k}`)));
    } catch (err) {
        console.error('[stored-response] invalidate error:', err);
    }
}
