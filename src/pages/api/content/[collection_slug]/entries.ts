import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { collections, entries, terms, entryTerms, users } from '../../../../db/schema';
import { eq, and, sql, desc, like, or } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { generateUniqueSlug } from '../../../../lib/slug';
import { hasPermission } from '../../../../lib/permissions';
import { invalidateEntryCache } from '../../../../lib/cache-invalidation';
import { syncCounts } from '../../../../lib/sync-counts';

export const GET: APIRoute = async ({ request, params, locals }) => {
    const user = locals.user;
    const permissions = locals.permissions;
    if (!user || !permissions || !hasPermission(permissions, 'entries', 'read')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const db = getDb(env);
    const { collection_slug } = params;
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const search = url.searchParams.get('search') || '';
    const status = url.searchParams.get('status') || '';
    const date = url.searchParams.get('date') || ''; // YYYY-MM-DD
    const termId = url.searchParams.get('termId') || '';

    try {
        const colRes = await db.select().from(collections).where(eq(collections.slug, collection_slug as string)).limit(1);
        if (colRes.length === 0) {
            return new Response(JSON.stringify({ error: 'Collection not found' }), { status: 404 });
        }
        const collectionId = colRes[0].id;
        const supports = typeof colRes[0].supports === 'string'
            ? JSON.parse(colRes[0].supports || '{}')
            : (colRes[0].supports || {});
        const mappedTitleField = (supports?.mappings?.titleField || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const titlePath = mappedTitleField ? `$.${mappedTitleField}` : '$.title';

        let conditions: any = eq(entries.collectionId, collectionId);
        
        if (search) {
            const searchPattern = `%${search}%`;
            const searchSlugPattern = `%${search.trim().replace(/\s+/g, '-')}%`;
            conditions = and(
                conditions,
                or(
                    like(entries.data, searchPattern),
                    like(entries.slug, searchPattern),
                    like(entries.slug, searchSlugPattern)
                )
            );
        }
        if (status) {
            conditions = and(conditions, eq(entries.status, status));
        }
        if (date) {
            // Match publishedAt string prefix e.g. 2026-08-01
            conditions = and(conditions, like(entries.publishedAt, `${date}%`));
        }
        if (termId) {
            // Find entry IDs that have this termId attached
            const termEntries = await db.select({ entryId: entryTerms.entryId })
                .from(entryTerms)
                .where(eq(entryTerms.termId, parseInt(termId)));
            
            const eIds = termEntries.map(te => te.entryId);
            if (eIds.length > 0) {
                // Because Drizzle in-array can fail with empty array, we only add the condition if eIds has items
                const { inArray } = await import('drizzle-orm');
                conditions = and(conditions, inArray(entries.id, eIds));
            } else {
                // No entries match this term — return empty result immediately
                return new Response(JSON.stringify({ data: [], total: 0, page, limit }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        const countRes = await db.select({ count: sql<number>`count(*)` })
            .from(entries)
            .where(conditions);
        const total = countRes[0]?.count || 0;

        const results = await db.select({
            id: entries.id,
            slug: entries.slug,
            status: entries.status,
            createdAt: entries.createdAt,
            publishedAt: entries.publishedAt,
            authorId: entries.authorId,
            authorName: users.name,
            title: sql<string>`coalesce(json_extract(${entries.data}, ${titlePath}), json_extract(${entries.data}, '$.title'), ${entries.slug})`,
        })
        .from(entries)
        .leftJoin(users, eq(entries.authorId, users.id))
        .where(conditions)
        .orderBy(desc(entries.id))
        .limit(limit)
        .offset((page - 1) * limit);

        // Fetch terms for all returned entries
        const entryIds = results.map(r => r.id);
        
        let allTerms: any[] = [];
        if (entryIds.length > 0) {
            const { inArray } = await import('drizzle-orm');
            const { taxonomies } = await import('../../../../db/schema');
            allTerms = await db.select({
                entryId: entryTerms.entryId,
                termId: terms.id,
                name: terms.name,
                slug: terms.slug,
                taxonomyLabel: taxonomies.label
            })
            .from(entryTerms)
            .innerJoin(terms, eq(entryTerms.termId, terms.id))
            .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
            .where(inArray(entryTerms.entryId, entryIds));
        }

        // Group terms by entryId
        const termsByEntry: Record<number, any[]> = {};
        allTerms.forEach(t => {
            if (!termsByEntry[t.entryId]) termsByEntry[t.entryId] = [];
            termsByEntry[t.entryId].push({ 
                id: t.termId, 
                name: t.name, 
                slug: t.slug,
                taxonomyLabel: t.taxonomyLabel
            });
        });

        const items = results.map(r => ({
            id: r.id,
            slug: r.slug,
            title: r.title || r.slug,
            name: r.title || r.slug,
            status: r.status,
            createdAt: r.createdAt,
            publishedAt: r.publishedAt,
            authorName: r.authorName || 'Unknown',
            authorId: r.authorId,
            terms: termsByEntry[r.id] || []
        }));

        return new Response(JSON.stringify({ data: items, total, page, limit }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: 'An internal error occurred' }), { status: 500 });
    }
};

export const POST: APIRoute = async (ctx) => {
    const { request, params, locals } = ctx;
    const user = locals.user;
    const permissions = locals.permissions;
    if (!user || !permissions || !hasPermission(permissions, 'entries', 'create')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const db = getDb(env);
    const { collection_slug } = params;

    try {
        const colRes = await db.select().from(collections).where(eq(collections.slug, collection_slug as string)).limit(1);
        if (colRes.length === 0) {
            return new Response(JSON.stringify({ error: 'Collection not found' }), { status: 404 });
        }
        const collectionId = colRes[0].id;

        const body = await request.json() as any;
        
        // Extract standard fields
        const { slug, status, publishedAt, selectedTerms, ...customData } = body;

        // Auto-generate slug if missing, and ensure it's universally unique
        let initialSlug = slug;
        if (!initialSlug) {
             const title = customData.title || customData.name || 'entry';
             initialSlug = title;
        }
        let finalSlug = await generateUniqueSlug(db, initialSlug, 'entry');

        // Insert Entry
        const inserted = await db.insert(entries).values({
            collectionId,
            authorId: user.userId,
            slug: finalSlug,
            status: status || 'draft',
            data: JSON.stringify(customData),
            publishedAt: publishedAt || new Date().toISOString()
        }).returning({ id: entries.id });

        const entryId = inserted[0].id;

        // Map Taxonomy Terms
        if (selectedTerms && Array.isArray(selectedTerms) && selectedTerms.length > 0) {
            const valuesToInsert = selectedTerms.map(termId => ({
                entryId,
                termId: parseInt(termId, 10)
            }));
            await db.insert(entryTerms).values(valuesToInsert);
        }

        // Invalidate Cache (non-blocking)
        const tIds = selectedTerms && Array.isArray(selectedTerms) ? selectedTerms.map(t => parseInt(t, 10)) : [];
        const waitCtx = (ctx.locals as any).cfContext || ctx;
        if (waitCtx && waitCtx.waitUntil) {
            waitCtx.waitUntil(invalidateEntryCache(env, collectionId, entryId, finalSlug, tIds));
            waitCtx.waitUntil(syncCounts(db, collectionId, tIds));
        } else {
            invalidateEntryCache(env, collectionId, entryId, finalSlug, tIds).catch(console.error);
            syncCounts(db, collectionId, tIds).catch(console.error);
        }

        return new Response(JSON.stringify({ success: true, id: entryId, slug: finalSlug }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: 'An internal error occurred' }), { status: 500 });
    }
};
