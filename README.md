# Waritaku CMS

Waritaku CMS is a headless content management system built with Astro, Cloudflare D1, and Cloudflare R2. It replaces WordPress for multi-site, multi-content-type workloads. The same engine can power a news site, a product catalog, or a store without schema changes.

## Overview

The system uses Astro for server-side rendering and React for admin interfaces. It uses Drizzle ORM for database operations and Cloudflare infrastructure for database and object storage. The system models content with an **EAV / JSON-schema driven** design. Content types (`collections`) are defined in the database as JSON schemas. Every entry's custom fields live in a flexible JSON `data` column. New content types and fields require **zero schema migrations**.

## System Architecture & Features

- **Headless EAV Data Model**: `collections` (content types with JSON field schemas), `entries` (content with JSON `data` column; status: draft / published / scheduled / trashed), `taxonomies` + `terms` + `entry_terms` (classification with routing and prefix options), `entry_revisions` (snapshot history for rollback), `settings` (key-value store), `redirects` / `notFoundLogs` (301 engine + 404 tracking).
- **Universal Slug Engine**: `src/lib/slug.ts` generates slugs that are unique across terms and entries. If a slug is taken, the engine appends `-2`, `-3`, and so on. A category named "Article", a post titled "Article", and a tag named "Article" become `article`, `article-2`, and `article-3`. All three pages work without conflicts.
- **Taxonomy URL System**: Taxonomy archives support long format (`/taxonomy/term`) and short format (`/term`). Each taxonomy sets `entryUrlFormat` (long / short / none). Per-entry `primaryTermId` overrides the collection's taxonomy priority. The entry editor shows a live canonical URL preview.
- **Adapter Pattern**: `src/lib/db.ts` (database adapter) and `src/lib/storage.ts` (storage adapter) prevent vendor lock-in. Swap D1→PostgreSQL or R2→S3 by editing one file.
- **Media CDN Layer**: `src/lib/media.ts` centralizes media URLs. In production, `PUBLIC_MEDIA_BASE_URL` points to the R2 custom domain (for example, `https://r2.waritaku.com`). Media URLs redirect to the CDN with a 301. In local dev, the variable is empty and `/api/images/` serves as the proxy.
- **R2 Render Cache**: Public HTML pages are served from an R2 bucket (`RENDER_CACHE` binding). On the first view, the page renders through SSR and writes the HTML to R2 in the background. Later views read the HTML from R2 with zero D1 queries. Admin and API paths bypass the cache. Cached pages use a one-year TTL. The function `invalidateCachedPage()` clears stale cache on publish.
- **Cache Invalidation**: `src/lib/cache-invalidation.ts` runs when an author publishes or updates an entry. It deletes stale pages from R2 and purges Cloudflare edge cache in parallel. Pages re-render lazily on the next organic visitor request. The system avoids self-fetches to prevent race conditions against edge cache purge propagation.
- **R2 Stored Sitemap Engine**: `src/lib/stored-response.ts` caches sitemaps (`/sitemap.xml`, `/sitemap-entries-[page].xml`, `/sitemap-terms.xml`) directly in R2. Sitemaps update every six hours. Search engine crawlers read sitemaps directly from R2 without consuming D1 read quotas.
- **Postbuild Worker & CSS Hash Aliasing**: `scripts/cf-pages-postbuild.mjs` runs after `astro build`. It moves static assets into `dist/` and detects the active global CSS hash. It generates `dist/_worker.js` with fallback logic. If an R2-cached page requests an older CSS bundle, the worker issues an HTTP 307 redirect to the active stylesheet. Missing static assets return HTTP 404 plain text directly to prevent D1 queries. The worker also runs a scheduled task for D1 `PRAGMA optimize`.
- **Date Archive Modes**: A settings toggle controls date archives (`/2026`, `/2026/08`, `/2026/08/10`). Four modes: `date` (all levels), `month` (year + month), `year` (year only), `off` (all date URLs return 404). When Off, date archive queries are skipped entirely and the calendar widget is hidden.
- **Articles & Pages**: Rich content editing using the React TipTap WYSIWYG editor, custom image alignment, WordPress shortcodes (`[caption]` → `<figure>`, `[faq]` → `<details>`), auto Table of Contents, embed parsing, and revision history with atomic `version` increments.
- **Categories & Tags**: Hierarchical taxonomies with search, sorting, and pagination (50/page) for taxonomies with 10k+ terms. Search matches both name and slug.
- **Modular Block Builder**: Pages and the front page assemble from decoupled layout blocks (heroes, category blocks, article grids) located in `src/components/blocks/` and `src/components/frontpage-blocks/`. The renderer uses Vite `import.meta.glob()` to safely load these components across all OS environments without SSR path crashes.
- **Role-Based Access Control**: Granular `resource:action` permissions (`roles` + `role_permissions` tables). Actions include `read`, `create`, `edit_own`, `edit_others`, `delete_own`, `delete_others`. The admin nav, admin pages, and API routes all enforce permissions. `src/lib/permissions.ts` loads the permission set per session.
- **SEO & Discoverability**: Automated XML sitemap generation (`/sitemap.xml`) with batched canonical URL lookups, dynamic JSON-LD Schema (`NewsArticle`, `WebSite`, `CollectionPage`, `BreadcrumbList`), Open Graph + Twitter Card meta tags (title capped at 60 chars, description at 200), author meta, `ads.txt`, `robots.txt`, markdown content delivery (`Accept: text/markdown` via Turndown), and RFC 9727 API Catalog support (`/.well-known/api-catalog`). Date archives are timezone-aware (Asia/Jakarta UTC+7). The Astro middleware enforces `trailingSlash: 'never'` to securely 301 redirect all trailing slashes and protect SEO value. Multiplex in-feed ads (`archiveInBetweenHtml`) are automatically injected into taxonomy archives.
- **LLM Discovery**: `llms.txt` and `llms-full.txt` serve the site as plain text for AI crawlers. `llms.txt` lists recent articles; `llms-full.txt` contains up to 200 articles with HTML stripped. Both are generated from D1 on request.
- **Internationalization**: `src/i18n/` holds language packs (Indonesian + English). The middleware sets `Astro.locals.t` on every request. Any page can call the translation helper without imports.
- **Security**: Web Crypto PBKDF2 password hashing (plus WordPress `$wp$2y$` bcrypt and legacy phpass handling), `JWT_SECRET` required with no fallback, login rate limiting (5 attempts / 60s), `sanitize-html` (with `allowVulnerableTags: true` to support TipTap rich-embeds) on all user-editable output, soft-delete with trash/restore, security headers (CSP, nosniff, HSTS, X-Frame-Options), and fully parameterized Drizzle queries. The CSP allows Twitter embeds, Google AdSense (pagead2, doubleclick, fundingchoices, SODAR traffic quality), and the Cloudflare Insights beacon.

