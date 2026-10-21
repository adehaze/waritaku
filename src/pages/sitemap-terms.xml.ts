import type { APIRoute } from 'astro';
import { terms, taxonomies } from '../db/schema';
import { eq, inArray, and, gt, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb } from '../lib/db';
import { getGeneralSettingsCached } from '../lib/queries';
import { serveStoredResponse } from '../lib/stored-response';

const build: APIRoute = async ({ request }) => {
    if (!env || !env.DB) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', { 
            headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
    }

    const db = getDb(env);

    let siteUrl = new URL(request.url).origin;
    let sitemapTaxonomies: string[] | null = null;
    
    const parsed = await getGeneralSettingsCached(db);
    if (parsed.siteUrl) siteUrl = parsed.siteUrl;
    if (parsed.sitemapTaxonomies !== undefined) sitemapTaxonomies = parsed.sitemapTaxonomies;

    let condition: any = and(
        eq(taxonomies.isRouted, true),
        eq(taxonomies.allowIndexing, true),
        gt(terms.entryCount, 0)
    );

    if (sitemapTaxonomies !== null) {
        if (sitemapTaxonomies.length === 0) {
            condition = sql`1=0`;
        } else {
            condition = and(
                eq(taxonomies.isRouted, true),
                eq(taxonomies.allowIndexing, true),
                gt(terms.entryCount, 0),
                inArray(taxonomies.slug, sitemapTaxonomies)
            );
        }
    }

    const allTerms = await db.select({
        slug: terms.slug,
        taxonomySlug: taxonomies.slug,
        omitTaxonomySlug: taxonomies.omitTaxonomySlug
    })
    .from(terms)
    .innerJoin(taxonomies, eq(terms.taxonomyId, taxonomies.id))
    .where(condition);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    // 1. Homepage
    xml += `  <url>\n    <loc>${siteUrl}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;

    // 2. Terms
    allTerms.forEach(term => {
        const urlPath = term.omitTaxonomySlug ? term.slug : `${term.taxonomySlug}/${term.slug}`;
        xml += `  <url>\n`;
        xml += `    <loc>${siteUrl}/${urlPath}</loc>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.5</priority>\n`;
        xml += `  </url>\n`;
    });

    xml += `</urlset>`;

    return new Response(xml, {
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        },
    });
};

export const GET: APIRoute = async (ctx) =>
    serveStoredResponse(env, 'sitemap-terms.xml', 21600, 'application/xml; charset=utf-8', () => build(ctx), (ctx.locals as any)?.cfContext);
