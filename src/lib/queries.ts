import { eq, and, sql, desc, inArray, gte, lte, ne, exists } from 'drizzle-orm';
import { entries, collections, users, terms, taxonomies, entryTerms, settings } from '../db/schema';

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
    if (!json) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
}

// Shared edge-cached read of the collections table (10 min TTL).
export async function getAllCollectionsCached(db: any): Promise<any[]> {
    const KEY = 'https://waritaku.internal/cache/all_collections';
    let list: any[] = [];
    const hit = (typeof caches !== 'undefined') ? await caches.default.match(new Request(KEY)) : null;
    if (hit) { try { list = await hit.json(); } catch {} }
    if (list.length === 0) {
        list = await db.select().from(collections);
        if (typeof caches !== 'undefined' && list.length > 0) {
            caches.default.put(new Request(KEY), new Response(JSON.stringify(list), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' }
            })).catch(() => {});
        }
    }
    return list;
}

// Batched version of getCanonicalUrl — no JOINs anywhere.
// All three lookups (entry_terms, terms, taxonomies) are separate PK queries
// joined in JS. This avoids the SQLite planner choosing a JOIN full-scan over
// individual PK index lookups.
// allCollections is passed in from the caller (already CF-cached) so we never
// fetch collections from D1 inside this function.
export async function getCanonicalUrls(
    db: any,
    entryIds: number[],
    allCollections?: any[]
): Promise<Record<number, string>> {
    if (!entryIds.length) return {};

    // ── Step A: Fetch taxonomies once — tiny table, cache in CF edge ──────────
    const TAX_CACHE_KEY = 'https://waritaku.internal/cache/taxonomies';
    const TAX_CACHE_TTL = 1800; // 30 minutes — taxonomies almost never change
    let allTaxonomies: any[] = [];
    const cfTaxCache = (typeof caches !== 'undefined')
        ? await caches.default.match(new Request(TAX_CACHE_KEY)) : null;
    if (cfTaxCache) {
        try { allTaxonomies = await cfTaxCache.json(); } catch {}
    }
    if (allTaxonomies.length === 0) {
        allTaxonomies = await db.select({
            id: taxonomies.id, slug: taxonomies.slug, entryUrlFormat: taxonomies.entryUrlFormat
        }).from(taxonomies);
        if (typeof caches !== 'undefined' && allTaxonomies.length > 0) {
            caches.default.put(new Request(TAX_CACHE_KEY), new Response(JSON.stringify(allTaxonomies), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TAX_CACHE_TTL}` }
            })).catch(() => {});
        }
    }
    const taxById = new Map(allTaxonomies.map((t: any) => [t.id, t]));

    // ── Step B: Build collections map. If the caller did not pass collections,
    // load them from the CF edge cache (D1 only on a cold cache). This keeps
    // taxonomy priority (collections.supports) correct for every caller.
    const collectionList = (allCollections && allCollections.length > 0)
        ? allCollections
        : await getAllCollectionsCached(db);
    const collectionById = new Map(collectionList.map((c: any) => [c.id, c]));

    // ── Process entryIds in chunks of 50 ─────────────────────────────────────
    const D1_SAFE_CHUNK = 50;
    const merged: Record<number, string> = {};

    for (let i = 0; i < entryIds.length; i += D1_SAFE_CHUNK) {
        const chunk = entryIds.slice(i, i + D1_SAFE_CHUNK);

        // Step 1: entry_terms for this chunk — uses (entryId, termId) PK index
        const etRows = await db.select({ entryId: entryTerms.entryId, termId: entryTerms.termId })
            .from(entryTerms)
            .where(inArray(entryTerms.entryId, chunk));

        const termIds = Array.from(new Set(etRows.map((r: any) => r.termId))) as number[];

        // Step 2: terms by PK — id is the primary key, pure PK lookup
        const termRows = termIds.length > 0
            ? await db.select({ id: terms.id, slug: terms.slug, taxonomyId: terms.taxonomyId })
                .from(terms).where(inArray(terms.id, termIds))
            : [];

        // Step 3: entries by PK — fetch data + collectionId, no JOIN to collections
        const entryRows = await db.select({ id: entries.id, data: entries.data, collectionId: entries.collectionId })
            .from(entries)
            .where(inArray(entries.id, chunk));

        // ── JS joins (zero D1 reads) ──────────────────────────────────────────
        const termById = new Map(termRows.map((t: any) => [t.id, t]));

        // Build entryData map (data JSON + supports from cached collections)
        const entryDataMap: Record<number, { data: string, supports: string }> = {};
        for (const e of entryRows) {
            const col = collectionById.get(e.collectionId);
            entryDataMap[e.id] = { data: e.data || '{}', supports: col?.supports || '{}' };
        }

        // Group terms by entry
        const byEntry: Record<number, any[]> = {};
        for (const et of etRows) {
            const term = termById.get(et.termId);
            if (!term) continue;
            const tax = taxById.get(term.taxonomyId);
            if (!tax || tax.entryUrlFormat === 'none') continue;
            if (!byEntry[et.entryId]) byEntry[et.entryId] = [];
            byEntry[et.entryId].push({
                termId: term.id,
                termSlug: term.slug,
                taxonomySlug: tax.slug,
                entryUrlFormat: tax.entryUrlFormat,
                supports: entryDataMap[et.entryId]?.supports || '{}',
                entryData: entryDataMap[et.entryId]?.data || '{}'
            });
        }

        const formatPrefix = (match: any) =>
            match.entryUrlFormat === 'long'
                ? `${match.taxonomySlug}/${match.termSlug}`
                : match.termSlug;

        for (const entryIdStr of Object.keys(byEntry)) {
            const entryId = parseInt(entryIdStr, 10);
            const rows = byEntry[entryId];
            if (!rows || rows.length === 0) continue;

            const parsedData = safeJsonParse(rows[0].entryData, {} as any);

            const termOverride = parsedData.primaryTermId;
            if (termOverride) {
                const overrideMatch = rows.find((r: any) =>
                    r.termId === termOverride || r.termId.toString() === termOverride.toString());
                if (overrideMatch) { merged[entryId] = formatPrefix(overrideMatch); continue; }
            }

            const taxOverride = parsedData.primaryTaxonomyOverride;
            if (taxOverride) {
                const overrideMatch = rows.find((r: any) => r.taxonomySlug === taxOverride);
                if (overrideMatch) { merged[entryId] = formatPrefix(overrideMatch); continue; }
            }

            let supportsData: any = {};
            try { supportsData = JSON.parse(rows[0].supports || '{}'); } catch {}
            const priorityArray: string[] = supportsData.taxonomies || [];

            rows.sort((a: any, b: any) => {
                const idxA = priorityArray.indexOf(a.taxonomySlug);
                const idxB = priorityArray.indexOf(b.taxonomySlug);
                return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
            });
            merged[entryId] = formatPrefix(rows[0]);
        }
    }

    return merged;
}


export const getCanonicalUrl = async (db: any, entryId: number, entrySlug: string) => {
    // Split into two queries to avoid full table scan
    const termsResults = await db.select({
        termId: terms.id,
        termSlug: terms.slug,
        taxonomySlug: taxonomies.slug,
        entryUrlFormat: taxonomies.entryUrlFormat,
    })
    .from(entryTerms)
    .innerJoin(terms, eq(entryTerms.termId, terms.id))
    .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
    .where(eq(entryTerms.entryId, entryId));
    
    if (termsResults.length > 0) {
        const entriesResults = await db.select({
            data: entries.data,
            supports: collections.supports
        })
        .from(entries)
        .innerJoin(collections, eq(entries.collectionId, collections.id))
        .where(eq(entries.id, entryId))
        .limit(1);

        const entryData = entriesResults[0]?.data || '{}';
        const supports = entriesResults[0]?.supports || '{}';

        const prefixRes = termsResults.map((r: any) => ({
            termId: r.termId,
            termSlug: r.termSlug,
            taxonomySlug: r.taxonomySlug,
            entryUrlFormat: r.entryUrlFormat,
            supports: supports,
            entryData: entryData
        })).filter((r: any) => r.entryUrlFormat !== 'none');

        if (prefixRes.length === 0) return entrySlug;

        const formatPrefix = (match: any) => match.entryUrlFormat === 'long' ? `${match.taxonomySlug}/${match.termSlug}` : match.termSlug;

        const parsedData = safeJsonParse(prefixRes[0].entryData, {} as any);
        const termOverride = parsedData.primaryTermId;
        if (termOverride) {
            const overrideMatch = prefixRes.find((r: any) => r.termId === termOverride || r.termId.toString() === termOverride.toString());
            if (overrideMatch) return `${formatPrefix(overrideMatch)}/${entrySlug}`;
        }
        
        const override = parsedData.primaryTaxonomyOverride;
        if (override) {
            const overrideMatch = prefixRes.find((r: any) => r.taxonomySlug === override);
            if (overrideMatch) return `${formatPrefix(overrideMatch)}/${entrySlug}`;
        }

        let supportsData: any = {};
        try { supportsData = JSON.parse(prefixRes[0].supports || '{}'); } catch(e) {}
        const priorityArray: string[] = supportsData.taxonomies || [];

        prefixRes.sort((a: any, b: any) => {
            const idxA = priorityArray.indexOf(a.taxonomySlug);
            const idxB = priorityArray.indexOf(b.taxonomySlug);
            const rankA = idxA === -1 ? 999 : idxA;
            const rankB = idxB === -1 ? 999 : idxB;
            return rankA - rankB;
        });

        return `${formatPrefix(prefixRes[0])}/${entrySlug}`;
    }
    return entrySlug;
};

export async function resolveRouteData(db: any, slug: string, currentPage: number = 1, pageSize: number = 12, sortTermBy: string = 'popular', options: { dateArchiveMode?: string } = {}) {
    if (!db || !slug) return null;

    // Helper to get a collection by slug — uses the already-cached allCollections (zero D1)
    // Note: allCollections is loaded below; this helper is only called AFTER that block.
    const getCollection = (cSlug: string) => {
        return allCollections.find((c: any) => c.slug === cSlug) || null;
    };

    // Cache all collections at the CF edge — they rarely change (new collection type = very rare).
    // This eliminates ~9k D1 reads/day from resolveRouteData being called on every SSR render.
    const COLLECTIONS_CACHE_KEY = 'https://waritaku.internal/cache/all_collections';
    const COLLECTIONS_CACHE_TTL = 600; // 10 minutes
    let allCollections: any[] = [];
    const cfColCache = (typeof caches !== 'undefined') ? await caches.default.match(new Request(COLLECTIONS_CACHE_KEY)) : null;
    if (cfColCache) {
        try { allCollections = await cfColCache.json(); } catch {}
    }
    if (allCollections.length === 0) {
        allCollections = await db.select().from(collections);
        if (typeof caches !== 'undefined' && allCollections.length > 0) {
            caches.default.put(new Request(COLLECTIONS_CACHE_KEY), new Response(JSON.stringify(allCollections), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${COLLECTIONS_CACHE_TTL}` }
            })).catch(() => {});
        }
    }
    const contentCollections = allCollections.filter((c: any) => c.slug !== 'pages');
    const contentCollectionIds = contentCollections.map((c: any) => c.id);
    const totalContentItems = contentCollections.reduce((sum: any, c: any) => sum + (c.entryCount || 0), 0);


    // 0. Check Date Archive (e.g., 2025/03 or 2025/03/15) — WIB (UTC+7) aware
    let dateArchiveMode = options.dateArchiveMode || 'date';

    if (dateArchiveMode !== 'off') {
    const dateMatch = slug.match(/^(\d{4})(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?$/);
    if (dateMatch && contentCollectionIds.length > 0) {
        const year = dateMatch[1];
        const month = dateMatch[2];
        const day = dateMatch[3];

        // Gate finer date levels against archive mode
        if (day && dateArchiveMode !== 'date') return null;
        if (month && dateArchiveMode === 'year') return null;

        let archiveTitle = `Arsip: ${year}`;
        if (month) {
            const monthNamesIndo = [
                'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
                'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
            ];
            const monthName = monthNamesIndo[parseInt(month, 10) - 1] || month;
            archiveTitle = day 
                ? `Arsip: ${day} ${monthName} ${year}`
                : `Arsip: ${monthName} ${year}`;
        }

        // Compute UTC bounds for the WIB date range
        const pad = (s: string, n: number) => String(s).padStart(n, '0');
        const m = month ? pad(month, 2) : '01';
        const d = day ? pad(day, 2) : '01';
        const isoStart = `${year}-${m}-${d}T00:00:00.000+07:00`;
        const utcStart = new Date(isoStart).toISOString();
        
        let utcEnd: string;
        if (day) {
            const isoEnd = `${year}-${m}-${d}T23:59:59.999+07:00`;
            utcEnd = new Date(isoEnd).toISOString();
        } else if (month) {
            const nextMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1;
            const nextYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year);
            const isoEnd = `${nextYear}-${pad(String(nextMonth),2)}-01T00:00:00.000+07:00`;
            utcEnd = new Date(new Date(isoEnd).getTime() - 1).toISOString();
        } else {
            const nextYear = parseInt(year) + 1;
            const isoEnd = `${nextYear}-01-01T00:00:00.000+07:00`;
            utcEnd = new Date(new Date(isoEnd).getTime() - 1).toISOString();
        }


        // Count query — date archive has no stored counter so a targeted count is needed.
        // Use the publishedAt index (entries_collection_status_published_idx) which covers this filter.
        const countResult = await db.select({ count: sql<number>`count(*)` })
            .from(entries)
            .where(
                and(
                    inArray(entries.collectionId, contentCollectionIds),
                    eq(entries.status, 'published'),
                    gte(entries.publishedAt, utcStart),
                    lte(entries.publishedAt, utcEnd)
                )
            );

        const totalItems = countResult[0]?.count || 0;
        const totalPages = Math.ceil(totalItems / pageSize);


        // Fetch entries for date archive
        const entriesResult = await db.select({
            entry: entries,
            author: users
        })
        .from(entries)
        .leftJoin(users, eq(entries.authorId, users.id))
        .where(
            and(
                inArray(entries.collectionId, contentCollectionIds),
                eq(entries.status, 'published'),
                gte(entries.publishedAt, utcStart),
                lte(entries.publishedAt, utcEnd)
            )
        )
        .orderBy(desc(entries.id))
        .limit(pageSize)
        .offset((currentPage - 1) * pageSize);

        const categoryArticles = entriesResult.map((r: any) => {
            const data = safeJsonParse(r.entry.data, {} as any);
            const rawContent = data.content || '';
            const textOnly = rawContent.replace(/<[^>]+>/g, '').replace(/\[caption[^\]]*\]|\[\/caption\]/g, '').trim();
            const excerpt = textOnly.length > 120 ? textOnly.substring(0, 120) + '...' : textOnly;
            return {
                id: r.entry.id,
                slug: r.entry.slug,
                canonicalUrl: `/${r.entry.slug}`,
                publishedAt: r.entry.publishedAt,
                ...data,
                authorName: r.author?.name || 'Writer',
                categoryName: 'Article', // Can be enriched with terms
                excerpt
            };
        });

        const data = {
            id: null,
            name: archiveTitle,
            slug,
            year,
            month,
            day,
            isDateArchive: true
        };

        return { pageType: 'category' as const, data, categoryArticles, totalPages, articleBottomHtml: '' };
    }
    } // end dateArchiveMode !== 'off'

    const segments = slug.split('/');
    const lastSegment = segments[segments.length - 1];

    // 0.5 Check Collection Archive (e.g. /articles)
    const collectionArchiveMatch = await db.select().from(collections).where(eq(collections.slug, slug)).limit(1);
    if (collectionArchiveMatch.length > 0) {
        const collection = collectionArchiveMatch[0];
        
        // Use stored entryCount — avoids a COUNT(*) full index scan.
        // syncCounts() keeps this value accurate after every publish/delete.
        const totalItems = Number(collection.entryCount || 0);
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));


        // Fetch paginated entries
        const articlesResult = await db.select({
            entry: entries,
            author: users
        })
        .from(entries)
        .leftJoin(users, eq(entries.authorId, users.id))
        .where(
            and(
                eq(entries.collectionId, collection.id),
                eq(entries.status, 'published')
            )
        )
        .orderBy(desc(entries.id))
        .limit(pageSize)
        .offset((currentPage - 1) * pageSize);

        const categoryArticles = [];
        const entryIds = articlesResult.map((r: any) => r.entry.id);
        const canonicalMap = await getCanonicalUrls(db, entryIds, allCollections);
        
        // Batch fetch primary categories for display
        let categoryMap: Record<number, any[]> = {};
        if (entryIds.length > 0) {
            const catTax = await db.select({ id: taxonomies.id }).from(taxonomies).where().limit(1);
            if (catTax.length > 0) {
                const catTermRows = await db.select({ entryId: entryTerms.entryId, id: terms.id, name: terms.name, slug: terms.slug })
                    .from(entryTerms)
                    .innerJoin(terms, eq(entryTerms.termId, terms.id))
                    .where(and(
                        eq(terms.taxonomyId, catTax[0].id),
                        sql`${entryTerms.entryId} IN (${sql.join(entryIds.map((id: any) => sql`${id}`), sql`, `)})`
                    ));
                for (const row of catTermRows) {
                    if (!categoryMap[row.entryId]) categoryMap[row.entryId] = [];
                    categoryMap[row.entryId].push(row);
                }
            }
        }

        for (const r of articlesResult) {
            const data = safeJsonParse(r.entry.data, {} as any);
            const rawContent = data.content || '';
            const textOnly = rawContent.replace(/<[^>]+>/g, '').replace(/\[caption[^\]]*\]|\[\/caption\]/g, '').trim();
            const excerpt = textOnly.length > 120 ? textOnly.substring(0, 120) + '...' : textOnly;
            
            const prefixSlug = canonicalMap[r.entry.id];
            const canonicalPath = prefixSlug ? `/${prefixSlug}/${r.entry.slug}` : `/${r.entry.slug}`;
            
            let categoryName = 'Article';
            const cats = categoryMap[r.entry.id] || [];
            if (cats.length > 0) {
                const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                categoryName = primary ? primary.name : cats[0].name;
            }

            categoryArticles.push({
                id: r.entry.id,
                slug: r.entry.slug,
                canonicalUrl: canonicalPath,
                publishedAt: r.entry.publishedAt,
                ...data,
                authorName: r.author?.name || 'Writer',
                categoryName,
                excerpt
            });
        }

        return { 
            pageType: 'collection_archive' as const, 
            data: { title: collection.label || collection.name || slug, metaTitle: `Archive: ${collection.label || slug}` }, 
            categoryArticles, 
            totalPages, 
            articleBottomHtml: '' 
        };
    }

    // 0.6 Check Taxonomy Archive (e.g. /tags)
    const taxonomyArchiveMatch = await db.select().from(taxonomies).where(and(eq(taxonomies.slug, slug), eq(taxonomies.isRouted, true))).limit(1);
    if (taxonomyArchiveMatch.length > 0) {
        const taxonomy = taxonomyArchiveMatch[0];
        
        if (taxonomy.umbrellaViewMode === 'all_entries') {
            // Count total entries in this taxonomy
            const countQuery = await db.select({ count: sql<number>`count(distinct ${entries.id})` })
                .from(entryTerms)
                .innerJoin(terms, eq(entryTerms.termId, terms.id))
                .innerJoin(entries, eq(entryTerms.entryId, entries.id))
                .where(and(
                    eq(terms.taxonomyId, taxonomy.id),
                    eq(entries.status, 'published')
                ));
            const totalItems = Number(countQuery[0]?.count || 0);
            const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

            const idResult = await db.select({ id: entries.id })
                .from(entryTerms)
                .innerJoin(terms, eq(entryTerms.termId, terms.id))
                .innerJoin(entries, eq(entryTerms.entryId, entries.id))
                .where(and(
                    eq(terms.taxonomyId, taxonomy.id),
                    eq(entries.status, 'published')
                ))
                .groupBy(entries.id)
                .orderBy(desc(entries.id))
                .limit(pageSize)
                .offset((currentPage - 1) * pageSize);

            const entryIds = idResult.map((r: any) => r.id);
            let articlesResult: any[] = [];
            if (entryIds.length > 0) {
                articlesResult = await db.select({
                    entry: entries,
                    author: users
                })
                .from(entries)
                .leftJoin(users, eq(entries.authorId, users.id))
                .where(sql`${entries.id} IN (${sql.join(entryIds.map((id: any) => sql`${id}`), sql`, `)})`)
                .orderBy(desc(entries.id));
            }

            const categoryArticles = [];
            const canonicalMap = await getCanonicalUrls(db, entryIds, allCollections);
            
            const categoryMap: any = {};
            if (entryIds.length > 0) {
                const catTermRows = await db.select({
                    entryId: entryTerms.entryId,
                    id: terms.id,
                    name: terms.name,
                    slug: terms.slug
                })
                .from(entryTerms)
                .innerJoin(terms, eq(entryTerms.termId, terms.id))
                .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
                .where(and(
                    sql`${entryTerms.entryId} IN (${sql.join(entryIds.map((id: any) => sql`${id}`), sql`, `)})`
                ));
                for (const row of catTermRows) {
                    if (!categoryMap[row.entryId]) categoryMap[row.entryId] = [];
                    categoryMap[row.entryId].push(row);
                }
            }

            for (const r of articlesResult) {
                const data = safeJsonParse(r.entry.data, {} as any);
                const rawContent = data.content || '';
                const textOnly = rawContent.replace(/<[^>]+>/g, '').replace(/\[caption[^\]]*\]|\[\/caption\]/g, '').trim();
                const excerpt = textOnly.length > 120 ? textOnly.substring(0, 120) + '...' : textOnly;
                
                const prefixSlug = canonicalMap[r.entry.id];
                const canonicalPath = prefixSlug ? `/${prefixSlug}/${r.entry.slug}` : `/${r.entry.slug}`;
                
                let categoryName = taxonomy.label || 'Article';
                const cats = categoryMap[r.entry.id] || [];
                if (cats.length > 0) {
                    const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                    categoryName = primary ? primary.name : cats[0].name;
                }
                
                categoryArticles.push({
                    id: r.entry.id,
                    slug: r.entry.slug,
                    canonicalUrl: canonicalPath,
                    publishedAt: r.entry.publishedAt,
                    ...data,
                    authorName: r.author?.name || 'Writer',
                    categoryName,
                    excerpt
                });
            }

            return { 
                pageType: 'taxonomy_archive' as const, 
                data: { 
                    title: taxonomy.label || taxonomy.name || slug, 
                    taxonomySlug: taxonomy.slug, 
                    metaTitle: `Archive: ${taxonomy.label || slug}`,
                    omitTaxonomySlug: taxonomy.omitTaxonomySlug,
                    taxonomy: taxonomy
                }, 
                termsList: [],
                categoryArticles,
                totalPages, 
                articleBottomHtml: '' 
            };
        } else {
            // Count total terms using taxonomy_id index (tiny result set).
            // Fetch IDs only — no full row scan, uses terms_taxonomy_idx.
            const allTermIds = await db.select({ id: terms.id })
                .from(terms)
                .where(eq(terms.taxonomyId, taxonomy.id));
            const totalItems = allTermIds.length;

            const umbrellaLimit = taxonomy.umbrellaItemsPerPage || 0;
            const totalPages = umbrellaLimit > 0 ? Math.max(1, Math.ceil(totalItems / umbrellaLimit)) : 1;

            let query = db.select({
                id: terms.id,
                name: terms.name,
                slug: terms.slug,
                entryCount: terms.entryCount
            })
                .from(terms)
                .where(eq(terms.taxonomyId, taxonomy.id));
                
            if (sortTermBy === 'az') {
                query = query.orderBy(terms.name) as any;
            } else {
                query = query.orderBy(desc(terms.entryCount), terms.name) as any;
            }

            if (umbrellaLimit > 0) {
                query = query.limit(umbrellaLimit).offset((currentPage - 1) * umbrellaLimit) as any;
            }

            const termsList = await query;

            return { 
                pageType: 'taxonomy_archive' as const, 
                data: { 
                    title: taxonomy.label || taxonomy.name || slug, 
                    taxonomySlug: taxonomy.slug, 
                    metaTitle: `Archive: ${taxonomy.label || slug}`,
                    omitTaxonomySlug: taxonomy.omitTaxonomySlug,
                    taxonomy: taxonomy // Pass entire taxonomy to respect allowIndexing in SEO block
                }, 
                termsList, 
                totalPages, 
                articleBottomHtml: '' 
            };
        }
    }

    // 1. Try Entry by Slug (Article, Page, etc.)
    const entryResult = await db.select({
        entry: entries,
        collection: collections,
        author: users
    })
    .from(entries)
    .innerJoin(collections, eq(entries.collectionId, collections.id))
    .leftJoin(users, eq(entries.authorId, users.id))
    .where(
        and(
            eq(entries.slug, lastSegment),
            eq(entries.status, 'published')
        )
    )
    .limit(1);

    if (entryResult.length > 0) {
        const { entry, collection, author } = entryResult[0];

        // Strict URL Enforcement: If the entry has a prefix configured, ensure the user visited that exact prefix
        const canonicalUrl = await getCanonicalUrl(db, entry.id, entry.slug);
        if (slug !== canonicalUrl) {
            return { redirect: `/${canonicalUrl}` };
        }

        const parsedData = safeJsonParse(entry.data, {} as any);
        const genSlug = author?.name ? author.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'writer';
        
        let collectionSupports = {};
        try {
            collectionSupports = JSON.parse(collection.supports || '{}');
        } catch(e) {}

        const data: any = {
            id: entry.id,
            slug: entry.slug,
            canonicalUrl: `/${canonicalUrl}`,
            status: entry.status,
            publishedAt: entry.publishedAt,
            ...parsedData,
            authorId: author?.id || 0,
            authorName: author?.name || 'Writer',
            authorSlug: author?.slug || genSlug,
            authorBio: author?.bio || '',
            authorAvatar: author?.avatarUrl || '',
            tags: [],
            supports: collectionSupports
        };

        // Generic taxonomy mapping
        const collTaxonomies: string[] = (collectionSupports as any).taxonomies || [];
        if (contentCollectionIds.includes(collection.id) || collTaxonomies.length > 0) {
            const entryTermsResult = await db.select({
                term: terms,
                taxonomy: taxonomies
            })
            .from(entryTerms)
            .innerJoin(terms, eq(entryTerms.termId, terms.id))
            .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
            .where(eq(entryTerms.entryId, entry.id));

            // Populate generic taxonomyTerms object
            data.taxonomyTerms = {};
            entryTermsResult.forEach((t: any) => {
                const taxSlug = t.taxonomy.slug;
                if (!data.taxonomyTerms[taxSlug]) data.taxonomyTerms[taxSlug] = [];
                
                // Determine URL based on omitTaxonomySlug
                const omitTaxSlug = t.taxonomy.omitTaxonomySlug === true || t.taxonomy.omitTaxonomySlug === 1;
                const url = omitTaxSlug ? `/${t.term.slug}` : `/${taxSlug}/${t.term.slug}`;

                data.taxonomyTerms[taxSlug].push({
                    ...t.term,
                    url
                });
            });

            // Backwards compatibility for templates expecting data.categories and data.tags
            const cats = entryTermsResult.filter((t: any) => t.taxonomy.slug === 'categories');
            const primaryTermId = parsedData.primaryTermId;
            if (primaryTermId) {
                cats.sort((a: any, b: any) => {
                    if (a.term.id === primaryTermId) return -1;
                    if (b.term.id === primaryTermId) return 1;
                    return 0;
                });
            }
            data.categories = cats.map((c: any) => ({ name: c.term.name, slug: c.term.slug }));
            data.categoryName = cats.length > 0 ? cats[0].term.name : 'Article';
            data.categorySlug = cats.length > 0 ? cats[0].term.slug : 'all';

            data.tags = entryTermsResult.filter((t: any) => t.taxonomy.slug === 'tags').map((t: any) => t.term);

            // Process Related Items if configured in layout blocks
            data.relatedItems = [];
            // Note: The actual database query for Related Items has been removed.
            // It is now handled via Client-Side Edge-Cache Shuffle in ModularTemplateRenderer.astro.

            // Extract Article Custom HTML
            let articleBottomHtml = '';
            let articleUpperHtml = '';
            const genSettings = await db.select().from(settings).where(eq(settings.key, 'general_settings'));
            if (genSettings.length > 0) {
                try {
                    const parsed = JSON.parse(genSettings[0].value);
                    articleBottomHtml = parsed.articleBottomHtml || '';
                    articleUpperHtml = parsed.articleUpperHtml || '';
                } catch(e) {}
            }

            return { pageType: 'article' as const, data, categoryArticles: [], totalPages: 1, articleUpperHtml, articleBottomHtml };
        } 
        
        // If it's a page collection
        if (collection.slug === 'pages') {
            return { pageType: 'page' as const, data, categoryArticles: [], totalPages: 1, articleBottomHtml: '' };
        }

        // Generic collection fallback (for custom content types in the future)
        return { pageType: collection.slug as any, data, categoryArticles: [], totalPages: 1, articleBottomHtml: '' };
    }

    // 2. Try Term (Taxonomy Archive)
    let termResult: any[] = [];
    let taxonomyData: any = null;

    if (segments.length === 1 && segments[0] === 'all') {
        termResult = [{ term: { id: null, name: 'Semua Berita', slug: 'all' }, taxonomy: { allowIndexing: true } }];
    } else if (segments.length === 1) {
        // e.g. /category-term — prefer lower taxonomy id when multiple match
        termResult = await db.select({
            term: terms,
            taxonomy: taxonomies
        })
        .from(terms)
        .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
        .where(
            and(
                eq(terms.slug, segments[0]),
                eq(taxonomies.isRouted, true)
            )
        )
        .orderBy(taxonomies.id)
        .limit(1);
    } else if (segments.length === 2) {
        // e.g. /product/dining-room
        termResult = await db.select({
            term: terms,
            taxonomy: taxonomies
        })
        .from(terms)
        .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
        .where(
            and(
                eq(taxonomies.slug, segments[0]),
                eq(terms.slug, segments[1]),
                eq(taxonomies.isRouted, true)
            )
        )
        .limit(1);
    }

    if (termResult.length > 0) {
        const data = termResult[0].term;
        taxonomyData = termResult[0].taxonomy;

        // Strict URL Enforcement: Redirect if the visited format does not match the configured setting
        if (segments.length === 1 && !taxonomyData.allowIndexing && data.slug === 'all') {
             // Let /all pass through as usual
        } else if (segments.length === 1 && !taxonomyData.omitTaxonomySlug && data.slug !== 'all') {
            return { redirect: `/${taxonomyData.slug}/${data.slug}` };
        } else if (segments.length === 2 && taxonomyData.omitTaxonomySlug) {
            return { redirect: `/${data.slug}` };
        }
        
        let totalItems = 0;
        
        if (data.id) {
            totalItems = data.entryCount || 0;
        } else {
            totalItems = totalContentItems;
        }
        
        const totalPages = Math.ceil(totalItems / pageSize);

        let articlesResult: any[] = [];
        
        if (data.id) {
            // Two-step query to prevent massive row scans and memory sorting
            const idResult = await db.select({ id: entries.id })
                .from(entries)
                .innerJoin(entryTerms, eq(entries.id, entryTerms.entryId))
                .where(
                    and(
                        eq(entryTerms.termId, data.id),
                        eq(entries.status, 'published')
                    )
                )
                .orderBy(desc(entries.id))
                .limit(pageSize)
                .offset((currentPage - 1) * pageSize);

            const entryIds = idResult.map((r: any) => r.id);
            
            if (entryIds.length > 0) {
                articlesResult = await db.select({
                    entry: entries,
                    author: users
                })
                .from(entries)
                .leftJoin(users, eq(entries.authorId, users.id))
                .where(sql`${entries.id} IN (${sql.join(entryIds.map((id: any) => sql`${id}`), sql`, `)})`)
                .orderBy(desc(entries.id));
            }
        } else {
            // For /all route
            articlesResult = await db.select({
                entry: entries,
                author: users
            })
            .from(entries)
            .leftJoin(users, eq(entries.authorId, users.id))
            .where(
                and(
                    inArray(entries.collectionId, contentCollectionIds),
                    eq(entries.status, 'published')
                )
            )
            .orderBy(desc(entries.id))
            .limit(pageSize)
            .offset((currentPage - 1) * pageSize);
        }

        const categoryArticles = [];
        // Batch canonical URL lookup — single query instead of N
        const entryIds = articlesResult.map((r: any) => r.entry.id);
        const canonicalMap = await getCanonicalUrls(db, entryIds, allCollections);
        
        const categoryMap: any = {};
        if (entryIds.length > 0) {
            const catTermRows = await db.select({
                entryId: entryTerms.entryId,
                id: terms.id,
                name: terms.name,
                slug: terms.slug
            })
            .from(entryTerms)
            .innerJoin(terms, eq(entryTerms.termId, terms.id))
            .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
            .where(and(
                sql`${entryTerms.entryId} IN (${sql.join(entryIds.map((id: any) => sql`${id}`), sql`, `)})`
            ));
            for (const row of catTermRows) {
                if (!categoryMap[row.entryId]) categoryMap[row.entryId] = [];
                categoryMap[row.entryId].push(row);
            }
        }
        
        for (const r of articlesResult) {
            const data = safeJsonParse(r.entry.data, {} as any);
            const rawContent = data.content || '';
            const textOnly = rawContent.replace(/<[^>]+>/g, '').replace(/\[caption[^\]]*\]|\[\/caption\]/g, '').trim();
            const excerpt = textOnly.length > 120 ? textOnly.substring(0, 120) + '...' : textOnly;
            
            const prefixSlug = canonicalMap[r.entry.id];
            const canonicalPath = prefixSlug ? `/${prefixSlug}/${r.entry.slug}` : `/${r.entry.slug}`;

            let categoryName = taxonomyData?.label || 'Article';
            const cats = categoryMap[r.entry.id] || [];
            if (cats.length > 0) {
                const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                categoryName = primary ? primary.name : cats[0].name;
            }

            categoryArticles.push({
                id: r.entry.id,
                slug: r.entry.slug,
                canonicalUrl: canonicalPath,
                publishedAt: r.entry.publishedAt,
                ...data,
                authorName: r.author?.name || 'Writer',
                categoryName,
                excerpt
            });
        }

        // Extend data with taxonomy context for SEO/indexing
        const archiveData = {
            ...data,
            taxonomy: taxonomyData,
            canonicalUrl: (taxonomyData?.omitTaxonomySlug || data.slug === 'all') ? `/${data.slug}` : `/${taxonomyData.slug}/${data.slug}`
        };

        return { pageType: 'category' as const, data: archiveData, categoryArticles, totalPages, articleBottomHtml: '' };
    }

    return null;
}
