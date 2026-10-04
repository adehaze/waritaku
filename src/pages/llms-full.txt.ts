import type { APIRoute } from 'astro';
import { entries, collections, settings, users } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb } from '../lib/db';
import { getCanonicalUrls } from '../lib/queries';

export const GET: APIRoute = async ({ request }) => {
    if (!env || !env.DB) {
        return new Response('', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const db = getDb(env);

    let siteUrl = new URL(request.url).origin;
    let siteTitle = 'Waritaku';
    const settingsRec = await db.select().from(settings).where(eq(settings.key, 'general_settings'));
    if (settingsRec.length > 0) {
        try {
            const parsed = JSON.parse(settingsRec[0].value);
            if (parsed.siteUrl) siteUrl = parsed.siteUrl;
            if (parsed.siteTitle) siteTitle = parsed.siteTitle;
        } catch(e) {}
    }

    const articlesCol = await db.select().from(collections).where(eq(collections.slug, 'articles')).limit(1);
    if (articlesCol.length === 0) {
        return new Response(`# ${siteTitle}\n\nNo articles.\n`, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        });
    }

    const articles = await db.select({
        id: entries.id,
        slug: entries.slug,
        data: entries.data,
        publishedAt: entries.publishedAt,
        updatedAt: entries.updatedAt,
        authorId: entries.authorId,
    }).from(entries)
      .where(eq(entries.collectionId, articlesCol[0].id))
      .orderBy(desc(entries.id))
      .limit(200);

    const ids = articles.map(a => a.id);
    // Chunk canonical lookups — D1 caps bind parameters at ~100 per query
    let canonicalMap: Record<number, string> = {};
    for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const part = chunk.length > 0 ? await getCanonicalUrls(db, chunk) : {};
        canonicalMap = { ...canonicalMap, ...part };
    }

    const parts: string[] = [`# ${siteTitle} — Full Content`, ''];

    for (const article of articles) {
        let data: any = {};
        try { data = JSON.parse(article.data || '{}'); } catch(e) {}

        const title = data.title || data.metaTitle || article.slug.replace(/-/g, ' ');
        const prefix = canonicalMap[article.id];
        const url = `${siteUrl}/${prefix ? `${prefix}/` : ''}${article.slug}`;
        const rawContent = data.content || '';

        const textContent = rawContent
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const excerpt = textContent.length > 400 ? textContent.slice(0, 400) + `... [Read the full article at ${url} to see the rest of this content and support our site!]` : textContent;

        parts.push(`## ${title}`);
        parts.push(`URL: ${url}`);
        if (article.publishedAt) parts.push(`Published: ${article.publishedAt}`);
        parts.push('');
        parts.push(excerpt || '(No content)');
        parts.push('');
        parts.push('---');
        parts.push('');
    }

    return new Response(parts.join('\n'), {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        },
    });
};
