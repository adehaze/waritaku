import fs from 'fs';
import path from 'path';

const workerSrc = 'dist/server/entry.mjs';
const workerDest = 'dist/_worker.js';

// Move static assets from dist/client/ to dist/ first so we can inspect dist/_astro
if (fs.existsSync('dist/client')) {
  const clientFiles = fs.readdirSync('dist/client');
  for (const f of clientFiles) {
    fs.renameSync(path.join('dist/client', f), path.join('dist', f));
  }
  fs.rmdirSync('dist/client');
  console.log('✓ Moved client assets to dist root');
}

// Find the active global CSS file name in dist/_astro
let currentGlobalCss = '';
const astroDir = 'dist/_astro';
if (fs.existsSync(astroDir)) {
  const files = fs.readdirSync(astroDir);
  const found = files.find(f => f.startsWith('global.') && f.endsWith('.css'));
  if (found) {
    currentGlobalCss = found;
    console.log(`✓ Detected active global CSS: ${currentGlobalCss}`);
  }
}

// Check if Astro generated a server entrypoint
if (fs.existsSync(workerSrc)) {
  // Re-export the worker with:
  // 1. Fallback redirect for outdated global CSS hashes requested by R2-cached HTML pages
  // 2. Fast static asset serving via env.ASSETS
  // 3. Fallback 404 responses for truly missing static files to prevent D1 queries
  // 4. Scheduled handler for D1 PRAGMA optimize
  const workerCode = `
import astroApp from './server/entry.mjs';

const CURRENT_GLOBAL_CSS = ${JSON.stringify(currentGlobalCss)};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Fallback for outdated global CSS hashes in R2 cached pages:
    if (CURRENT_GLOBAL_CSS && url.pathname.startsWith('/_astro/global.') && url.pathname.endsWith('.css') && !url.pathname.includes(CURRENT_GLOBAL_CSS)) {
      const targetUrl = new URL('/_astro/' + CURRENT_GLOBAL_CSS, request.url);
      return Response.redirect(targetUrl.toString(), 307);
    }

    // 2. Serve static assets via Cloudflare Pages ASSETS binding (GET/HEAD only)
    if (env && env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status < 400) {
        return asset;
      }
    }

    // 3. Stop truly missing Astro bundle assets from falling through to Astro catch-all slug route or D1 queries.
    if (url.pathname.startsWith('/_astro/')) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' }
      });
    }

    return astroApp.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    if (env.DB) {
      console.log('Running PRAGMA optimize on D1...');
      await env.DB.prepare('PRAGMA optimize;').run();
      console.log('PRAGMA optimize complete.');
    }
  }
};
`;
  fs.writeFileSync(workerDest, workerCode);
  console.log('✓ Generated dist/_worker.js for Cloudflare Pages compatibility');

  // Generate _routes.json so Cloudflare Pages CDN serves static assets directly at the edge
  const routesJson = {
    version: 1,
    include: ['/*'],
    exclude: [
      '/_astro/*',
      '/favicon.svg',
      '/favicon.ico',
      '/robots.txt',
      '/ads.txt',
      '/placeholder.webp',
      '/cats.txt'
    ]
  };
  fs.writeFileSync('dist/_routes.json', JSON.stringify(routesJson, null, 2));
  console.log('✓ Generated dist/_routes.json for Cloudflare Edge static routing');
}

// Remove Astro's auto-generated wrangler configs to unlock Cloudflare Dashboard bindings!
// If Cloudflare Pages detects wrangler.json or .wrangler/deploy/config.json, it locks 
// the Cloudflare Dashboard and forces you to use the file for bindings.
// By deleting these, we allow you to configure D1 and R2 directly in the Cloudflare Dashboard.
const generatedWrangler = 'dist/server/wrangler.json';
const deployConfig = '.wrangler/deploy/config.json';
const rootWranglerDeploy = '.wrangler';

if (fs.existsSync(generatedWrangler)) {
  fs.unlinkSync(generatedWrangler);
  console.log('✓ Deleted dist/server/wrangler.json to unlock Dashboard bindings');
}

if (fs.existsSync(deployConfig)) {
  fs.unlinkSync(deployConfig);
  console.log('✓ Deleted .wrangler/deploy/config.json to unlock Dashboard bindings');
}

// Safe cleanup of only the .wrangler/deploy folder to not destroy the local DB
if (fs.existsSync('.wrangler/deploy')) {
  try {
    fs.rmdirSync('.wrangler/deploy');
  } catch (e) {
    // Ignore errors if not empty
  }
}
