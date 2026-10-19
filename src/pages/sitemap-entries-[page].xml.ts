import type { APIRoute } from 'astro';
import { entries } from '../db/schema';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb } from '../lib/db';
import { getCanonicalUrls, getAllCollectionsCached, getGeneralSettingsCached } from '../lib/queries';
import { serveStoredResponse, SITEMAP_PAGE_SIZE } from '../lib/stored-response';

// Stored in R2 for 24 hours. Deep OFFSET queries are expensive on D1 and crawlers
// fetch these files often. A stale copy is served if D1 fails.
export const GET: APIRoute = async (ctx) =>
    serveStoredResponse(env, `sitemap-entries-v2-${ctx.params.page || '1'}.xml`, 86400, 'application/xml; charset=utf-8', () => buildSitemapPage(ctx), (ctx.locals as any)?.cfContext);

const buildSitemapPage: APIRoute = async ({ params, request }) => {
    if (!env || !env.DB) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', { 
            headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
    }

    const db = getDb(env);

    let siteUrl = new URL(request.url).origin;
    let sitemapCollections: string[] | null = null;
    
    const parsedSettings = await getGeneralSettingsCached(db);
    if (parsedSettings) {
        if (parsedSettings.siteUrl) siteUrl = parsedSettings.siteUrl;
        if (parsedSettings.sitemapCollections !== undefined) sitemapCollections = parsedSettings.sitemapCollections;
    }

    const allCollections = await getAllCollectionsCached(db);
    const page = Math.max(1, parseInt(params.page || '1', 10));
    const CHUNK_SIZE = SITEMAP_PAGE_SIZE;
    const offset = (page - 1) * CHUNK_SIZE;
    
    let allowedColIds: number[] | null = null;
    if (sitemapCollections !== null) {
        if (sitemapCollections.length === 0) {
             allowedColIds = [];
        } else {
             allowedColIds = allCollections
                 .filter((c: any) => sitemapCollections!.includes(c.slug))
                 .map((c: any) => c.id);
        }
    }

    // Step 1: Fetch entry IDs only using covering index (entries_collection_status_id_idx or entries_status_id_idx)
    // so SQLite never loads table rows for rows skipped by OFFSET!
    let entryIds: number[] = [];
    if (allowedColIds !== null) {
        if (allowedColIds.length === 0) {
            entryIds = [];
        } else if (allowedColIds.length === 1) {
            const idRows = await db.select({ id: entries.id })
                .from(entries)
                .where(and(eq(entries.collectionId, allowedColIds[0]), eq(entries.status, 'published')))
                .orderBy(desc(entries.id))
                .limit(CHUNK_SIZE)
                .offset(offset);
            entryIds = idRows.map(r => r.id);
        } else {
            const idRows = await db.select({ id: entries.id })
                .from(entries)
                .where(and(eq(entries.status, 'published'), inArray(entries.collectionId, allowedColIds)))
                .orderBy(desc(entries.id))
                .limit(CHUNK_SIZE)
                .offset(offset);
            entryIds = idRows.map(r => r.id);
        }
    } else {
        const idRows = await db.select({ id: entries.id })
            .from(entries)
            .where(eq(entries.status, 'published'))
            .orderBy(desc(entries.id))
            .limit(CHUNK_SIZE)
            .offset(offset);
        entryIds = idRows.map(r => r.id);
    }

    if (entryIds.length === 0) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', { 
            headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
    }

    // Step 2: Fetch slug + timestamps by PK in chunks of 50
    const pageEntriesRaw: any[] = [];
    let canonicalMap: Record<number, string> = {};
    
    for (let i = 0; i < entryIds.length; i += 50) {
        const chunk = entryIds.slice(i, i + 50);
        if (chunk.length > 0) {
            const rows = await db.select({
                id: entries.id,
                slug: entries.slug,
                updatedAt: entries.updatedAt,
                publishedAt: entries.publishedAt
            }).from(entries).where(inArray(entries.id, chunk));
            pageEntriesRaw.push(...rows);

            const part = await getCanonicalUrls(db, chunk, allCollections);
            canonicalMap = { ...canonicalMap, ...part };
        }
    }

    const entryById = new Map(pageEntriesRaw.map(e => [e.id, e]));
    const pageEntries = entryIds.map(id => entryById.get(id)).filter(Boolean);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    for (const entry of pageEntries) {
        xml += `  <url>\n`;
        const prefix = canonicalMap[entry.id];
        const urlPath = prefix ? `${prefix}/${entry.slug}` : entry.slug;
        xml += `    <loc>${siteUrl}/${urlPath}</loc>\n`;
        const date = entry.updatedAt || entry.publishedAt;
        if (date) {
            xml += `    <lastmod>${date.split('T')[0]}</lastmod>\n`;
        }
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.8</priority>\n`;
        xml += `  </url>\n`;
    }

    xml += `</urlset>`;

    return new Response(xml, {
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        },
    });
};
