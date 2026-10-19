import { defineMiddleware } from 'astro:middleware';
import { verifySessionCookie } from './lib/auth';
import { getDb } from './lib/db';
import { redirects, notFoundLogs, settings } from './db/schema';
import { eq, sql } from 'drizzle-orm';
import { getCachedPage, cacheRenderedPage, isBypassRequest } from './lib/render-cache';
import { loadUserPermissions } from './lib/permissions';
import { useTranslation } from './i18n';
import { env } from 'cloudflare:workers';

// Paths that must never be served from the R2 render cache.
// Static file extensions are matched by the dot check further below.
// /search is excluded because results are query-string-dependent and must always be live.
const CACHE_BYPASS_PREFIXES = ['/admin', '/api', '/uploads', '/@', '/node_modules', '/search'];

function isPublicHtmlPath(pathname: string): boolean {
    // Skip any path that belongs to a bypass prefix
    if (CACHE_BYPASS_PREFIXES.some(p => pathname.startsWith(p))) return false;
    // Skip static assets (anything with a file extension)
    const lastSegment = pathname.split('/').pop() ?? '';
    if (lastSegment.includes('.')) return false;
    return true;
}

const SETTINGS_CACHE_TTL = 600;   // 10 minutes
const REDIRECTS_CACHE_TTL = 600;  // 10 minutes
const SETTINGS_CACHE_KEY = 'https://waritaku.internal/cache/general_settings';
const REDIRECTS_CACHE_KEY = 'https://waritaku.internal/cache/redirects';

let _memSettings: { data: any; ts: number } | null = null;
let _memRedirects: { data: any; ts: number } | null = null;

function isZeroDbPublicRoute(pathname: string): boolean {
    if (
        pathname.startsWith('/uploads/') ||
        pathname.startsWith('/_astro/') ||
        pathname.startsWith('/api/widgets/') ||
        pathname === '/robots.txt' ||
        pathname === '/ads.txt' ||
        pathname === '/llms.txt' ||
        pathname === '/llms-full.txt' ||
        (pathname.startsWith('/sitemap') && pathname.endsWith('.xml'))
    ) {
        return true;
    }
    return false;
}

async function getCfCacheJson(key: string) {
    if (typeof caches === 'undefined') return null;
    const res = await caches.default.match(new Request(key));
    if (!res) return null;
    try { return await res.json(); } catch { return null; }
}

function setCfCacheJson(key: string, data: any, ttl: number) {
    if (typeof caches === 'undefined') return;
    const res = new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl }
    });
    caches.default.put(new Request(key), res).catch(() => {});
}

