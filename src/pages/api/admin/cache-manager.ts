import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasPermission } from '../../../lib/permissions';
import { invalidateCachedPage } from '../../../lib/render-cache';
import { getDb } from '../../../lib/db';
import { collections, entries, taxonomies, terms, settings } from '../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { getCanonicalUrls } from '../../../lib/queries';



/** Convert an R2 key like "rendered/anime/slug.html" back to a URL pathname. */
function keyToPathname(key: string): string {
    const withoutPrefix = key.replace(/^rendered/, '');
    const withoutExt = withoutPrefix.replace(/\.html$/, '');
    return withoutExt === '/index' ? '/' : withoutExt;
}

/** Purge the entire Cloudflare edge cache in a single fast API call. */
async function purgeEdgeEverything(env: any): Promise<boolean> {
    const zoneId = env?.CLOUDFLARE_ZONE_ID;
    const apiToken = env?.CLOUDFLARE_CACHE_TOKEN;
    if (!zoneId || !apiToken) return false;

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ purge_everything: true }),
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error('[cache-manager] Purge everything failed:', res.status, errText);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[cache-manager] Purge everything error:', err);
        return false;
    }
}

/** Purge Cloudflare edge cache for a list of absolute URLs. */
async function purgeEdgeUrls(env: any, urls: string[]): Promise<void> {
    const zoneId = env?.CLOUDFLARE_ZONE_ID;
    const apiToken = env?.CLOUDFLARE_CACHE_TOKEN;
    if (!zoneId || !apiToken || urls.length === 0) return;

    // Cloudflare Workers free plan caps subrequests to 50 per invocation.
    // If the URL list requires more than 20 subrequests (>600 URLs), use purge_everything
    // to prevent Worker subrequest limit exceptions.
    if (urls.length > 600) {
        await purgeEdgeEverything(env);
        return;
    }

    // CF purge API accepts max 30 URLs per request
    const chunks: string[][] = [];
    for (let i = 0; i < urls.length; i += 30) {
        chunks.push(urls.slice(i, i + 30));
    }
    
    // Process in batches of 5 concurrent requests with error catching
    for (let i = 0; i < chunks.length; i += 5) {
        await Promise.all(chunks.slice(i, i + 5).map(chunk =>
            fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ files: chunk }),
            }).catch(err => console.error('[cache-manager] Chunk purge error:', err))
        ));
    }
}