## Project Structure

```text
waritaku/
├── public/              # Static assets (ads.txt, robots.txt, favicon, local uploads)
├── local_uploads/       # Local media upload folder (dev only)
├── src/
│   ├── assets/          # Raw image and icon assets
│   ├── components/      # React and Astro components (admin + frontend)
│   ├── db/              # Drizzle ORM database schemas
│   ├── i18n/            # Internationalization strings (en/id)
│   ├── layouts/         # Page layout templates (OG/Twitter meta, author, canonical)
│   ├── lib/             # Adapters (db, storage), media, slug engine, render cache, permissions, cache invalidation
│   ├── middleware.ts    # R2 cache short-circuit (markdown-aware), auth, redirects, security headers, RBAC load
│   ├── pages/           # Astro routes and API endpoints
│   │   ├── admin/       # CMS admin dashboard and system docs
│   │   ├── api/         # API endpoints (content, uploads, taxonomies, import, images)
│   │   └── uploads/     # Legacy WordPress image paths (redirect to CDN)
│   ├── styles/          # Global CSS definitions and Tailwind setup
│   └── utils/           # Helper utilities (sanitize, embed parsing, getThumbnail)
├── drizzle/             # Drizzle migration journal + SQL files
├── scripts/             # Setup wizard, WP import, R2 sync, pre-warm, permission seed
├── astro.config.mjs     # Astro and Vite configuration
├── drizzle.config.ts    # Drizzle ORM configuration
└── package.json         # Project dependencies
```

## Quick Start & Installation

1. **Clone and Install**:
   ```bash
   git clone <your-repo-url>
   cd waritaku
   npm install
   ```

2. **Configure the JWT secret** (required — there is no fallback):
   ```bash
   # Local development: create .dev.vars
   echo 'JWT_SECRET="<a-long-random-string>"' > .dev.vars

   # Production: set as a Cloudflare secret
   npx wrangler secret put JWT_SECRET
   ```

3. **Run the Setup Wizard (Recommended)**:
   The interactive CLI Setup Wizard sets up your local database and walks you through migrating your old WordPress data:
   ```bash
   npm run setup
   ```

   *Alternatively, to initialize an empty database without migrating data:*
   ```bash
   npx wrangler d1 migrations apply DB --local
   npm run dev
   ```

4. **WordPress Migration (Manual)**:
   If you didn't use the Setup Wizard, find the complete **WordPress Migration Guide** in the CMS documentation at `http://localhost:4321/admin/docs` after logging in.

## Deploying to Cloudflare (Production)

Deploying a dynamic SSR site with a live database requires specific steps in your Cloudflare Dashboard. If you connect your GitHub repository without configuring the database bindings, your live site will crash.

