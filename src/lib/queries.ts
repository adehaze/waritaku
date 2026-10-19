import { eq, and, sql, desc, inArray, gte, lte, ne, exists } from 'drizzle-orm';
import { entries, collections, users, terms, taxonomies, entryTerms, settings } from '../db/schema';

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
    if (!json) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
}

/**
 * Resolves standardized display fields (displayTitle, displayImage, displayExcerpt, displayContent)
 * according to the collection's supports.mappings configuration.
 */
export function resolveEntryDisplayFields(
    entry: any,
    data: any,
    collectionOrSupports: any,
    fallbackExcerpt: string = ''
) {
    let supports: any = {};
    if (collectionOrSupports) {
        if (typeof collectionOrSupports.supports === 'string') {
            supports = safeJsonParse(collectionOrSupports.supports, {});
        } else if (typeof collectionOrSupports.supports === 'object' && collectionOrSupports.supports !== null) {
            supports = collectionOrSupports.supports;
        } else if (typeof collectionOrSupports === 'string') {
            supports = safeJsonParse(collectionOrSupports, {});
        } else if (typeof collectionOrSupports === 'object') {
            supports = collectionOrSupports;
        }
    }
    const mappings = (supports && supports.mappings) ? supports.mappings : {};

    const rawContent = (mappings.contentField && data[mappings.contentField]) || data.content || '';
    const textOnly = rawContent.replace(/<[^>]+>/g, '').replace(/\[caption[^\]]*\]|\[\/caption\]/g, '').trim();
    const generatedExcerpt = textOnly.length > 120 ? textOnly.substring(0, 120) + '...' : textOnly;

    let fallbackImg: string | null = null;
    const rawImage = (mappings.imageField && data[mappings.imageField]) || data.featuredImageUrl || data.featuredImage || null;
    if (!rawImage && rawContent) {
        const imgMatch = rawContent.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (imgMatch) fallbackImg = imgMatch[1];
    }

    const displayTitle = (mappings.titleField && data[mappings.titleField]) || data.title || entry?.slug || '';
    const displayImage = rawImage || fallbackImg;
    const displayExcerpt = (mappings.excerptField && data[mappings.excerptField]) 
        ? data[mappings.excerptField] 
        : (data.excerpt || fallbackExcerpt || generatedExcerpt);
    const displayContent = rawContent;

    return {
        displayTitle,
        displayImage,
        displayExcerpt,
        displayContent,
        excerpt: displayExcerpt,
        title: displayTitle,
        featuredImageUrl: displayImage || null,
        content: displayContent
    };
}

let _indexesEnsured = false;
export async function ensureOptimalIndexes(db: any): Promise<void> {
    if (_indexesEnsured || !db) return;
    _indexesEnsured = true;
    try {
        await db.run(sql`CREATE INDEX IF NOT EXISTS entry_terms_term_entry_idx ON entry_terms (term_id, entry_id)`);
        await db.run(sql`CREATE INDEX IF NOT EXISTS entries_author_collection_status_id_idx ON entries (author_id, collection_id, status, id)`);
    } catch {
        // Ignore if D1 is read-limited; will succeed automatically after midnight UTC reset
        _indexesEnsured = false;
    }
}

let _memCollections: { list: any[]; ts: number } | null = null;
// Shared edge-cached + isolate-cached read of the collections table (10 min TTL).
export async function getAllCollectionsCached(db: any): Promise<any[]> {
    if (_memCollections && Date.now() - _memCollections.ts < 300_000) {
        return _memCollections.list;
    }
    const KEY = 'https://waritaku.internal/cache/all_collections';
    let list: any[] = [];
    const hit = (typeof caches !== 'undefined') ? await caches.default.match(new Request(KEY)) : null;
    if (hit) {
        try { list = await hit.json(); } catch {}
    }
    if (list.length === 0 && db) {
        try {
            await ensureOptimalIndexes(db);
            list = await db.select().from(collections);
            if (typeof caches !== 'undefined' && list.length > 0) {
                caches.default.put(new Request(KEY), new Response(JSON.stringify(list), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' }
                })).catch(() => {});
            }
        } catch (err) {
            if (_memCollections?.list?.length) return _memCollections.list;
            throw err;
        }
    }
    if (list.length > 0) {
        _memCollections = { list, ts: Date.now() };
    }
    return list;
}

