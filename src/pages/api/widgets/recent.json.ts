import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { entries, collections, taxonomies, terms, entryTerms } from '../../../db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getCanonicalUrls } from '../../../lib/queries';

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);

    // Parse query params
    const taxSlug = url.searchParams.get('tax') || 'all';
    const termsParam = url.searchParams.get('terms') || 'all';
    const limitParam = parseInt(url.searchParams.get('limit') || '50');
    const limit = Math.min(100, Math.max(1, limitParam)); // Cap at 100 max for the pool

    // ── Cloudflare Cache API ──────────────────────────────────────────────────
    // s-maxage alone does NOT cache Worker responses at the CF edge (cf-cache-status
    // stays DYNAMIC). We must use caches.default explicitly so D1 is only hit
    // once per day per unique param combination (tax + terms + limit).
    const CF_CACHE_TTL = 86400; // 24 hours
    const cfCache = (typeof caches !== 'undefined') ? caches.default : null;
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    if (cfCache) {
        const cached = await cfCache.match(cacheKey);
        if (cached) return cached;
    }
    // ── Cache MISS — fall through to D1 ──────────────────────────────────────

    const db = getDb(env as any);
    
    try {
        // Step 1: Get the articles collection — PK lookup via slug unique index, 1 row read
        const articlesCol = await db.select({ id: collections.id, entryCount: collections.entryCount })
            .from(collections).where(eq(collections.slug, 'articles')).limit(1);
        if (articlesCol.length === 0) {
            return new Response(JSON.stringify([]), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400' }
            });
        }

        const collectionId = articlesCol[0].id;
        let entryIds: number[] = [];

        // Step 2: Fetch entry IDs only (narrow select) — uses entries_collection_status_id_idx
        if (taxSlug !== 'all' && termsParam !== 'all') {
            const termIds = termsParam.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));

            if (termIds.length > 0) {
                // Two-step approach: first get matching entry_ids via term index,
                // then filter by collection + status using the composite index.
                // Avoids the JOIN+GROUP BY full-scan pattern entirely.
                const etRows = await db.select({ entryId: entryTerms.entryId })
                    .from(entryTerms)
                    .where(inArray(entryTerms.termId, termIds));

                const candidateIds = Array.from(new Set(etRows.map(r => r.entryId)));

                if (candidateIds.length > 0) {
                    // Sort descending (highest ID = newest) before chunking
                    candidateIds.sort((a, b) => b - a);

                    // Step 3: Pure PK lookup — id IN (chunk) ONLY.
                    const D1_CHUNK = 50;
                    let confirmedRows: { id: number, collectionId: number, status: string }[] = [];
                    for (let i = 0; i < candidateIds.length; i += D1_CHUNK) {
                        const chunk = candidateIds.slice(i, i + D1_CHUNK);
                        const rows = await db.select({ id: entries.id, collectionId: entries.collectionId, status: entries.status })
                            .from(entries)
                            .where(inArray(entries.id, chunk));
                            
                        const valid = rows.filter(r => r.collectionId === collectionId && r.status === 'published');
                        confirmedRows = confirmedRows.concat(valid);
                        
                        if (confirmedRows.length >= limit) {
                            break; // Stop fetching chunks once we have enough for this widget!
                        }
                    }
                    
                    confirmedRows.sort((a, b) => b.id - a.id);
                    entryIds = confirmedRows.slice(0, limit).map(r => r.id);
                }
            }
        } else {
            // No term filter — use composite index directly
            const idRows = await db.select({ id: entries.id })
                .from(entries)
                .where(and(
                    eq(entries.collectionId, collectionId),
                    eq(entries.status, 'published')
                ))
                .orderBy(desc(entries.id))
                .limit(limit);
            entryIds = idRows.map(r => r.id);
        }

        if (entryIds.length === 0) {
            return new Response(JSON.stringify([]), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400' }
            });
        }

        // Step 3: Fetch full entry data — PK lookups only, no scan
        const D1_CHUNK = 50;
        let entryRows: any[] = [];
        for (let i = 0; i < entryIds.length; i += D1_CHUNK) {
            const chunk = entryIds.slice(i, i + D1_CHUNK);
            const rows = await db.select().from(entries).where(inArray(entries.id, chunk));
            entryRows = entryRows.concat(rows);
        }
        // Restore sort order after chunked fetches
        const entryMap = new Map(entryRows.map(e => [e.id, e]));
        const sortedEntries = entryIds.map(id => entryMap.get(id)).filter(Boolean);

        // Step 4: Fetch category names — separate queries, no JOIN+IN scan
        let categoryMap: Record<number, any[]> = {};
        if (entryIds.length > 0) {
            // 4a: Get all entry_terms for these entries — uses entry_terms PK index
            const etRows = await db.select().from(entryTerms).where(inArray(entryTerms.entryId, entryIds));
            const termIds = Array.from(new Set(etRows.map(r => r.termId)));

            if (termIds.length > 0) {
                // 4b: Fetch the terms — PK lookups only
                const tRows = await db.select({ id: terms.id, name: terms.name, taxonomyId: terms.taxonomyId })
                    .from(terms).where(inArray(terms.id, termIds));

                // 4c: Get taxonomy IDs to filter by 'categories' only
                const taxIds = Array.from(new Set(tRows.map(t => t.taxonomyId)));
                const taxRows = taxIds.length > 0
                    ? await db.select({ id: taxonomies.id, slug: taxonomies.slug })
                        .from(taxonomies).where(inArray(taxonomies.id, taxIds))
                    : [];
                const catTaxIds = new Set(taxRows.filter(t => t.slug === 'categories').map(t => t.id));

                // JS join — zero DB reads
                const termMap = new Map(tRows.filter(t => catTaxIds.has(t.taxonomyId)).map(t => [t.id, t]));
                for (const r of etRows) {
                    const t = termMap.get(r.termId);
                    if (!t) continue;
                    if (!categoryMap[r.entryId]) categoryMap[r.entryId] = [];
                    categoryMap[r.entryId].push({ id: t.id, name: t.name });
                }
            }
        }

        // Step 5: Batch-fetch canonical URLs (already optimized in getCanonicalUrls)
        const canonicalUrlMap = await getCanonicalUrls(db, entryIds);

        // Step 6: Format output
        const formattedArticles = sortedEntries.map((entry: any) => {
            const data = JSON.parse(entry.data || '{}');
            const rawContent = data.content || '';
            const textOnly = rawContent.replace(/<[^>]+>/g, '').replace(/\[caption[^\]]*\]|\/caption\]/g, '').trim();
            const excerpt = textOnly.length > 80 ? textOnly.substring(0, 80) + '...' : textOnly;
            
            const prefixSlug = canonicalUrlMap[entry.id];
            const canonicalUrl = prefixSlug ? `${prefixSlug}/${entry.slug}` : entry.slug;
            
            let categoryName = '';
            const cats = categoryMap[entry.id] || [];
            if (cats.length > 0) {
                const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                categoryName = primary ? primary.name : cats[0].name;
            }

            return { 
                id: entry.id, 
                slug: entry.slug, 
                canonicalUrl: `/${canonicalUrl}`, 
                publishedAt: entry.publishedAt, 
                title: data.title,
                featuredImageUrl: data.featuredImageUrl,
                content: rawContent,
                categoryName, 
                excerpt 
            };
        });

        // Store in Cloudflare Cache API so subsequent calls are edge-served (zero D1)
        const response = new Response(JSON.stringify(formattedArticles), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, s-maxage=${CF_CACHE_TTL}, stale-while-revalidate=${CF_CACHE_TTL}`
            }
        });

        if (cfCache) {
            // waitUntil-style: store in background, don't block the response
            cfCache.put(cacheKey, response.clone()).catch(() => {});
        }

        return response;

    } catch (e: any) {
        console.error("Error generating recent.json cache:", e);
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    }
};