export const onRequest = defineMiddleware(async (context, next) => {
    const url = new URL(context.request.url);

    // 1. Force trailing slash redirect (except root)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
        url.pathname = url.pathname.slice(0, -1);
        return context.redirect(url.toString(), 301);
    }

    // --- Intercept legacy WP /feed URLs ---
    if (url.pathname.endsWith('/feed') || url.pathname.endsWith('/feed/')) {
        const cleanPath = url.pathname.replace(/\/feed\/?$/, '');
        return context.redirect(cleanPath || '/', 301);
    }

    // Fast-path for uploads, static assets, edge-cached widgets, and stored sitemaps/txt files:
    // Never touch D1 in middleware for these paths.
    if (isZeroDbPublicRoute(url.pathname)) {
        return next();
    }

    // --- R2 Render Cache short-circuit ---
    // Runs before any D1 query. Visitor read traffic for public HTML pages
    // is served entirely from R2 + Cloudflare edge cache.
    // NOTE: requests asking for text/markdown or application/json bypass the
    // cache so the SSR route can run its markdown conversion (cached HTML is
    // not markdown).
    const wantsMarkdown = (context.request.headers.get('Accept') || '').includes('text/markdown')
        || (context.request.headers.get('Accept') || '').includes('application/json');
    if (isPublicHtmlPath(url.pathname) && !isBypassRequest(context.request) && !wantsMarkdown) {
        const cached = await getCachedPage(env, url.pathname);
        if (cached) {
            // Apply security headers to cached responses too
            cached.headers.set('X-Content-Type-Options', 'nosniff');
            cached.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
            cached.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            return cached;
        }
    }
    // Cache MISS (or non-cacheable path) — fall through to the normal SSR path below.

    let db;
    try {
        db = getDb(env);
    } catch (err: any) {
        const errorMsg = `Initialization Error: ${err.message}. Env keys available: ${env ? JSON.stringify(Object.keys(env)) : 'none'}`;
        const padding = ' '.repeat(512); // Prevent Chrome from hiding small 500 responses
        return new Response(`${errorMsg}\n\n${padding}`, { status: 500, headers: { 'Content-Type': 'text/plain' }});
    }

    const isApiRoute = url.pathname.startsWith('/api');
    const isAdminRoute = url.pathname.startsWith('/admin');

    let enableRedirections = true;
    let enable404Tracking = true;
    let generalSettings: any = null;

    // API routes do not use generalSettings, i18n, or URL redirects
    if (db && !isApiRoute) {
        if (_memSettings && Date.now() - _memSettings.ts < SETTINGS_CACHE_TTL * 1000) {
            generalSettings = _memSettings.data;
        } else {
            generalSettings = await getCfCacheJson(SETTINGS_CACHE_KEY);
            if (generalSettings) {
                _memSettings = { data: generalSettings, ts: Date.now() };
            }
        }
        if (!generalSettings) {
            try {
                const configRow = await db.select().from(settings).where(eq(settings.key, 'general_settings')).get();
                if (configRow) {
                    generalSettings = JSON.parse(configRow.value);
                    _memSettings = { data: generalSettings, ts: Date.now() };
                    setCfCacheJson(SETTINGS_CACHE_KEY, generalSettings, SETTINGS_CACHE_TTL);
                }
            } catch(e) {
                generalSettings = _memSettings?.data || null;
            }
        }
        if (generalSettings) {
            enableRedirections = generalSettings.enableRedirections !== false;
            enable404Tracking = generalSettings.enable404Tracking !== false;
            (context.locals as any).generalSettings = generalSettings;
        }
    }

    // Set up i18n from the cached config language
    const language = generalSettings?.language || 'id';
    context.locals.t = useTranslation(language);

    // --- 0. Redirect Engine (Public non-admin, non-API routes only) ---
    if (db && enableRedirections && !isApiRoute && !isAdminRoute) {
        let redirectMap: any = null;
        if (_memRedirects && Date.now() - _memRedirects.ts < REDIRECTS_CACHE_TTL * 1000) {
            redirectMap = _memRedirects.data;
        } else {
            redirectMap = await getCfCacheJson(REDIRECTS_CACHE_KEY);
            if (redirectMap) {
                _memRedirects = { data: redirectMap, ts: Date.now() };
            }
        }
        if (!redirectMap) {
            try {
                const allRedirects = await db.select().from(redirects).all();
                redirectMap = {};
                for (const r of allRedirects) {
                    redirectMap[r.sourceUrl] = r;
                }
                _memRedirects = { data: redirectMap, ts: Date.now() };
                setCfCacheJson(REDIRECTS_CACHE_KEY, redirectMap, REDIRECTS_CACHE_TTL);
            } catch (e) {
                console.error('Failed to fetch redirects cache', e);
                redirectMap = _memRedirects?.data || {};
            }
        }
        
        const redirect = redirectMap[url.pathname];
        if (redirect) {
            // Increment hit counter asynchronously without blocking the response
            const updatePromise = db.update(redirects).set({ hits: sql`${redirects.hits} + 1` }).where(eq(redirects.id, redirect.id)).execute();
            let ctx = (context.locals as any).cfContext;
            if (!ctx) {
                try { ctx = (context.locals as any).runtime?.ctx; } catch(e) {}
            }
            if (!ctx) {
                ctx = (context.locals as any).ctx || (context.locals as any).runtime;
            }
            if (ctx && ctx.waitUntil) {
                ctx.waitUntil(updatePromise);
            } else {
                updatePromise.catch(console.error);
            }
            return context.redirect(redirect.targetUrl, redirect.statusCode as 301 | 302);
        }
    }

    // 2. Protect /admin and /api routes (except public auth routes)
    const publicAdminRoutes = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'];
    const publicApiAuthRoutes = ['/api/auth/login', '/api/auth/logout', '/api/auth/forgot-password', '/api/auth/reset-password'];
    if ((isAdminRoute && !publicAdminRoutes.includes(url.pathname)) || (isApiRoute && !publicApiAuthRoutes.includes(url.pathname))) {
        const sessionCookie = context.cookies.get('session')?.value;
        
        if (!sessionCookie) {
            if (isApiRoute) {
                // Let the API route handle the missing user context (it will see locals.user is undefined)
            } else {
                return context.redirect('/admin/login', 302);
            }
        } else {
            const payload = await verifySessionCookie(sessionCookie, env?.JWT_SECRET);
            if (payload) {
                context.locals.user = {
                    userId: payload.userId,
                    role: payload.role,
                    name: payload.name,
                    email: payload.email
                };
                // Load permission set for this role (single DB query, cached by role)
                context.locals.permissions = await loadUserPermissions(db, payload.role);
            } else {
                context.cookies.delete('session', { path: '/' });
                if (isApiRoute) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
                }
                return context.redirect('/admin/login', 302);
            }
        }
    }
    
    try {
        const raw = await next();

        // Response.redirect() and some Astro internals return responses with immutable
        // headers. Wrap in a new Response so we can always set security headers safely.
        const response = new Response(raw.body, {
            status: raw.status,
            statusText: raw.statusText,
            headers: new Headers(raw.headers),
        });

        // --- 3. Security headers ---
        // CSP: 'unsafe-inline' needed for Astro is:inline scripts; script-src includes
        // Twitter embed + Google AdSense (pagead2, doubleclick, fundingchoices, tpc,
        // adtrafficquality SODAR) + Cloudflare Insights beacon + Disqus comments
        // (waritaku.disqus.com + disquscdn.com assets); connect-src covers
        // AdSense API + SODAR + Chrome RUM (csi.gstatic.com — separate from *.google.com);
        // frame-src allows embeds (YouTube, Twitter, Vimeo, Spotify, SoundCloud, AdSense iframes)
        response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://platform.twitter.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://static.doubleclick.net https://fundingchoicesmessages.google.com https://static.cloudflareinsights.com https://*.adtrafficquality.google https://*.disqus.com https://*.disquscdn.com https://d-code.liadm.com; style-src 'self' 'unsafe-inline' https://*.disquscdn.com; img-src 'self' https: data:; font-src 'self'; connect-src 'self' https://pagead2.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com https://*.cloudflareinsights.com https://*.gstatic.com https://*.disqus.com https://*.disquscdn.com https://d-code.liadm.com; frame-src https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com https://platform.twitter.com https://twitter.com https://x.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://www.google.com https://www.googletagservices.com https://fundingchoicesmessages.google.com https://*.adtrafficquality.google https://*.disqus.com https://disqus.com https://*.disquscdn.com");
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        if (url.pathname.startsWith('/admin')) {
            response.headers.set('X-Frame-Options', 'DENY');
        }

        // --- Search pages must never be cached by Cloudflare edge ---
        // Our R2 layer already skips /search (CACHE_BYPASS_PREFIXES), but CF
        // edge cache sits in front of the Worker and caches based on
        // Cache-Control headers. Setting no-store here prevents CF from ever
        // serving a stale search result to another visitor.
        if (url.pathname.startsWith('/search')) {
            response.headers.set('Cache-Control', 'private, no-store');
            response.headers.set('Vary', 'Accept');
        }
        // --- R2 lazy cache population ---
        // On a cache MISS, if SSR returned a 200 HTML page for a public path,
        // write the rendered HTML to R2 in the background so the next request
        // is served from cache with zero D1 queries. The response is cloned
        // here (body stream tee) — no self-fetch, no second SSR pass.
        let ctx = (context.locals as any).cfContext;
        if (!ctx) {
            try { ctx = (context.locals as any).runtime?.ctx; } catch(e) {}
        }
        if (!ctx) {
            ctx = (context.locals as any).ctx || (context.locals as any).runtime;
        }
        if (
            response.status === 200 &&
            (response.headers.get('Content-Type') ?? '').includes('text/html') &&
            isPublicHtmlPath(url.pathname)
        ) {
            const cacheClone = response.clone();
            cacheRenderedPage(env, url.pathname, cacheClone, ctx);
        }

        // --- 4. 404 Logging Engine ---
        if (response.status === 404 && db && enable404Tracking) {
            // Skip logging for Vite internal files during dev to prevent noise
            if (!url.pathname.startsWith('/@') && !url.pathname.startsWith('/node_modules') && url.pathname !== '/favicon.ico') {
                 const logPromise = db.insert(notFoundLogs)
                      .values({ url: url.pathname, hits: 1 })
                      .onConflictDoUpdate({
                          target: notFoundLogs.url,
                          set: { hits: sql`${notFoundLogs.hits} + 1`, lastSeen: new Date().toISOString() }
                      }).execute();
                      
                 if (ctx && ctx.waitUntil) {
                     ctx.waitUntil(logPromise);
                 } else {
                     logPromise.catch(console.error); // Fire and forget in local dev
                 }
            }
        }

        return response;
    } catch (e: any) {
        return new Response(`Error: ${e.message}\nStack: ${e.stack}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
});