/** List all R2 keys under the rendered/ prefix, paginating with cursor. */
async function listAllRenderedKeys(renderCache: any): Promise<{ key: string; cachedAt: string | null }[]> {
    const results: { key: string; cachedAt: string | null }[] = [];
    let cursor: string | undefined;

    do {
        const opts: any = { prefix: 'rendered/', limit: 1000 };
        if (cursor) opts.cursor = cursor;
        const listed = await renderCache.list(opts);
        for (const obj of listed.objects) {
            results.push({
                key: obj.key,
                cachedAt: obj.customMetadata?.cachedAt ?? null,
            });
        }
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return results;
}

export const POST: APIRoute = async (ctx) => {
    const { locals, request } = ctx;
    const user = locals.user;
    const permissions = locals.permissions;

    if (!user || !permissions) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    if (!hasPermission(permissions, 'system', 'read')) {
        return new Response(JSON.stringify({ error: 'Forbidden: system permission required' }), { status: 403 });
    }

    if (!(env as any)?.RENDER_CACHE) {
        return new Response(JSON.stringify({ error: 'Render cache not configured in this environment.' }), { status: 503 });
    }

    let body: any;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
    }

    const { action } = body;

    // Resolve the canonical site origin from settings, falling back to the
    // origin of the current request. This avoids any hardcoded domain.
    let siteOrigin = new URL(request.url).origin;
    try {
        const db = getDb(env);
        const settingsRow = await db.select().from(settings).where(eq(settings.key, 'general_settings')).limit(1);
        if (settingsRow.length > 0) {
            const parsed = JSON.parse(settingsRow[0].value);
            if (parsed.siteUrl) siteOrigin = parsed.siteUrl.replace(/\/$/, '');
        }
    } catch { /* use request origin fallback */ }

    // ── A. Purge a specific URL ──────────────────────────────────────────────
    if (action === 'purge_url') {
        let { path } = body;
        if (!path || typeof path !== 'string') {
            return new Response(JSON.stringify({ error: 'path is required' }), { status: 400 });
        }
        // Normalise: strip trailing slash, ensure leading slash
        path = '/' + path.replace(/^\//, '').replace(/\/$/, '');

        try {
            await invalidateCachedPage(env, [path]);
            return new Response(JSON.stringify({ success: true, purged: [path] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // ── B. Purge all cached /search/* keys (one-time cleanup) ────────────────
    if (action === 'purge_search') {
        try {
            // Use paginated listing to catch more than 1000 search keys
            const allKeys: string[] = [];
            let cursor: string | undefined;
            do {
                const opts: any = { prefix: 'rendered/search', limit: 1000 };
                if (cursor) opts.cursor = cursor;
                const listed = await (env as any).RENDER_CACHE.list(opts);
                for (const o of listed.objects) allKeys.push(o.key);
                cursor = listed.truncated ? listed.cursor : undefined;
            } while (cursor);

            if (allKeys.length === 0) {
                return new Response(JSON.stringify({ success: true, deleted: 0, message: 'No search keys found in R2.' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            // Delete from R2 in batches of 1000
            for (let i = 0; i < allKeys.length; i += 1000) {
                await (env as any).RENDER_CACHE.delete(allKeys.slice(i, i + 1000));
            }

            // Purge CF edge for each URL
            const pathnames = allKeys.map((k: string) => k.replace(/^rendered/, '').replace(/\.html$/, ''));
            const urls = pathnames.map((p: string) => `${siteOrigin}${p}`);
            await purgeEdgeUrls(env, urls);

            return new Response(JSON.stringify({ success: true, deleted: allKeys.length, paths: pathnames }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // ── C. Scoped bulk purge by R2 cachedAt timestamp ────────────────────────
    if (action === 'purge_scoped') {
        const { window: windowStr } = body; // '1h' | '24h' | '7d' | '30d' | 'all'
        const windowMs: Record<string, number> = {
            '1h':  60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '7d':  7 * 24 * 60 * 60 * 1000,
            '30d': 30 * 24 * 60 * 60 * 1000,
            'all': Infinity,
        };
        const ms = windowMs[windowStr];
        if (ms === undefined) {
            return new Response(JSON.stringify({ error: 'Invalid window. Use: 1h, 24h, 7d, 30d, all' }), { status: 400 });
        }

        try {
            const allKeys = await listAllRenderedKeys((env as any).RENDER_CACHE);
            const cutoff = Date.now() - (ms === Infinity ? 0 : ms);

            const matching = ms === Infinity
                ? allKeys
                : allKeys.filter(k => {
                    if (!k.cachedAt) return false;
                    return new Date(k.cachedAt).getTime() >= cutoff;
                });

            if (matching.length === 0) {
                return new Response(JSON.stringify({ success: true, deleted: 0, paths: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            // Delete R2 keys in batches of 1000 (R2 bulk delete support)
            const keyStrings = matching.map(k => k.key);
            for (let i = 0; i < keyStrings.length; i += 1000) {
                await (env as any).RENDER_CACHE.delete(keyStrings.slice(i, i + 1000));
            }

            const pathnames = matching.map(k => keyToPathname(k.key));
            const urls = pathnames.map(p => `${siteOrigin}${p}`);
            await purgeEdgeUrls(env, urls);

            return new Response(JSON.stringify({ success: true, deleted: matching.length, paths: pathnames }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // ── D1. Purge By Collection ───────────────────────────────────────────────
    if (action === 'purge_collection') {
        try {
            const { collectionSlug } = body;
            const db = getDb(env);
            const colMatch = await db.select().from(collections).where(eq(collections.slug, collectionSlug)).limit(1);
            if (colMatch.length === 0) return new Response(JSON.stringify({ error: 'Collection not found' }), { status: 404 });
            
            // Only published entries are ever rendered to R2 — filter to match
            const entriesData = await db.select({ id: entries.id, slug: entries.slug })
                .from(entries)
                .where(and(eq(entries.collectionId, colMatch[0].id), eq(entries.status, 'published')));
            
            const r2Keys: string[] = [];
            const edgeUrls: string[] = [];
            
            // Always include the collection archive page itself
            r2Keys.push(`rendered/${collectionSlug}.html`);
            edgeUrls.push(`${siteOrigin}/${collectionSlug}`);

            if (entriesData.length > 0) {
                if (entriesData.length <= 300) {
                    // Small collection: query canonical URLs and purge individual edge URLs
                    const canonicalMap = await getCanonicalUrls(db, entriesData.map(e => e.id));
                    for (const e of entriesData) {
                        const prefix = canonicalMap[e.id];
                        const path = prefix ? `/${prefix}/${e.slug}` : `/${e.slug}`;
                        r2Keys.push(`rendered${path}.html`);
                        edgeUrls.push(`${siteOrigin}${path}`);
                    }
                } else {
                    // Large collection: skip expensive batched D1 queries.
                    // Add root and collection-prefixed keys directly.
                    for (const e of entriesData) {
                        r2Keys.push(`rendered/${e.slug}.html`);
                        r2Keys.push(`rendered/${collectionSlug}/${e.slug}.html`);
                    }
                }
            }
            
            // Also sweep the collection's archive prefix to catch paginated pages
            // e.g. rendered/articles/page/2.html, rendered/articles/page/3.html ...
            // These are not knowable without listing R2 under the prefix.
            {
                let cursor: string | undefined;
                do {
                    const opts: any = { prefix: `rendered/${collectionSlug}/`, limit: 1000 };
                    if (cursor) opts.cursor = cursor;
                    const listed = await (env as any).RENDER_CACHE.list(opts);
                    for (const o of listed.objects) r2Keys.push(o.key);
                    cursor = listed.truncated ? listed.cursor : undefined;
                } while (cursor);
            }

            // Deduplicate R2 keys before deletion
            const uniqueKeys = Array.from(new Set(r2Keys));

            // Delete from R2 in bulk
            for (let i = 0; i < uniqueKeys.length; i += 1000) {
                await (env as any).RENDER_CACHE.delete(uniqueKeys.slice(i, i + 1000));
            }
            
            // Purge Edge Cache
            let edgePurged = 0;
            if (entriesData.length <= 300 && edgeUrls.length > 0) {
                await purgeEdgeUrls(env, edgeUrls);
                edgePurged = edgeUrls.length;
            } else if (entriesData.length > 300) {
                // For large collections, purge the entire edge cache in 1 fast subrequest
                await purgeEdgeEverything(env);
                edgePurged = uniqueKeys.length;
            }
            
            return new Response(JSON.stringify({ 
                success: true, 
                deleted: uniqueKeys.length,
                edgePurged,
                note: entriesData.length > 300 ? 'All edge cache purged (collection size exceeds subrequest limit for per-URL purge).' : undefined
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // ── D2. Purge By Taxonomy ─────────────────────────────────────────────────
    if (action === 'purge_taxonomy') {
        try {
            const { taxonomySlug } = body;
            const db = getDb(env);
            const taxMatch = await db.select().from(taxonomies).where(eq(taxonomies.slug, taxonomySlug)).limit(1);
            if (taxMatch.length === 0) return new Response(JSON.stringify({ error: 'Taxonomy not found' }), { status: 404 });
            
            const tax = taxMatch[0];
            const termsData = await db.select({ slug: terms.slug }).from(terms).where(eq(terms.taxonomyId, tax.id));
            
            const r2Keys: string[] = [];
            const edgeUrls: string[] = [];
            
            // Always include the taxonomy umbrella archive page
            r2Keys.push(`rendered/${taxonomySlug}.html`);
            edgeUrls.push(`${siteOrigin}/${taxonomySlug}`);

            for (const t of termsData) {
                const path = tax.omitTaxonomySlug ? `/${t.slug}` : `/${tax.slug}/${t.slug}`;
                r2Keys.push(`rendered${path}.html`);
                if (termsData.length <= 300) {
                    edgeUrls.push(`${siteOrigin}${path}`);
                }
            }
            
            // Sweep R2 to catch paginated term archive pages (e.g. rendered/kategori/anime/page/2.html)
            if (!tax.omitTaxonomySlug) {
                // If taxonomy has a prefix (e.g. /kategori/), one single sweep covers all terms!
                let cursor: string | undefined;
                do {
                    const opts: any = { prefix: `rendered/${tax.slug}/`, limit: 1000 };
                    if (cursor) opts.cursor = cursor;
                    const listed = await (env as any).RENDER_CACHE.list(opts);
                    for (const o of listed.objects) r2Keys.push(o.key);
                    cursor = listed.truncated ? listed.cursor : undefined;
                } while (cursor);
            } else {
                // When omitTaxonomySlug is true, sweep each term prefix (max 50 terms to protect subrequest limit)
                const termsToSweep = termsData.slice(0, 50);
                for (const t of termsToSweep) {
                    let cursor: string | undefined;
                    do {
                        const opts: any = { prefix: `rendered/${t.slug}/`, limit: 1000 };
                        if (cursor) opts.cursor = cursor;
                        const listed = await (env as any).RENDER_CACHE.list(opts);
                        for (const o of listed.objects) r2Keys.push(o.key);
                        cursor = listed.truncated ? listed.cursor : undefined;
                    } while (cursor);
                }
            }

            const uniqueKeys = Array.from(new Set(r2Keys));

            // Delete from R2 in bulk
            for (let i = 0; i < uniqueKeys.length; i += 1000) {
                await (env as any).RENDER_CACHE.delete(uniqueKeys.slice(i, i + 1000));
            }

            let edgePurged = 0;
            if (termsData.length <= 300 && edgeUrls.length > 0) {
                await purgeEdgeUrls(env, edgeUrls);
                edgePurged = edgeUrls.length;
            } else if (termsData.length > 300) {
                await purgeEdgeEverything(env);
                edgePurged = uniqueKeys.length;
            }
            
            return new Response(JSON.stringify({ 
                success: true, 
                deleted: uniqueKeys.length,
                edgePurged,
                note: termsData.length > 300 ? 'All edge cache purged (taxonomy size exceeds subrequest limit for per-URL purge).' : undefined
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // ── E. Purge everything ──────────────────────────────────────────────────
    if (action === 'purge_all') {
        try {
            const allKeys = await listAllRenderedKeys((env as any).RENDER_CACHE);

            // Delete all R2 keys in batches of 1000
            const keyStrings = allKeys.map(k => k.key);
            for (let i = 0; i < keyStrings.length; i += 1000) {
                await (env as any).RENDER_CACHE.delete(keyStrings.slice(i, i + 1000));
            }

            // Purge Cloudflare edge cache completely in ONE fast API call
            const edgePurged = await purgeEdgeEverything(env);

            return new Response(JSON.stringify({ 
                success: true, 
                deleted: allKeys.length,
                edgePurged 
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
};