let _memTaxonomies: { list: any[]; ts: number } | null = null;
// Shared edge-cached + isolate-cached read of the taxonomies table (30 min TTL).
export async function getAllTaxonomiesCached(db: any): Promise<any[]> {
    if (_memTaxonomies && Date.now() - _memTaxonomies.ts < 600_000) {
        return _memTaxonomies.list;
    }
    const TAX_CACHE_KEY = 'https://waritaku.internal/cache/all_taxonomies_full';
    const TAX_CACHE_TTL = 1800;
    let list: any[] = [];
    const hit = (typeof caches !== 'undefined') ? await caches.default.match(new Request(TAX_CACHE_KEY)) : null;
    if (hit) {
        try { list = await hit.json(); } catch {}
    }
    if (list.length === 0 && db) {
        try {
            list = await db.select().from(taxonomies);
            if (typeof caches !== 'undefined' && list.length > 0) {
                caches.default.put(new Request(TAX_CACHE_KEY), new Response(JSON.stringify(list), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TAX_CACHE_TTL}` }
                })).catch(() => {});
            }
        } catch (err) {
            if (_memTaxonomies?.list?.length) return _memTaxonomies.list;
            throw err;
        }
    }
    if (list.length > 0) {
        _memTaxonomies = { list, ts: Date.now() };
    }
    return list;
}

let _memGeneralSettings: { data: any; ts: number } | null = null;
export async function getGeneralSettingsCached(db: any): Promise<any> {
    if (_memGeneralSettings && Date.now() - _memGeneralSettings.ts < 300_000) {
        return _memGeneralSettings.data;
    }
    const SETTINGS_KEY = 'https://waritaku.internal/cache/general_settings';
    const hit = (typeof caches !== 'undefined') ? await caches.default.match(new Request(SETTINGS_KEY)) : null;
    if (hit) {
        try {
            const parsed = await hit.json();
            if (parsed) {
                _memGeneralSettings = { data: parsed, ts: Date.now() };
                return parsed;
            }
        } catch {}
    }
    if (db) {
        try {
            const rows = await db.select().from(settings).where(eq(settings.key, 'general_settings')).limit(1);
            if (rows.length > 0) {
                const parsed = safeJsonParse(rows[0].value, {});
                _memGeneralSettings = { data: parsed, ts: Date.now() };
                if (typeof caches !== 'undefined') {
                    caches.default.put(new Request(SETTINGS_KEY), new Response(JSON.stringify(parsed), {
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' }
                    })).catch(() => {});
                }
                return parsed;
            }
        } catch {
            if (_memGeneralSettings?.data) return _memGeneralSettings.data;
        }
    }
    return _memGeneralSettings?.data || {};
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
    const allTaxonomies = await getAllTaxonomiesCached(db);
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

        // Step 2: terms by PK. Chunk at 90 IDs: D1 rejects more than 100 bound
        // parameters, and 50 entries with many tags can reference 150+ terms.
        const termRows: any[] = [];
        for (let t = 0; t < termIds.length; t += 90) {
            const rows = await db.select({ id: terms.id, slug: terms.slug, taxonomyId: terms.taxonomyId })
                .from(terms).where(inArray(terms.id, termIds.slice(t, t + 90)));
            termRows.push(...rows);
        }

        // Step 3: entries by PK. Read only the two override fields with json_extract.
        // Loading the full data blob (article HTML) here costs CPU and bandwidth.
        const entryRows = await db.select({
            id: entries.id,
            collectionId: entries.collectionId,
            primaryTermId: sql<any>`json_extract(${entries.data}, '$.primaryTermId')`,
            primaryTaxonomyOverride: sql<any>`json_extract(${entries.data}, '$.primaryTaxonomyOverride')`,
        })
            .from(entries)
            .where(inArray(entries.id, chunk));

        // ── JS joins (zero D1 reads) ──────────────────────────────────────────
        const termById = new Map(termRows.map((t: any) => [t.id, t]));

        // Build entryData map (override fields + supports from cached collections)
        const entryDataMap: Record<number, { data: string, supports: string }> = {};
        for (const e of entryRows) {
            const col = collectionById.get(e.collectionId);
            entryDataMap[e.id] = {
                data: JSON.stringify({ primaryTermId: e.primaryTermId ?? undefined, primaryTaxonomyOverride: e.primaryTaxonomyOverride ?? undefined }),
                supports: col?.supports || '{}'
            };
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
    const map = await getCanonicalUrls(db, [entryId]);
    const prefix = map[entryId];
    return prefix ? `${prefix}/${entrySlug}` : entrySlug;
};

async function fetchEntryCategoryMap(db: any, entryIds: number[], filterTaxonomyId?: number): Promise<Record<number, any[]>> {
    const categoryMap: Record<number, any[]> = {};
    if (!entryIds.length) return categoryMap;

    const etRows = await db.select({ entryId: entryTerms.entryId, termId: entryTerms.termId })
        .from(entryTerms)
        .where(inArray(entryTerms.entryId, entryIds));
    const termIds = Array.from(new Set(etRows.map((r: any) => r.termId))) as number[];
    if (!termIds.length) return categoryMap;

    const termRows: any[] = [];
    for (let t = 0; t < termIds.length; t += 90) {
        const chunk = termIds.slice(t, t + 90);
        const rows = await db.select({
            id: terms.id,
            name: terms.name,
            slug: terms.slug,
            taxonomyId: terms.taxonomyId
        }).from(terms).where(inArray(terms.id, chunk));
        termRows.push(...rows);
    }

    const termById = new Map<number, any>();
    for (const tr of termRows) {
        if (filterTaxonomyId !== undefined && tr.taxonomyId !== filterTaxonomyId) continue;
        termById.set(tr.id, tr);
    }

    for (const et of etRows) {
        const tr = termById.get(et.termId);
        if (!tr) continue;
        if (!categoryMap[et.entryId]) categoryMap[et.entryId] = [];
        categoryMap[et.entryId].push({
            entryId: et.entryId,
            id: tr.id,
            name: tr.name,
            slug: tr.slug
        });
    }
    return categoryMap;
}

async function fetchEntriesWithAuthorsByIds(db: any, pageIds: number[]): Promise<{ entry: any; author: any }[]> {
    if (!pageIds.length) return [];
    const pageEntryRows: any[] = [];
    for (let i = 0; i < pageIds.length; i += 50) {
        const chunk = pageIds.slice(i, i + 50);
        const rows = await db.select().from(entries).where(inArray(entries.id, chunk));
        pageEntryRows.push(...rows);
    }
    const authorIds = Array.from(new Set(pageEntryRows.map((e: any) => e.authorId).filter(Boolean))) as number[];
    const authorRows = authorIds.length > 0
        ? await db.select({
            id: users.id, name: users.name, slug: users.slug, role: users.role,
            firstName: users.firstName, lastName: users.lastName, bio: users.bio,
            avatarUrl: users.avatarUrl, socialLinks: users.socialLinks,
        }).from(users).where(inArray(users.id, authorIds))
        : [];
    const authorById = new Map(authorRows.map((u: any) => [u.id, u]));
    const entryById = new Map(pageEntryRows.map((e: any) => [e.id, e]));
    return pageIds
        .map((id: number) => entryById.get(id))
        .filter(Boolean)
        .map((e: any) => ({ entry: e, author: authorById.get(e.authorId) || null }));
}

export async function resolveRouteData(db: any, slug: string, currentPage: number = 1, pageSize: number = 12, sortTermBy: string = 'popular', options: { dateArchiveMode?: string } = {}) {
    if (!db || !slug) return null;

    const allCollections = await getAllCollectionsCached(db);
    const allTaxonomies = await getAllTaxonomiesCached(db);
    const taxById = new Map(allTaxonomies.map((t: any) => [t.id, t]));

    const contentCollections = allCollections.filter((c: any) => c.slug !== 'pages');
    const contentCollectionIds = contentCollections.map((c: any) => c.id);
    const totalContentItems = contentCollections.reduce((sum: any, c: any) => sum + (c.entryCount || 0), 0);
    const collectionById = new Map(allCollections.map((c: any) => [c.id, c]));

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

        // Two-step fetch for date archive
        const dateIdRows = await db.select({ id: entries.id })
            .from(entries)
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

        const entriesResult = await fetchEntriesWithAuthorsByIds(db, dateIdRows.map((r: any) => r.id));

        const categoryArticles = entriesResult.map((r: any) => {
            const data = safeJsonParse(r.entry.data, {} as any);
            const coll = collectionById.get(r.entry.collectionId);
            const displayFields = resolveEntryDisplayFields(r.entry, data, coll);
            return {
                id: r.entry.id,
                slug: r.entry.slug,
                canonicalUrl: `/${r.entry.slug}`,
                publishedAt: r.entry.publishedAt,
                ...data,
                authorName: r.author?.name || 'Writer',
                categoryName: 'Article',
                ...displayFields
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

    // 0.5 Check Collection Archive (e.g. /articles) — use cached allCollections (zero D1 reads)
    const collection = allCollections.find((c: any) => c.slug === slug);
    if (collection) {
        const totalItems = Number(collection.entryCount || 0);
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

        const pageIdRows = await db.select({ id: entries.id })
            .from(entries)
            .where(and(eq(entries.collectionId, collection.id), eq(entries.status, 'published')))
            .orderBy(desc(entries.id))
            .limit(pageSize)
            .offset((currentPage - 1) * pageSize);
        const pageIds = pageIdRows.map((r: any) => r.id);

        const articlesResult = await fetchEntriesWithAuthorsByIds(db, pageIds);

        const categoryArticles = [];
        const entryIds = articlesResult.map((r: any) => r.entry.id);
        const canonicalMap = await getCanonicalUrls(db, entryIds, allCollections);
        
        const firstTaxId = allTaxonomies.length > 0 ? allTaxonomies[0].id : undefined;
        const categoryMap = await fetchEntryCategoryMap(db, entryIds, firstTaxId);

        for (const r of articlesResult) {
            const data = safeJsonParse(r.entry.data, {} as any);
            const prefixSlug = canonicalMap[r.entry.id];
            const canonicalPath = prefixSlug ? `/${prefixSlug}/${r.entry.slug}` : `/${r.entry.slug}`;
            
            let categoryName = collection.label || 'Article';
            const cats = categoryMap[r.entry.id] || [];
            if (cats.length > 0) {
                const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                categoryName = primary ? primary.name : cats[0].name;
            }

            const displayFields = resolveEntryDisplayFields(r.entry, data, collection);

            categoryArticles.push({
                id: r.entry.id,
                slug: r.entry.slug,
                canonicalUrl: canonicalPath,
                publishedAt: r.entry.publishedAt,
                ...data,
                authorName: r.author?.name || 'Writer',
                categoryName,
                ...displayFields
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

    // 0.6 Check Taxonomy Archive (e.g. /tags) — use cached allTaxonomies (zero D1 reads)
    const taxonomy = allTaxonomies.find((t: any) => t.slug === slug && Boolean(t.isRouted));
    if (taxonomy) {
        if (taxonomy.umbrellaViewMode === 'all_entries') {
            const taxTermRows = await db.select({ id: terms.id, entryCount: terms.entryCount })
                .from(terms)
                .where(eq(terms.taxonomyId, taxonomy.id));
            const taxTermIds = taxTermRows.map((t: any) => t.id);
            const totalItems = Math.min(totalContentItems, taxTermRows.reduce((s: number, t: any) => s + Number(t.entryCount || 0), 0));
            const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

            let entryIds: number[] = [];
            if (taxTermIds.length > 0) {
                const needCount = (currentPage * pageSize) + 12;
                const etRows = await db.select({ entryId: entryTerms.entryId })
                    .from(entryTerms)
                    .where(inArray(entryTerms.termId, taxTermIds.slice(0, 90)))
                    .orderBy(desc(entryTerms.entryId))
                    .limit(needCount * 2);
                const uniqueCandidateIds = Array.from(new Set(etRows.map((r: any) => r.entryId))).sort((a: any, b: any) => b - a) as number[];
                const sliceIds = uniqueCandidateIds.slice((currentPage - 1) * pageSize, currentPage * pageSize);
                if (sliceIds.length > 0) {
                    const pubRows = await db.select({ id: entries.id })
                        .from(entries)
                        .where(and(inArray(entries.id, sliceIds), eq(entries.status, 'published')))
                        .orderBy(desc(entries.id));
                    entryIds = pubRows.map((r: any) => r.id);
                }
            }

            const articlesResult = await fetchEntriesWithAuthorsByIds(db, entryIds);
            const categoryArticles = [];
            const canonicalMap = await getCanonicalUrls(db, entryIds, allCollections);
            const categoryMap = await fetchEntryCategoryMap(db, entryIds);

            for (const r of articlesResult) {
                const data = safeJsonParse(r.entry.data, {} as any);
                const coll = collectionById.get(r.entry.collectionId);
                const prefixSlug = canonicalMap[r.entry.id];
                const canonicalPath = prefixSlug ? `/${prefixSlug}/${r.entry.slug}` : `/${r.entry.slug}`;
                
                let categoryName = taxonomy.label || 'Article';
                const cats = categoryMap[r.entry.id] || [];
                if (cats.length > 0) {
                    const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                    categoryName = primary ? primary.name : cats[0].name;
                }
                
                const displayFields = resolveEntryDisplayFields(r.entry, data, coll);

                categoryArticles.push({
                    id: r.entry.id,
                    slug: r.entry.slug,
                    canonicalUrl: canonicalPath,
                    publishedAt: r.entry.publishedAt,
                    ...data,
                    authorName: r.author?.name || 'Writer',
                    categoryName,
                    ...displayFields
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
                    taxonomy: taxonomy
                }, 
                termsList, 
                totalPages, 
                articleBottomHtml: '' 
            };
        }
    }

    // 1. Try Entry by Slug (Article, Page, etc.) — pure unique index lookup on entries.slug
    const rawEntryRows = await db.select()
        .from(entries)
        .where(and(eq(entries.slug, lastSegment), eq(entries.status, 'published')))
        .limit(1);

    if (rawEntryRows.length > 0) {
        const entry = rawEntryRows[0];
        const collection = collectionById.get(entry.collectionId);
        if (collection) {
            let author: any = null;
            if (entry.authorId) {
                const authorRows = await db.select({
                    id: users.id, name: users.name, slug: users.slug, role: users.role,
                    firstName: users.firstName, lastName: users.lastName, bio: users.bio,
                    avatarUrl: users.avatarUrl, socialLinks: users.socialLinks,
                }).from(users).where(eq(users.id, entry.authorId)).limit(1);
                author = authorRows[0] || null;
            }

            const parsedData = safeJsonParse(entry.data, {} as any);
            let collectionSupports: any = {};
            try {
                collectionSupports = JSON.parse(collection.supports || '{}');
            } catch(e) {}

            // Fetch entry's terms once by PK and join with cached taxonomies in JS
            const etRows = await db.select({ termId: entryTerms.termId })
                .from(entryTerms)
                .where(eq(entryTerms.entryId, entry.id));
            const termIds = etRows.map((r: any) => r.termId);
            const termRows = termIds.length > 0
                ? await db.select().from(terms).where(inArray(terms.id, termIds.slice(0, 90)))
                : [];

            const entryTermsResult = termRows
                .map((term: any) => ({ term, taxonomy: taxById.get(term.taxonomyId) }))
                .filter((r: any) => Boolean(r.taxonomy));

            // Compute canonicalUrl in memory from entryTermsResult + collectionSupports (zero extra D1 queries)
            let canonicalUrl = entry.slug;
            const prefixCandidates = entryTermsResult.filter((r: any) => r.taxonomy.entryUrlFormat !== 'none');
            if (prefixCandidates.length > 0) {
                const formatPrefix = (match: any) =>
                    match.taxonomy.entryUrlFormat === 'long'
                        ? `${match.taxonomy.slug}/${match.term.slug}`
                        : match.term.slug;

                let matchedPrefix: string | null = null;
                const termOverride = parsedData.primaryTermId;
                if (termOverride) {
                    const ov = prefixCandidates.find((r: any) => r.term.id === termOverride || r.term.id.toString() === termOverride.toString());
                    if (ov) matchedPrefix = formatPrefix(ov);
                }
                if (!matchedPrefix && parsedData.primaryTaxonomyOverride) {
                    const ov = prefixCandidates.find((r: any) => r.taxonomy.slug === parsedData.primaryTaxonomyOverride);
                    if (ov) matchedPrefix = formatPrefix(ov);
                }
                if (!matchedPrefix) {
                    const priorityArray: string[] = collectionSupports.taxonomies || [];
                    const sorted = [...prefixCandidates].sort((a: any, b: any) => {
                        const idxA = priorityArray.indexOf(a.taxonomy.slug);
                        const idxB = priorityArray.indexOf(b.taxonomy.slug);
                        return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
                    });
                    matchedPrefix = formatPrefix(sorted[0]);
                }
                if (matchedPrefix) {
                    canonicalUrl = `${matchedPrefix}/${entry.slug}`;
                }
            }

            if (slug !== canonicalUrl) {
                return { redirect: `/${canonicalUrl}` };
            }

            const genSlug = author?.name ? author.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'writer';
            const displayFields = resolveEntryDisplayFields(entry, parsedData, collection);

            const data: any = {
                id: entry.id,
                slug: entry.slug,
                canonicalUrl: `/${canonicalUrl}`,
                status: entry.status,
                publishedAt: entry.publishedAt,
                ...parsedData,
                ...displayFields,
                authorId: author?.id || 0,
                authorName: author?.name || 'Writer',
                authorSlug: author?.slug || genSlug,
                authorBio: author?.bio || '',
                authorAvatar: author?.avatarUrl || '',
                tags: [],
                supports: collectionSupports
            };

            const collTaxonomies: string[] = collectionSupports.taxonomies || [];
            if (contentCollectionIds.includes(collection.id) || collTaxonomies.length > 0) {
                data.taxonomyTerms = {};
                entryTermsResult.forEach((t: any) => {
                    const taxSlug = t.taxonomy.slug;
                    if (!data.taxonomyTerms[taxSlug]) data.taxonomyTerms[taxSlug] = [];
                    const omitTaxSlug = t.taxonomy.omitTaxonomySlug === true || t.taxonomy.omitTaxonomySlug === 1;
                    const url = omitTaxSlug ? `/${t.term.slug}` : `/${taxSlug}/${t.term.slug}`;
                    data.taxonomyTerms[taxSlug].push({
                        ...t.term,
                        url
                    });
                });

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
                data.relatedItems = [];

                const genSettings = await getGeneralSettingsCached(db);
                const articleBottomHtml = genSettings?.articleBottomHtml || '';
                const articleUpperHtml = genSettings?.articleUpperHtml || '';

                return { pageType: 'article' as const, data, categoryArticles: [], totalPages: 1, articleUpperHtml, articleBottomHtml };
            }

            if (collection.slug === 'pages') {
                return { pageType: 'page' as const, data, categoryArticles: [], totalPages: 1, articleBottomHtml: '' };
            }

            return { pageType: collection.slug as any, data, categoryArticles: [], totalPages: 1, articleBottomHtml: '' };
        }
    }

    // 2. Try Term (Taxonomy Archive) — use cached allTaxonomies + terms_slug_unique index
    let termResult: any[] = [];
    let taxonomyData: any = null;

    if (segments.length === 1 && segments[0] === 'all') {
        termResult = [{ term: { id: null, name: 'Semua Berita', slug: 'all' }, taxonomy: { allowIndexing: true } }];
    } else if (segments.length === 1) {
        const matchedTerms = await db.select()
            .from(terms)
            .where(eq(terms.slug, segments[0]));
        const routedMatches = matchedTerms
            .map((term: any) => ({ term, taxonomy: taxById.get(term.taxonomyId) }))
            .filter((m: any) => m.taxonomy && Boolean(m.taxonomy.isRouted))
            .sort((a: any, b: any) => a.taxonomy.id - b.taxonomy.id);
        if (routedMatches.length > 0) {
            termResult = [routedMatches[0]];
        }
    } else if (segments.length === 2) {
        const matchedTax = allTaxonomies.find((t: any) => t.slug === segments[0] && Boolean(t.isRouted));
        if (matchedTax) {
            const matchedTerms = await db.select()
                .from(terms)
                .where(and(eq(terms.slug, segments[1]), eq(terms.taxonomyId, matchedTax.id)))
                .limit(1);
            if (matchedTerms.length > 0) {
                termResult = [{ term: matchedTerms[0], taxonomy: matchedTax }];
            }
        }
    }

    if (termResult.length > 0) {
        const data = termResult[0].term;
        taxonomyData = termResult[0].taxonomy;

        if (segments.length === 1 && !taxonomyData.allowIndexing && data.slug === 'all') {
             // Let /all pass through as usual
        } else if (segments.length === 1 && !taxonomyData.omitTaxonomySlug && data.slug !== 'all') {
            return { redirect: `/${taxonomyData.slug}/${data.slug}` };
        } else if (segments.length === 2 && taxonomyData.omitTaxonomySlug) {
            return { redirect: `/${data.slug}` };
        }
        
        const totalItems = data.id ? (data.entryCount || 0) : totalContentItems;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

        let articlesResult: any[] = [];
        
        if (data.id) {
            // Walk covering index entry_terms_term_entry_idx (term_id, entry_id DESC)
            // Zero table scan on entries_status_idx!
            const candidateRows = await db.select({ id: entryTerms.entryId })
                .from(entryTerms)
                .where(eq(entryTerms.termId, data.id))
                .orderBy(desc(entryTerms.entryId))
                .limit(pageSize + 6)
                .offset((currentPage - 1) * pageSize);

            const candidateIds = candidateRows.map((r: any) => r.id);
            
            if (candidateIds.length > 0) {
                const pubIdRows = await db.select({ id: entries.id })
                    .from(entries)
                    .where(and(inArray(entries.id, candidateIds), eq(entries.status, 'published')))
                    .orderBy(desc(entries.id))
                    .limit(pageSize);
                const pageIds = pubIdRows.map((r: any) => r.id);
                articlesResult = await fetchEntriesWithAuthorsByIds(db, pageIds);
            }
        } else {
            // For /all route: two-step ID-first lookup
            const pageIdRows = await db.select({ id: entries.id })
                .from(entries)
                .where(
                    and(
                        inArray(entries.collectionId, contentCollectionIds),
                        eq(entries.status, 'published')
                    )
                )
                .orderBy(desc(entries.id))
                .limit(pageSize)
                .offset((currentPage - 1) * pageSize);
            const pageIds = pageIdRows.map((r: any) => r.id);
            articlesResult = await fetchEntriesWithAuthorsByIds(db, pageIds);
        }

        const categoryArticles = [];
        const entryIds = articlesResult.map((r: any) => r.entry.id);
        const canonicalMap = await getCanonicalUrls(db, entryIds, allCollections);
        const categoryMap = await fetchEntryCategoryMap(db, entryIds);
        
        for (const r of articlesResult) {
            const data = safeJsonParse(r.entry.data, {} as any);
            const coll = collectionById.get(r.entry.collectionId);
            const prefixSlug = canonicalMap[r.entry.id];
            const canonicalPath = prefixSlug ? `/${prefixSlug}/${r.entry.slug}` : `/${r.entry.slug}`;

            let categoryName = taxonomyData?.label || 'Article';
            const cats = categoryMap[r.entry.id] || [];
            if (cats.length > 0) {
                const primary = data.primaryTermId ? cats.find((c: any) => c.id === data.primaryTermId) : null;
                categoryName = primary ? primary.name : cats[0].name;
            }

            const displayFields = resolveEntryDisplayFields(r.entry, data, coll);

            categoryArticles.push({
                id: r.entry.id,
                slug: r.entry.slug,
                canonicalUrl: canonicalPath,
                publishedAt: r.entry.publishedAt,
                ...data,
                authorName: r.author?.name || 'Writer',
                categoryName,
                ...displayFields
            });
        }

        const archiveData = {
            ...data,
            taxonomy: taxonomyData,
            canonicalUrl: (taxonomyData?.omitTaxonomySlug || data.slug === 'all') ? `/${data.slug}` : `/${taxonomyData.slug}/${data.slug}`
        };

        return { pageType: 'category' as const, data: archiveData, categoryArticles, totalPages, articleBottomHtml: '' };
    }

    return null;
}
