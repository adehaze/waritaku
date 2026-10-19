import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  role: text('role').notNull().default('user'), // references roles.slug
  firstName: text('first_name'),
  lastName: text('last_name'),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  socialLinks: text('social_links'), // JSON string
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Role-Based Access Control ─────────────────────────────────────────────────

export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),  // e.g. 'admin', 'editor', 'writer'
  label: text('label').notNull(),
  description: text('description'),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false), // protects superadmin/admin from deletion
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const rolePermissions = sqliteTable('role_permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roleId: integer('role_id').references(() => roles.id, { onDelete: 'cascade' }).notNull(),
  resource: text('resource').notNull(), // e.g. 'entries', 'media', 'taxonomies'
  action: text('action').notNull(),     // e.g. 'read', 'create', 'edit_own', 'edit_others', 'delete_own', 'delete_others'
}, (t) => ({
  roleResourceIdx: index('role_permissions_role_resource_idx').on(t.roleId, t.resource),
}));



export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const redirects = sqliteTable('redirects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceUrl: text('source_url').notNull().unique(), // The broken link
  targetUrl: text('target_url').notNull(), // The destination
  statusCode: integer('status_code').notNull().default(301), // 301 or 302
  hits: integer('hits').notNull().default(0), // Total redirects served
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const notFoundLogs = sqliteTable('not_found_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull().unique(), // The broken link
  hits: integer('hits').notNull().default(1), // Total times it was hit
  lastSeen: text('last_seen').notNull().$defaultFn(() => new Date().toISOString()),
});

// ────────────────────────────────────────────────────────────────────────────
// Headless CMS Architecture (EAV / JSON-Schema driven)
// ────────────────────────────────────────────────────────────────────────────

export const collections = sqliteTable('collections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // e.g. 'posts', 'products', 'pages'
  label: text('label').notNull(), // e.g. 'Blog Posts'
  labelSingular: text('label_singular').notNull(), // e.g. 'Post'
  description: text('description'),
  icon: text('icon').notNull().default('FileText'),
  routePrefix: text('route_prefix').notNull().default('/'), // e.g. '/' or '/blog'
  fields: text('fields').notNull().default('[]'), // JSON array defining the visual schema
  supports: text('supports').notNull().default('{}'), // JSON object (drafts, revisions, etc)
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }), // NULL = system-owned
  entryCount: integer('entry_count').notNull().default(0),
});

export const entries = sqliteTable('entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  collectionId: integer('collection_id').references(() => collections.id, { onDelete: 'restrict' }).notNull(),
  slug: text('slug').notNull().unique(),
  status: text('status').notNull().default('draft'), // draft, published, scheduled, trashed
  authorId: integer('author_id').references(() => users.id),
  data: text('data').notNull().default('{}'), // JSON column containing all custom field values
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  publishedAt: text('published_at'),
  deletedAt: text('deleted_at'),
  version: integer('version').notNull().default(1),
}, (t) => ({
  statusIdx: index('entries_status_idx').on(t.status),
  collectionIdx: index('entries_collection_idx').on(t.collectionId),
  authorIdx: index('entries_author_idx').on(t.authorId),
  authorCollectionStatusIdIdx: index('entries_author_collection_status_id_idx').on(t.authorId, t.collectionId, t.status, t.id),
  compositeSortIdx: index('entries_collection_status_published_idx').on(t.collectionId, t.status, t.publishedAt),
  collectionStatusIdIdx: index('entries_collection_status_id_idx').on(t.collectionId, t.status, t.id),
  statusIdIdx: index('entries_status_id_idx').on(t.status, t.id),
}));

export const entryRevisions = sqliteTable('entry_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entryId: integer('entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  authorId: integer('author_id').references(() => users.id),
  data: text('data').notNull(), // JSON snapshot of the entry (including slug, status, custom fields, and terms)
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  entryIdx: index('entry_revisions_entry_idx').on(t.entryId),
}));

export const taxonomies = sqliteTable('taxonomies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // e.g. 'categories', 'tags', 'product-categories'
  label: text('label').notNull(),
  description: text('description'),
  allowedCollections: text('allowed_collections').notNull().default('[]'), // JSON array of collection slugs
  isRouted: integer('is_routed', { mode: 'boolean' }).notNull().default(false), // e.g., creates an archive page for terms
  prefixEntryUrl: integer('prefix_entry_url', { mode: 'boolean' }).notNull().default(false), // e.g., /category/article-slug
  entryUrlFormat: text('entry_url_format').notNull().default('default'), // 'long', 'short', 'none', 'default' (fallback to prefixEntryUrl)
  allowIndexing: integer('allow_indexing', { mode: 'boolean' }).notNull().default(true), // SEO robots indexing for term pages
  omitTaxonomySlug: integer('omit_taxonomy_slug', { mode: 'boolean' }).notNull().default(false), // false = /taxonomy/term, true = /term
  umbrellaViewMode: text('umbrella_view_mode').notNull().default('child_terms'), // 'child_terms' or 'all_entries'
  umbrellaItemsPerPage: integer('umbrella_items_per_page').notNull().default(0), // 0 = fetch all, > 0 = pagination limit
  umbrellaAllowIndexing: integer('umbrella_allow_indexing', { mode: 'boolean' }).notNull().default(true), // SEO robots indexing for umbrella page
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }), // NULL = system-owned
  allowInlineCreation: integer('allow_inline_creation', { mode: 'boolean' }).notNull().default(false), // Toggle for inline term creation
  inlineSearchHint: text('inline_search_hint'), // Custom text to display below the search bar
});

export const terms = sqliteTable('terms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taxonomyId: integer('taxonomy_id').references(() => taxonomies.id, { onDelete: 'cascade' }).notNull(),
  parentId: integer('parent_id'), // Hierarchical term support
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }), // NULL = system-owned
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  entryCount: integer('entry_count').notNull().default(0),
}, (t) => ({
  taxonomyIdx: index('terms_taxonomy_idx').on(t.taxonomyId),
  parentIdx: index('terms_parent_idx').on(t.parentId),
  slugUnique: uniqueIndex('terms_slug_unique').on(t.slug),
}));

export const entryTerms = sqliteTable('entry_terms', {
  entryId: integer('entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  termId: integer('term_id').references(() => terms.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.entryId, t.termId] }),
  termEntryIdx: index('entry_terms_term_entry_idx').on(t.termId, t.entryId),
}));

export const passwordResets = sqliteTable('password_resets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

