/**
 * RBAC Permission Library
 *
 * Resources: entries, media, taxonomies, taxonomy_terms, users,
 *            settings, content_builder, taxonomy_builder, layout,
 *            redirects, system
 *
 * Actions: read, create, edit_own, edit_others, delete_own, delete_others
 */

export type Resource =
    | 'entries' | 'media' | 'taxonomies' | 'taxonomy_terms'
    | 'users' | 'settings' | 'content_builder' | 'taxonomy_builder'
    | 'layout' | 'redirects' | 'system' | 'roles';

export type Action =
    | 'read' | 'create' | 'edit_own' | 'edit_others'
    | 'delete_own' | 'delete_others';

/**
 * A flat set of "resource:action" strings for a user's role.
 * e.g. Set { "entries:read", "entries:create", "entries:edit_own" }
 */
export type PermissionSet = Set<string>;

/**
 * Build a permission key string.
 */
export function permKey(resource: Resource, action: Action): string {
    return `${resource}:${action}`;
}

/**
 * Check if a permission set contains a specific resource+action.
 */
export function hasPermission(permissions: PermissionSet, resource: Resource, action: Action): boolean {
    return permissions.has(permKey(resource, action));
}

/**
 * Check any one of multiple actions for a given resource.
 */
export function hasAnyPermission(permissions: PermissionSet, resource: Resource, actions: Action[]): boolean {
    return actions.some(a => hasPermission(permissions, resource, a));
}

/**
 * Load permission set for a given role slug from the database.
 * Returns an empty set if the role has no permissions configured,
 * allowing safe fallback without crashing.
 */
// In-memory permission cache keyed by role slug.
// Permissions change rarely so a 5-minute TTL keeps DB queries almost to zero.
const _permCache = new Map<string, { set: PermissionSet; ts: number }>();
const PERM_CACHE_TTL = 15 * 60_000; // 15 minutes

const ALL_RESOURCES: Resource[] = [
    'entries', 'media', 'taxonomies', 'taxonomy_terms',
    'users', 'settings', 'content_builder', 'taxonomy_builder',
    'layout', 'redirects', 'system', 'roles'
];
const ALL_ACTIONS: Action[] = [
    'read', 'create', 'edit_own', 'edit_others', 'delete_own', 'delete_others'
];

function buildFallbackPermissions(roleSlug: string): PermissionSet {
    const set: PermissionSet = new Set();
    if (roleSlug === 'superadmin' || roleSlug === 'admin') {
        for (const r of ALL_RESOURCES) {
            for (const a of ALL_ACTIONS) {
                set.add(`${r}:${a}`);
            }
        }
    } else if (roleSlug === 'editor') {
        for (const r of ['entries', 'media', 'taxonomies', 'taxonomy_terms'] as Resource[]) {
            for (const a of ALL_ACTIONS) {
                set.add(`${r}:${a}`);
            }
        }
    } else if (roleSlug === 'writer' || roleSlug === 'author') {
        for (const a of ['read', 'create', 'edit_own', 'delete_own'] as Action[]) {
            set.add(`entries:${a}`);
            set.add(`media:${a}`);
        }
        set.add('taxonomies:read');
        set.add('taxonomy_terms:read');
        set.add('taxonomy_terms:create');
    }
    return set;
}

export async function loadUserPermissions(db: any, roleSlug: string): Promise<PermissionSet> {
    const set: PermissionSet = new Set();
    if (!roleSlug) return set;

    const cached = _permCache.get(roleSlug);
    if (cached && Date.now() - cached.ts < PERM_CACHE_TTL) {
        return cached.set;
    }

    const cfCacheKey = `https://waritaku.internal/cache/role_perms_${roleSlug}`;
    if (typeof caches !== 'undefined') {
        try {
            const hit = await caches.default.match(new Request(cfCacheKey));
            if (hit) {
                const arr: string[] = await hit.json();
                if (Array.isArray(arr) && arr.length > 0) {
                    const edgeSet = new Set<string>(arr);
                    _permCache.set(roleSlug, { set: edgeSet, ts: Date.now() });
                    return edgeSet;
                }
            }
        } catch {}
    }

    if (!db) return cached?.set || buildFallbackPermissions(roleSlug);

    try {
        const { roles, rolePermissions } = await import('../db/schema');
        const { eq } = await import('drizzle-orm');

        const roleRes = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
        if (roleRes.length === 0) return cached?.set || buildFallbackPermissions(roleSlug);

        const roleId = roleRes[0].id;
        const perms = await db.select({
            resource: rolePermissions.resource,
            action: rolePermissions.action,
        }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId));

        for (const p of perms) {
            set.add(`${p.resource}:${p.action}`);
        }

        _permCache.set(roleSlug, { set, ts: Date.now() });
        if (typeof caches !== 'undefined' && set.size > 0) {
            caches.default.put(new Request(cfCacheKey), new Response(JSON.stringify(Array.from(set)), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' }
            })).catch(() => {});
        }
        return set;
    } catch (e) {
        console.error('[permissions] Failed to load permissions for role:', roleSlug, e);
        return cached?.set || buildFallbackPermissions(roleSlug);
    }
}
