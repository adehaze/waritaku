import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { entries, terms, entryTerms } from '../../../db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getCanonicalUrls, getAllCollectionsCached, getAllTaxonomiesCached, resolveEntryDisplayFields } from '../../../lib/queries';
import { serveStoredResponse } from '../../../lib/stored-response';

export const GET: APIRoute = async (ctx) => {
    const url = new URL(ctx.request.url);

    const taxSlug = (url.searchParams.get('tax') || 'all').replace(/[^a-zA-Z0-9_-]/g, '');
    const termsParam = (url.searchParams.get('terms') || 'all').replace(/[^0-9,a-zA-Z_-]/g, '');
    const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 50 : limitParam));

    const CF_CACHE_TTL = 3600;
    const cfCache = (typeof caches !== 'undefined') ? (caches as any).default : null;
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    if (cfCache) {
        const cached = await cfCache.match(cacheKey);
        if (cached) return cached;
    }

    const r2Key = `widget-recent-v2-${taxSlug}-${termsParam}-${limit}.json`;
    const response = await serveStoredResponse(
        env,
        r2Key,
        CF_CACHE_TTL,
        'application/json; charset=utf-8',
        () => buildRecentWidgetResponse(taxSlug, termsParam, limit),
        (ctx.locals as any)?.cfContext
    );

    if (cfCache && response.status === 200) {
        cfCache.put(cacheKey, response.clone()).catch(() => {});
    }

    return response;
};

async function buildRecentWidgetResponse(taxSlug: string, termsParam: string, limit: number): Promise<Response> {
    const db = getDb(env as any);

    const allCollections = await getAllCollectionsCached(db);
    const contentCols = allCollections.filter((c: any) => c.slug !== 'pages');
    if (contentCols.length === 0) {
        return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    const primaryCollection = contentCols.find((c: any) => c.slug === 'articles') || contentCols[0];
    const collectionId = primaryCollection.id;
    const collectionById = new Map(allCollections.map((c: any) => [c.id, c]));
    let entryIds: number[] = [];

    if (taxSlug !== 'all' && termsParam !== 'all') {
        const termIds = termsParam.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id)).slice(0, 10);

        if (termIds.length > 0) {
            // Query each termId with ORDER BY entry_id DESC LIMIT (limit + 15)
            // Uses covering index entry_terms_term_entry_idx (term_id, entry_id) with zero table lookups!
            const perTermLimit = limit + 15;
            const candidateSet = new Set<number>();
            for (const tid of termIds) {
                const rows = await db.select({ entryId: entryTerms.entryId })
                    .from(entryTerms)
                    .where(eq(entryTerms.termId, tid))
                    .orderBy(desc(entryTerms.entryId))
                    .limit(perTermLimit);
                for (const r of rows) candidateSet.add(r.entryId);
            }

            const candidateIds = Array.from(candidateSet).sort((a, b) => b - a);

            if (candidateIds.length > 0) {
                const D1_CHUNK = 50;
                let confirmedRows: { id: number; collectionId: number; status: string }[] = [];
                for (let i = 0; i < candidateIds.length; i += D1_CHUNK) {
                    const chunk = candidateIds.slice(i, i + D1_CHUNK);
                    const rows = await db.select({ id: entries.id, collectionId: entries.collectionId, status: entries.status })
                        .from(entries)
                        .where(inArray(entries.id, chunk));

                    const valid = rows.filter(r => r.collectionId === collectionId && r.status === 'published');
                    confirmedRows = confirmedRows.concat(valid);

                    if (confirmedRows.length >= limit) {
                        break;
                    }
                }

                confirmedRows.sort((a, b) => b.id - a.id);
                entryIds = confirmedRows.slice(0, limit).map(r => r.id);
            }
        }
    } else {
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
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    const D1_CHUNK = 50;
    let entryRows: any[] = [];
    for (let i = 0; i < entryIds.length; i += D1_CHUNK) {
        const chunk = entryIds.slice(i, i + D1_CHUNK);
        const rows = await db.select().from(entries).where(inArray(entries.id, chunk));
        entryRows = entryRows.concat(rows);
    }
    const entryMap = new Map(entryRows.map(e => [e.id, e]));
    const sortedEntries = entryIds.map(id => entryMap.get(id)).filter(Boolean);

    let categoryMap: Record<number, any[]> = {};
    if (entryIds.length > 0) {
        const etRows: any[] = [];
        for (let i = 0; i < entryIds.length; i += D1_CHUNK) {
            const chunk = entryIds.slice(i, i + D1_CHUNK);
            const rows = await db.select().from(entryTerms).where(inArray(entryTerms.entryId, chunk));
            etRows.push(...rows);
        }
        const termIds = Array.from(new Set(etRows.map(r => r.termId)));

        if (termIds.length > 0) {
            const tRows: any[] = [];
            for (let t = 0; t < termIds.length; t += 90) {
                const rows = await db.select({ id: terms.id, name: terms.name, taxonomyId: terms.taxonomyId })
                    .from(terms).where(inArray(terms.id, termIds.slice(t, t + 90)));
                tRows.push(...rows);
            }

            const allTaxonomies = await getAllTaxonomiesCached(db);
            const catTaxIds = new Set(allTaxonomies.filter((t: any) => t.slug === 'categories').map((t: any) => t.id));

            const termMap = new Map(tRows.filter(t => catTaxIds.size === 0 || catTaxIds.has(t.taxonomyId)).map(t => [t.id, t]));
            for (const r of etRows) {
                const t = termMap.get(r.termId);
                if (!t) continue;
                if (!categoryMap[r.entryId]) categoryMap[r.entryId] = [];
                categoryMap[r.entryId].push({ id: t.id, name: t.name });
            }
        }
    }

    const canonicalUrlMap = await getCanonicalUrls(db, entryIds, allCollections);

    const formattedArticles = sortedEntries.map((entry: any) => {
        let data: any = {};
        try { data = JSON.parse(entry.data || '{}'); } catch {}
        const col = collectionById.get(entry.collectionId) || primaryCollection;
        const displayFields = resolveEntryDisplayFields(entry, data, col);
        const excerpt = displayFields.excerpt && displayFields.excerpt.length > 85
            ? displayFields.excerpt.substring(0, 80) + '...'
            : (displayFields.excerpt || '');

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
            title: displayFields.title,
            featuredImageUrl: displayFields.featuredImageUrl,
            content: '',
            categoryName,
            excerpt
        };
    });

    return new Response(JSON.stringify(formattedArticles), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}
