# Cloudflare Pages Deployment Guide for Astro 7

This guide explains how to deploy Astro 7 on Cloudflare Pages.
It shows how to configure bindings in the Cloudflare Dashboard.
It also explains how to upgrade from Astro 5 or Astro 6.

## Critical Rule: Avoid Root Configuration Files

Do not commit a `wrangler.toml` file to the repository root.
Do not commit a `wrangler.json` file to the repository root.

Cloudflare Pages operates in two modes:
1. Dashboard mode
2. Configuration file mode

When Cloudflare Pages detects a configuration file at the repository root, it locks into file mode.
In file mode, Cloudflare Pages ignores bindings in the Cloudflare Dashboard.
Cloudflare Pages can disconnect your existing database and storage bindings.
Keep the repository root free of Wrangler configuration files.

## Cloudflare Dashboard Setup

Configure all bindings in the Cloudflare Dashboard.

### 1. Build Configuration

1. Log in to the Cloudflare Dashboard.
2. Select **Workers & Pages**.
3. Select your Pages project.
4. Open **Settings** > **Builds & deployments**.
5. Set the build command to `npm run build`.
6. Set the build output directory to `dist`.

### 2. Compatibility Flags

1. Open **Settings** > **Functions**.
2. Scroll to the **Compatibility flags** section.
3. Add the `nodejs_compat` flag for both Production and Preview.
4. Set the **Compatibility date** to `2024-09-23` or later.
5. Click **Save**.

### 3. D1 Database Bindings

1. In **Settings** > **Functions**, scroll to **D1 database bindings**.
2. Click **Add binding**.
3. Set the **Variable name** to `DB`.
4. Select your D1 database from the dropdown menu.
5. Repeat for both Production and Preview environments.
6. Click **Save**.

### 4. R2 Bucket Bindings

1. In **Settings** > **Functions**, scroll to **R2 bucket bindings**.
2. Click **Add binding**.
3. Set the **Variable name** to `UPLOADS`.
4. Select your media storage bucket.
5. Click **Add binding** again.
6. Set the **Variable name** to `RENDER_CACHE`.
7. Select your HTML cache bucket.
8. Click **Save**.

### 5. Environment Variables and Secrets

1. Open **Settings** > **Environment variables**.
2. Add plain text variables:
   - `PUBLIC_MEDIA_BASE_URL`: The custom domain for your media bucket.
   - `PUBLIC_TURNSTILE_SITE_KEY`: Your Turnstile site key.
3. Add secret variables with encryption enabled:
   - `JWT_SECRET`: Secret key for authentication tokens.
   - `TURNSTILE_SECRET`: Secret key for Turnstile verification.
   - `RESEND_API_KEY`: API key for email delivery.
   - `CLOUDFLARE_CACHE_TOKEN`: API token for cache purge.
4. Click **Save**.

## Astro Configuration

Configure Astro for Cloudflare Pages server-side rendering.

### `astro.config.mjs`

```javascript
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()]
  }
});
```

### Accessing Bindings in Astro Code

Modern Astro removes `Astro.locals.runtime.env`.
Import `env` from `cloudflare:workers` to access bindings and variables.

```typescript
import { env } from 'cloudflare:workers';
import { getDb } from './lib/db';

// Access D1 database
const db = getDb(env.DB);

// Access R2 buckets
const uploads = env.UPLOADS;
const renderCache = env.RENDER_CACHE;

// Access secrets
const jwtSecret = env.JWT_SECRET;
const turnstileSecret = env.TURNSTILE_SECRET;
```

## Postbuild Script for Cloudflare Pages

Astro generates server output in `dist/server/entry.mjs`.
Cloudflare Pages expects an entrypoint at `dist/_worker.js`.
The build process must also remove auto-generated configuration files.
Use a postbuild script in `scripts/cf-pages-postbuild.mjs`.

### Script Responsibilities

1. Move static client assets to the `dist` root directory.
2. Generate `dist/_worker.js` to route incoming requests.
3. Generate `dist/_routes.json` to allow edge delivery of static assets.
4. Patch bare `crypto` imports in dependencies to `node:crypto`.
5. Delete any `wrangler.json` or `wrangler.toml` file from output directories.

Add the postbuild script to `package.json`:

```json
{
  "scripts": {
    "build": "astro build && node scripts/cf-pages-postbuild.mjs"
  }
}
```

## Upgrade Procedure from Astro 5 or Astro 6

Follow these steps to upgrade an existing project to Astro 7.

### Step 1: Update Package Dependencies

Update the required packages in `package.json`:

```bash
npm install astro@^7.4.11 @astrojs/cloudflare@^14.4.7 @astrojs/react@^7.1.8
```

Update development tools if needed:

```bash
npm install --save-dev @astrojs/check@^0.9.12 wrangler@^4.161.0
```

### Step 2: Replace Deprecated Runtime Access

Search your codebase for `Astro.locals.runtime`.
Astro 6 and Astro 7 remove this property.
Replace all instances with `import { env } from 'cloudflare:workers'`.

Before (Astro 5):
```typescript
const db = context.locals.runtime.env.DB;
```

After (Astro 6 and Astro 7):
```typescript
import { env } from 'cloudflare:workers';
const db = env.DB;
```

### Step 3: Verify Node Built-in Imports

Cloudflare Pages requires the `node:` scheme for Node built-in modules.
External packages like `bcryptjs` might import bare `crypto`.
Make sure your postbuild script rewrites bare `crypto` imports to `node:crypto`.

### Step 4: Test Local Build

Run the build command locally before pushing:

```bash
npm run build
```

Verify that the build creates `dist/_worker.js`.
Verify that no `wrangler.toml` exists in the repository root.

### Step 5: Verify Cloudflare Pages Deployment

1. Commit and push your code to your Git provider.
2. Open the Cloudflare Dashboard.
3. Check the deployment logs under **Deployments**.
4. If database errors occur, verify that `DB` is bound under **Settings** > **Functions**.