### 1. Create your Production Database & Buckets
Create the live D1 database and R2 buckets using Wrangler:
```bash
# Create the live D1 database
npx wrangler d1 create waritaku-d1

# Create the live R2 buckets
npx wrangler r2 bucket create waritaku-uploads   # media files (UPLOADS binding)
npx wrangler r2 bucket create waritaku-r1        # render cache (RENDER_CACHE binding)
```

### 2. Configure Cloudflare Pages
Connect your GitHub repository in the Cloudflare Dashboard to create a new Pages project.
1. **Framework Preset**: Select `Astro` (Build command: `npm run build`, Output directory: `dist`).
2. **Environment Variables**: Add `NODE_VERSION` with the value `22`. Add `PUBLIC_MEDIA_BASE_URL` with your R2 custom domain (for example, `https://r2.waritaku.com`). Leave it empty for local dev.
3. **Save and Deploy**: The first deploy may return a 500 error before database bindings are attached. This is expected.

### 3. Bind the Database and Buckets
1. Open your Pages project in Cloudflare Dashboard → **Settings** → **Bindings**.
2. Under **D1 database bindings**, add a binding.
   - Variable name: `DB`
   - D1 database: select your `waritaku-d1` database.
3. Under **R2 bucket bindings**, add two bindings.
   - Variable name: `UPLOADS` → `waritaku-uploads` bucket.
   - Variable name: `RENDER_CACHE` → `waritaku-r1` bucket.
4. Redeploy the project in Cloudflare.

### 4. Initialize Database for New Deployments
The canonical database structure is defined in `drizzle/` migrations. The schema structure must stay identical across all instances. For new deployments, initialize the database using schema migrations or import an existing data dump.

#### Option A: Apply Schema Migrations (New Clean Site)
Run Drizzle migrations to create the standard table structure:
```bash
# Apply migrations to production D1
npx wrangler d1 migrations apply waritaku-d1 --remote
```

#### Option B: Import Existing WordPress or Site Dump
To populate a new site from an existing database dump, use the chunking script. WordPress data dumps often exceed Cloudflare limits (20MB+), causing `SQLITE_TOOBIG` errors. The chunking script processes records safely:

```bash
# 1. Export your source database to a dump file
sqlite3 local.db .dump > local-dump.sql

# 2. Run the chunking upload script
node scripts/push_d1_chunks.mjs
```
*(Update `push_d1_chunks.mjs` if your production database has a custom name).*

### 5. Push your Media
Run the R2 Sync utility to upload all local images to your live bucket:
```bash
npm run push:media
```

## Automated Backups

Cloudflare D1 has built-in Point-in-Time Recovery (Time Travel). Time Travel keeps a continuous backup of the database for 30 days. You can restore the database to any minute in that time.

This repository provides a sample GitHub Actions workflow at `.github/workflows/d1-backup.sample-yml`. To activate automated daily backups:

1. Rename `.github/workflows/d1-backup.sample-yml` to `.github/workflows/d1-backup.yml`.
2. Add these repository secrets:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API token with D1 read and R2 write permissions.
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID.

When enabled, the workflow runs every day at 2:00 AM UTC. It exports the database and uploads the `.sql` backup to your `waritaku-uploads` R2 bucket in `/backups/`. You can also trigger the backup manually from the GitHub Actions tab.

## Development Commands

| Command | Action |
| :--- | :--- |
| `npm run setup` | Launches the interactive Setup & Migration CLI Wizard |
| `npm run push:media` | Syncs your local_uploads folder to Cloudflare R2 |
| `npm install` | Installs project dependencies |
| `npx wrangler d1 migrations apply DB --local` | Applies schema migrations to initialize clean local D1 database |
| `npm run dev` | Starts local dev server at `localhost:4321` |
| `npx astro dev --background` | Starts dev server in background mode |
| `npm run build` | Builds production output and generates postbuild worker |
| `npm run check` | Runs Astro type-checking (`astro check`) |
| `node scripts/prewarm.mjs` | Warms the R2 render cache for published entries and categories |

## Development Rules

- **Database Preservation**: NEVER wipe, delete, or recreate any database (not `.wrangler` nor any replica) unless explicitly requested.
- **Database Concurrency**: Never run heavy SQLite updates in a loop. Use raw SQLite bulk updates instead.
- **Migration Caution**: Do not run migrations blindly on existing databases with content. Always check `d1_migrations` state first. For new site deployments, apply the migrations from `drizzle/` to maintain a consistent schema.
- **Data Integrity**: Do not insert arbitrary or fake data into the database.
- **Security**: Never commit `.env`, `.dev.vars`, or database dump files. Keep `JWT_SECRET` out of source control.
- **Writing Standard**: All documentation prose follows ASD-STE100 Simplified Technical English.
