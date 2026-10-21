import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { getDb } from '../lib/db';
import { getGeneralSettingsCached, getAllCollectionsCached } from '../lib/queries';
import { serveStoredResponse, SITEMAP_PAGE_SIZE } from '../lib/stored-response';

const build: APIRoute = async ({ request }) => {
    
    // Fallback if env is missing during build time
    if (!env || !env.DB) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>', { 
            headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
    }

    const db = getDb(env);

    let siteUrl = new URL(request.url).origin;
    let sitemapCollections: string[] | null = null;
    let sitemapTaxonomies: string[] | null = null;
    
    const parsed = await getGeneralSettingsCached(db);
    if (parsed.siteUrl) siteUrl = parsed.siteUrl;
    if (parsed.sitemapCollections !== undefined) sitemapCollections = parsed.sitemapCollections;
    if (parsed.sitemapTaxonomies !== undefined) sitemapTaxonomies = parsed.sitemapTaxonomies;

    // 1. Count Total Published Entries from cached collections
    const allCols = await getAllCollectionsCached(db);
    let totalEntries = 0;
    
    if (sitemapCollections !== null && sitemapCollections.length === 0) {
        totalEntries = 0;
    } else {
        const filteredCols = sitemapCollections !== null
            ? allCols.filter((c: any) => sitemapCollections!.includes(c.slug))
            : allCols;
        totalEntries = filteredCols.reduce((sum: number, c: any) => sum + Number(c.entryCount || 0), 0);
    }
    const CHUNK_SIZE = SITEMAP_PAGE_SIZE;
    const totalEntryPages = Math.max(1, Math.ceil(totalEntries / CHUNK_SIZE));

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    // 1. Entries Sitemaps (Chunked by SITEMAP_PAGE_SIZE)
    for (let p = 1; p <= totalEntryPages; p++) {
        if (totalEntries > 0) {
            xml += `  <sitemap>\n    <loc>${siteUrl}/sitemap-entries-${p}.xml</loc>\n  </sitemap>\n`;
        }
    }

    // 2. Terms Sitemap (Categories and Tags)
    if (sitemapTaxonomies === null || sitemapTaxonomies.length > 0) {
        xml += `  <sitemap>\n    <loc>${siteUrl}/sitemap-terms.xml</loc>\n  </sitemap>\n`;
    }

    xml += `</sitemapindex>`;

    return new Response(xml, {
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        },
    });
};

export const GET: APIRoute = async (ctx) =>
    serveStoredResponse(env, 'sitemap-index-v2.xml', 21600, 'application/xml; charset=utf-8', () => build(ctx), (ctx.locals as any)?.cfContext);
