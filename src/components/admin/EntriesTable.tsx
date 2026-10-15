import React, { useState, useEffect } from 'react';

interface Term {
    id: number;
    name: string;
    slug: string;
    taxonomySlug: string;
}

interface Entry {
    id: number;
    slug: string;
    title?: string;
    name?: string;
    status: string;
    publishedAt: string;
    authorName: string;
    authorId?: number;
    terms?: Term[];
}

export default function EntriesTable({ 
    collectionSlug, 
    initialPage, 
    initialSearch,
    currentUserId,
    canEditOthers,
    canDeleteOthers
}: { 
    collectionSlug: string, 
    initialPage: number, 
    initialSearch: string,
    currentUserId?: number,
    canEditOthers?: boolean,
    canDeleteOthers?: boolean
}) {
    const [entries, setEntries] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(initialPage);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState(initialSearch);
    
    // New Filters
    const [statusFilter, setStatusFilter] = useState('published');
    const [dateFilter, setDateFilter] = useState('');
    const [termFilter, setTermFilter] = useState('');
    const [availableTerms, setAvailableTerms] = useState<any[]>([]);
    const [fetchError, setFetchError] = useState<string | null>(null);
    // Per-row purge state: null | 'loading' | 'success' | 'error'
    const [purgeState, setPurgeState] = useState<Record<number, string>>({});

    const limit = 20;

    useEffect(() => {
        // Fetch all taxonomies/terms for filter dropdown
        const fetchTerms = async () => {
            try {
                const res = await fetch(`/api/taxonomy-builder`);
                if (!res.ok) return;
                const taxonomies = await res.json() as any[];
                if (!Array.isArray(taxonomies)) return;
                const termsList: any[] = [];
                for (const tax of taxonomies) {
                    try {
                        const allowed = JSON.parse(tax.allowedCollections || '[]');
                        if (allowed.includes(collectionSlug)) {
                            const termRes = await fetch(`/api/taxonomies/${tax.slug}/terms?limit=100`);
                            if (!termRes.ok) continue;
                            const termJson = await termRes.json() as any;
                            const terms = Array.isArray(termJson) ? termJson : (termJson?.data || []);
                            terms.forEach((t: any) => {
                                termsList.push({ ...t, taxName: tax.label });
                            });
                        }
                    } catch(e) {}
                }
                setAvailableTerms(termsList);
            } catch (e) { console.error("Failed to load terms", e); }
        };
        fetchTerms();
    }, [collectionSlug]);

    useEffect(() => {
        fetchData();
    }, [page, search, statusFilter, dateFilter, termFilter]);

    const fetchData = async () => {
        setLoading(true);
        setFetchError(null);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15-second timeout safeguard

        try {
            let url = `/api/content/${collectionSlug}/entries?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}`;
            if (statusFilter) url += `&status=${statusFilter}`;
            if (dateFilter) url += `&date=${dateFilter}`;
            if (termFilter) url += `&termId=${termFilter}`;
            
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `Server returned status ${res.status}`);
            }
            const json = await res.json() as any;
            if (json.data) {
                setEntries(json.data);
                setTotal(json.total || 0);
            } else {
                setEntries([]);
                setTotal(0);
            }
        } catch (e: any) {
            console.error(e);
            if (e.name === 'AbortError') {
                setFetchError('Request timed out. The database is taking too long to respond.');
            } else {
                setFetchError(e.message || 'Failed to load entries.');
            }
            setEntries([]);
            setTotal(0);
        } finally {
            clearTimeout(timeoutId);
            setLoading(false);
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm('Are you sure you want to delete this entry?')) return;
        
        try {
            const res = await fetch(`/api/content/${collectionSlug}/entries/${id}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                fetchData();
            } else {
                const data = await res.json().catch(() => ({}));
                alert(data.error || 'Failed to delete entry.');
            }
        } catch(e: any) {
            alert(e.message || 'Error deleting entry.');
        }
    };

    const handlePurge = async (id: number) => {
        setPurgeState(s => ({ ...s, [id]: 'loading' }));
        try {
            const res = await fetch('/api/admin/purge-entry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entryId: id, collectionSlug }),
            });
            setPurgeState(s => ({ ...s, [id]: res.ok ? 'success' : 'error' }));
        } catch {
            setPurgeState(s => ({ ...s, [id]: 'error' }));
        }
        // Reset icon after 2.5 s
        setTimeout(() => setPurgeState(s => { const n = { ...s }; delete n[id]; return n; }), 2500);
    };

    const totalPages = Math.ceil(total / limit);

    return (
        <div>
            {/* Status Tabs */}
            <div className="flex items-center gap-1 border-b border-border px-4 pt-2 bg-muted/10 overflow-x-auto">
                {[
                    { id: 'published', label: 'Published' },
                    { id: '', label: 'All' },
                    { id: 'draft', label: 'Draft' },
                    { id: 'protected', label: 'Protected' },
                    { id: 'trash', label: 'Trash' }
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => { setStatusFilter(tab.id); setPage(1); }}
                        className={`px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors border-b-2 -mb-[1px] whitespace-nowrap ${
                            statusFilter === tab.id 
                            ? 'border-primary text-primary bg-background' 
                            : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30'
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Filter Bar */}
            <div className="p-4 border-b border-border bg-card flex flex-wrap gap-4 items-center">
                <div className="flex items-center gap-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Date:</label>
                    <input 
                        type="text" 
                        value={dateFilter} 
                        onChange={e => { setDateFilter(e.target.value); setPage(1); }} 
                        placeholder="YYYY, YYYY-MM, YYYY-MM-DD" 
                        title="Filter by Year (2026), Month (2026-08), or Exact Day (2026-08-01)"
                        className="h-9 w-52 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    />
                </div>
                {availableTerms.length > 0 && (
                    <div className="flex items-center gap-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase">Taxonomy:</label>
                        <select value={termFilter} onChange={e => { setTermFilter(e.target.value); setPage(1); }} className="h-9 max-w-[200px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                            <option value="">All Terms</option>
                            {availableTerms.map(t => (
                                <option key={t.id} value={t.id}>{t.taxName}: {t.name}</option>
                            ))}
                        </select>
                    </div>
                )}
                {/* Search is handled by parent, but we can reset filters here */}
                {(statusFilter || dateFilter || termFilter) && (
                    <button onClick={() => { setStatusFilter(''); setDateFilter(''); setTermFilter(''); setPage(1); }} className="text-xs font-semibold text-muted-foreground hover:text-primary transition-colors underline ml-auto">
                        Clear Filters
                    </button>
                )}
            </div>

            <div className="overflow-x-auto relative min-h-[300px]">
                {loading && (
                    <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 backdrop-blur-[1px]">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                )}
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/30 border-b border-border">
                        <tr>
                            <th className="px-6 py-4 font-semibold">Title</th>
                            <th className="px-6 py-4 font-semibold">Author</th>
                            <th className="px-6 py-4 font-semibold">Status</th>
                            <th className="px-6 py-4 font-semibold">Date</th>
                            <th className="px-6 py-4 font-semibold">Taxonomies</th>
                            <th className="px-6 py-4 text-right font-semibold">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {fetchError && !loading && (
                            <tr>
                                <td colSpan={6} className="px-6 py-8 text-center">
                                    <div className="flex flex-col items-center justify-center gap-2">
                                        <p className="text-sm font-medium text-destructive">❌ {fetchError}</p>
                                        <button 
                                            onClick={() => fetchData()} 
                                            className="px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-semibold rounded-md transition-colors shadow-sm"
                                        >
                                            Retry
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        )}
                        {!fetchError && entries.length === 0 && !loading && (
                            <tr>
                                <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                                    No entries found.
                                </td>
                            </tr>
                        )}
                        {entries.map(entry => (
                            <tr key={entry.id} className="bg-card hover:bg-muted/10 transition-colors group">
                                <td className="px-6 py-4 font-medium text-foreground">
                                    <div className="flex flex-col">
                                        {(!canEditOthers && entry.authorId && currentUserId && entry.authorId !== currentUserId) ? (
                                            <span className="text-base font-bold text-muted-foreground opacity-60">
                                                {entry.title || entry.name || entry.slug || 'Untitled'}
                                            </span>
                                        ) : (
                                            <a href={`/admin/content/${collectionSlug}/edit/${entry.id}`} className="hover:text-primary transition-colors text-base font-bold">
                                                {entry.title || entry.name || entry.slug || 'Untitled'}
                                            </a>
                                        )}
                                        <span className="text-xs text-muted-foreground mt-1 font-mono">/{entry.slug}</span>
                                    </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="flex items-center gap-2">
                                        <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold">
                                            {(entry.authorName || 'U').charAt(0).toUpperCase()}
                                        </div>
                                        {entry.authorName || 'Unknown'}
                                    </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${entry.status === 'published' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-600 border border-amber-500/20'}`}>
                                        {entry.status}
                                    </span>
                                </td>
                                <td className="px-6 py-4 text-muted-foreground whitespace-nowrap text-xs">
                                    {entry.publishedAt ? new Date(entry.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'}
                                </td>
                                <td className="px-6 py-4">
                                    <div className="flex flex-col gap-2 max-w-[250px]">
                                        {entry.terms && entry.terms.length > 0 ? (
                                            Object.entries(
                                                entry.terms.reduce((acc, term) => {
                                                    const label = (term as any).taxonomyLabel || 'Term';
                                                    if (!acc[label]) acc[label] = [];
                                                    acc[label].push(term);
                                                    return acc;
                                                }, {} as Record<string, typeof entry.terms>)
                                            ).map(([taxLabel, terms]) => (
                                                <div key={taxLabel} className="flex flex-col gap-1">
                                                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{taxLabel}:</span>
                                                    <div className="flex flex-wrap gap-1">
                                                        {terms.map(t => (
                                                            <span key={t.id} className="px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded text-[10px] uppercase font-bold tracking-wider">
                                                                {t.name}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <span className="text-muted-foreground text-xs italic">None</span>
                                        )}
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-right whitespace-nowrap">
                                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        {(canEditOthers || !entry.authorId || !currentUserId || entry.authorId === currentUserId) && (
                                            <a href={`/admin/content/${collectionSlug}/edit/${entry.id}`} className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors" title="Edit">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                                            </a>
                                        )}
                                        {entry.status === 'published' && collectionSlug === 'articles' && (
                                            <a href={`/${entry.slug}`} target="_blank" rel="noopener noreferrer" className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors" title="View">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                                            </a>
                                        )}
                                        {(canDeleteOthers || !entry.authorId || !currentUserId || entry.authorId === currentUserId) && (
                                            <button onClick={() => handleDelete(entry.id)} className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-md transition-colors" title="Delete">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handlePurge(entry.id)}
                                            disabled={purgeState[entry.id] === 'loading'}
                                            className={`p-2 rounded-md transition-colors ${
                                                purgeState[entry.id] === 'success' ? 'text-emerald-500 bg-emerald-500/10' :
                                                purgeState[entry.id] === 'error'   ? 'text-red-500 bg-red-500/10' :
                                                'text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10'
                                            }`}
                                            title="Purge Cache"
                                        >
                                            {purgeState[entry.id] === 'loading' ? (
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                            ) : purgeState[entry.id] === 'success' ? (
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                            ) : purgeState[entry.id] === 'error' ? (
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                            ) : (
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                                            )}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div className="p-4 border-t border-border flex items-center justify-between bg-muted/10">
                    <span className="text-sm text-muted-foreground">
                        Showing {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of {total} entries
                    </span>
                    <div className="flex gap-1">
                        <button 
                            disabled={page === 1}
                            onClick={() => setPage(p => p - 1)}
                            className="px-3 py-1 text-sm border border-border rounded hover:bg-muted disabled:opacity-50 transition-colors"
                        >
                            Prev
                        </button>
                        <button 
                            disabled={page === totalPages}
                            onClick={() => setPage(p => p + 1)}
                            className="px-3 py-1 text-sm border border-border rounded hover:bg-muted disabled:opacity-50 transition-colors"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
