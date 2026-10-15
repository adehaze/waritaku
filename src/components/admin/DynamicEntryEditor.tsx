import React, { useState } from 'react';
import TaxonomySelector from './TaxonomySelector';
import BlockBuilder from './BlockBuilder';
import Editor from '../Editor';
import RevisionDiff from './RevisionDiff';
import { optimizeImage } from '../../utils/imageOptimizer';

interface FieldSchema {
    name: string;
    type: string;
    label: string;
    required?: boolean;
    options?: any; // e.g. for taxonomy slug, or dropdown options
}

interface DynamicEntryEditorProps {
    collectionSlug: string;
    schema: FieldSchema[];
    initialEntry: any | null;
    supports?: string;
    taxonomies?: string[];
    taxonomyMeta?: { slug: string; label: string; prefixEntryUrl: boolean }[];
    allUsers?: { id: number; name: string; role: string; }[];
    canChangeAuthor?: boolean;
}

export default function DynamicEntryEditor({ collectionSlug, schema: rawSchema, initialEntry, supports, taxonomies = [], taxonomyMeta = [], allUsers = [], canChangeAuthor = false }: DynamicEntryEditorProps) {
    const schema = React.useMemo(() => {
        if (!Array.isArray(rawSchema)) return [];
        return rawSchema.map((f: any) => {
            let type = f.type || 'text';
            if (type === 'rich_content') type = 'richtext';
            if (type === 'media') type = 'image';
            return {
                ...f,
                name: f.name || f.slug || '',
                label: f.label || f.name || f.slug || 'Field',
                type
            };
        });
    }, [rawSchema]);

    const defaultPrimaryTermId = React.useMemo(() => {
        try { if (supports) return JSON.parse(supports).defaultPrimaryTermId || null; } catch(e) {}
        return null;
    }, [supports]);

    const [formData, setFormData] = useState<any>(initialEntry || { status: 'draft', selectedTerms: {}, primaryTermId: defaultPrimaryTermId });
    const [allTermsData, setAllTermsData] = useState<Record<string, any[]>>({});
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [showRevisions, setShowRevisions] = useState(false);
    const [revisions, setRevisions] = useState<any[]>([]);
    const [selectedRevisions, setSelectedRevisions] = useState<number[]>([]);
    const [diffRevision, setDiffRevision] = useState<any>(null);
    const [uploadingField, setUploadingField] = useState<string | null>(null);
    
    let supportsRevisions = false;
    try {
        if (supports) supportsRevisions = !!JSON.parse(supports).revisions;
    } catch(e) {}

    const handleChange = (name: string, value: any) => {
        setFormData((prev: any) => ({ ...prev, [name]: value }));
    };

    const loadRevisions = async () => {
        if (!initialEntry?.id) return;
        try {
            const res = await fetch(`/api/content/${collectionSlug}/entries/${initialEntry.id}/revisions`);
            const json = await res.json() as any;
            if (res.ok) {
                setRevisions(json.data || []);
                setShowRevisions(true);
            } else {
                alert('Error loading revisions: ' + json.error);
            }
        } catch(e) {
            console.error(e);
        }
    };

    const restoreRevision = (rev: any) => {
        if (!confirm('Are you sure you want to replace the current content with this snapshot? (You must click Save to make it permanent)')) return;
        try {
            const snapshot = JSON.parse(rev.data);
            setFormData({ ...formData, ...snapshot });
            setShowRevisions(false);
            setDiffRevision(null);
            setMessage('Revision loaded! Click Save Entry to apply.');
        } catch(e) {
            alert('Failed to parse revision data.');
        }
    };

    const deleteSelectedRevisions = async () => {
        if (!confirm('Are you sure you want to delete the selected revisions?')) return;
        try {
            const res = await fetch(`/api/content/${collectionSlug}/entries/${initialEntry.id}/revisions`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: selectedRevisions })
            });
            if (res.ok) {
                setRevisions(revisions.filter(r => !selectedRevisions.includes(r.id)));
                setSelectedRevisions([]);
            } else {
                alert('Error deleting revisions');
            }
        } catch(e) {
            console.error(e);
        }
    };

    const toggleSelection = (id: number) => {
        setSelectedRevisions(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]);
    };

    const toggleAllSelection = () => {
        if (selectedRevisions.length === revisions.length) {
            setSelectedRevisions([]);
        } else {
            setSelectedRevisions(revisions.map(r => r.id));
        }
    };

    const parseBlocks = (val: any) => {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        try { 
            const parsed = JSON.parse(val);
            return Array.isArray(parsed) ? parsed : [];
        } catch(e) { 
            return []; 
        }
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, fieldName: string) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploadingField(fieldName);
        
        try {
            // Compress image client-side before sending to server
            const optimizedFile = await optimizeImage(file, { maxWidth: 1920, maxHeight: 1080, quality: 0.8 });
            
            const data = new FormData();
            data.append('file', optimizedFile);

            const res = await fetch('/api/upload', {
                method: 'POST',
                body: data,
            });
            const json = await res.json();
            if (res.ok && json.url) {
                handleChange(fieldName, json.url);
            } else {
                alert(`Upload failed: ${json.error}`);
            }
        } catch (err: any) {
            alert(`Upload error: ${err.message}`);
        }
        setUploadingField(null);
        e.target.value = '';
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage('');

        try {
            const url = initialEntry?.id 
                ? `/api/content/${collectionSlug}/entries/${initialEntry.id}`
                : `/api/content/${collectionSlug}/entries`;
            
            const method = initialEntry?.id ? 'PUT' : 'POST';

            const payload = { ...formData };
            if (payload.selectedTerms) {
                payload.selectedTerms = Object.values(payload.selectedTerms).flat();
            }

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const json = await res.json() as any;
            if (res.ok) {
                setMessage('Entry saved successfully!');
                if (!initialEntry?.id) {
                    window.location.href = `/admin/content/${collectionSlug}/edit/${json.id}`;
                }
            } else {
                setMessage(`Error: ${json.error}`);
            }
        } catch(err: any) {
            setMessage(`Error saving: ${err.message}`);
        }
        setSaving(false);
    };

    return (
        <>
        <form onSubmit={handleSave} className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
                {message && (
                    <div className={`p-4 rounded-lg font-medium text-sm ${message.includes('Error') ? 'bg-red-500/10 text-red-500' : 'bg-emerald-500/10 text-emerald-600'}`}>
                        {message}
                    </div>
                )}
                
                {/* Dynamically Render Fields based on Schema */}
                {schema
                    .filter(f => f.type !== 'taxonomy')
                    .filter(f => !((formData.is_block_builder || formData.isBlockBuilder) && f.type === 'richtext'))
                    .filter(f => {
          if (f.type !== 'blockbuilder') return true;
          // If there is no isBlockBuilder field in schema, don't hide it
          const hasToggle = schema.some(s => (s.name || s.slug) === 'is_block_builder' || (s.name || s.slug) === 'isBlockBuilder');
          if (!hasToggle) return true;
          return (formData.is_block_builder || formData.isBlockBuilder);
      })
                    .map((field) => (
                    <div key={(field.name || field.slug)} className="bg-card border border-border rounded-xl shadow-sm p-6 space-y-3">
                        <label className="block text-sm font-bold uppercase tracking-wide text-foreground">
                            {field.label} {field.required && <span className="text-red-500">*</span>}
                        </label>
                        
                        {field.type === 'text' && (
                            <input 
                                type="text"
                                value={formData[(field.name || field.slug)] || ''}
                                onChange={(e) => handleChange((field.name || field.slug), e.target.value)}
                                required={field.required}
                                className="w-full px-4 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        )}

                        {field.type === 'textarea' && (
                            <textarea 
                                value={formData[(field.name || field.slug)] || ''}
                                onChange={(e) => handleChange((field.name || field.slug), e.target.value)}
                                required={field.required}
                                rows={4}
                                className="w-full px-4 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        )}

                        {field.type === 'richtext' && (
                            <Editor 
                                content={formData[(field.name || field.slug)] || ''} 
                                onChange={(val) => handleChange((field.name || field.slug), val)} 
                            />
                        )}

                        {field.type === 'image' && (
                            <div className="space-y-2">
                                <div className="flex gap-2">
                                    <input 
                                        type="text"
                                        value={formData[(field.name || field.slug)] || ''}
                                        onChange={(e) => handleChange((field.name || field.slug), e.target.value)}
                                        placeholder="Image or File URL"
                                        className="flex-1 px-4 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                                    />
                                    <label className={`cursor-pointer px-4 py-2 rounded-md font-medium text-sm transition-colors flex items-center justify-center ${uploadingField === (field.name || field.slug) ? 'bg-muted text-muted-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}>
                                        {uploadingField === (field.name || field.slug) ? 'Uploading...' : 'Upload File'}
                                        <input 
                                            type="file" 
                                            accept="image/*,application/pdf" 
                                            className="hidden" 
                                            onChange={(e) => handleImageUpload(e, (field.name || field.slug))} 
                                            disabled={uploadingField === (field.name || field.slug)}
                                        />
                                    </label>
                                </div>
                                {formData[(field.name || field.slug)] && !formData[(field.name || field.slug)].endsWith('.pdf') && (
                                    <img src={formData[(field.name || field.slug)]} alt="Preview" className="max-h-48 rounded-md border border-border object-cover" />
                                )}
                                {formData[(field.name || field.slug)] && formData[(field.name || field.slug)].endsWith('.pdf') && (
                                    <div className="p-3 bg-muted rounded-md text-sm break-all">
                                        📄 PDF Document: <a href={formData[(field.name || field.slug)]} target="_blank" className="text-primary hover:underline">{formData[(field.name || field.slug)]}</a>
                                    </div>
                                )}
                            </div>
                        )}

                        {field.type === 'boolean' && (
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="checkbox"
                                    checked={formData[(field.name || field.slug)] || false}
                                    onChange={(e) => handleChange((field.name || field.slug), e.target.checked)}
                                    className="w-4 h-4 text-primary bg-background border-input rounded focus:ring-primary focus:ring-2"
                                />
                                <span className="text-sm font-medium">{field.label}</span>
                            </label>
                        )}

                        {field.type === 'blockbuilder' && (
                            <BlockBuilder 
                                blocks={parseBlocks(formData[field.name || field.slug] || formData.layout_blocks)}
                                setBlocks={(val: any) => handleChange(field.name || field.slug, JSON.stringify(val))}
                            />
                        )}
                    </div>
                ))}
            </div>

            {/* Sidebar metadata */}
            <div className="space-y-6">
                
                {/* Canonical URL Preview */}
                {(() => {
                    let supportedTax = [];
                    try { if (supports) supportedTax = JSON.parse(supports).taxonomies || []; } catch(e) {}
                    if (supportedTax.length === 0) supportedTax = taxonomies;
                    
                    const prefixedTaxonomies = taxonomyMeta.filter(t => t.prefixEntryUrl && supportedTax.includes(t.slug));
                    
                    let primaryTaxonomy = '';
                    if (formData.primaryTaxonomyOverride) {
                        primaryTaxonomy = formData.primaryTaxonomyOverride;
                    } else if (prefixedTaxonomies.length > 0) {
                        // Find first in supported priority order
                        for (const slug of supportedTax) {
                            if (prefixedTaxonomies.some(t => t.slug === slug)) {
                                primaryTaxonomy = slug;
                                break;
                            }
                        }
                    }

                    let prefixTerm = null;
                    if (primaryTaxonomy && formData.selectedTerms?.[primaryTaxonomy]?.length > 0) {
                        const termId = formData.selectedTerms[primaryTaxonomy][0];
                        const terms = allTermsData[primaryTaxonomy] || [];
                        prefixTerm = terms.find(t => t.id.toString() === termId);
                    }

                    const canonicalUrl = `/${prefixTerm ? prefixTerm.slug + '/' : ''}${formData.slug || 'untitled'}`;

                    if (prefixedTaxonomies.length > 0) {
                        return (
                            <div className="bg-card border border-border rounded-xl shadow-sm p-6 relative overflow-hidden">
                                <div className="absolute top-0 left-0 w-1 h-full bg-primary"></div>
                                <h3 className="text-sm font-bold uppercase tracking-wider mb-2 text-foreground">Canonical URL</h3>
                                <p className="text-xs text-muted-foreground mb-4">This entry's URL is prefixed by its primary taxonomy.</p>
                                
                                <div className="bg-accent/50 border border-input rounded-md p-3 mb-4 break-all">
                                    <span className="text-muted-foreground text-sm">https://yoursite.com</span>
                                    <span className="text-primary font-bold text-sm">{canonicalUrl}</span>
                                </div>

                                {prefixedTaxonomies.length > 1 && (
                                    <div>
                                        <label className="block text-xs font-semibold text-muted-foreground mb-1">Override Primary Taxonomy</label>
                                        <select 
                                            value={formData.primaryTaxonomyOverride || ''}
                                            onChange={(e) => handleChange('primaryTaxonomyOverride', e.target.value)}
                                            className="w-full px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-primary"
                                        >
                                            <option value="">Default (Collection Priority)</option>
                                            {prefixedTaxonomies.map(t => (
                                                <option key={t.slug} value={t.slug}>{t.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                        );
                    }
                    return null;
                })()}

                <div className="bg-card border border-border rounded-xl shadow-sm p-6">
                    <h3 className="text-sm font-bold uppercase tracking-wider mb-4 pb-2 border-b border-border">Publishing</h3>
                    
                    <div className="space-y-4">
                        {supportsRevisions && initialEntry?.id && (
                            <div className="flex items-center justify-between bg-accent/50 p-3 rounded-lg border border-border mb-4">
                                <span className="text-sm font-medium">Revisions</span>
                                <button 
                                    type="button" 
                                    onClick={loadRevisions}
                                    className="px-3 py-1.5 text-xs font-semibold bg-background border border-input hover:bg-accent rounded transition-colors"
                                >
                                    View History
                                </button>
                            </div>
                        )}
                        <div>
                            <label className="block text-xs font-semibold text-muted-foreground mb-1">Status</label>
                            <select 
                                value={formData.status || 'draft'}
                                onChange={(e) => handleChange('status', e.target.value)}
                                className="w-full px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-primary"
                            >
                                <option value="draft">Draft</option>
                                <option value="published">Published</option>
                                <option value="password_protected">Password Protected</option>
                                <option value="archived">Archived</option>
                            </select>
                        </div>

                        {formData.status === 'password_protected' && (
                            <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">Password</label>
                                <input 
                                    type="text"
                                    value={formData.password || ''}
                                    onChange={(e) => handleChange('password', e.target.value)}
                                    placeholder="Enter access password"
                                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                            </div>
                        )}
                        
                        {canChangeAuthor && allUsers.length > 0 && (
                            <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">Author</label>
                                <select 
                                    value={formData.authorId || ''}
                                    onChange={(e) => handleChange('authorId', parseInt(e.target.value, 10))}
                                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-primary"
                                >
                                    <option value="">Select Author...</option>
                                    {allUsers.map(u => (
                                        <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div>
                            <label className="block text-xs font-semibold text-muted-foreground mb-1">Slug</label>
                            <input 
                                type="text"
                                value={formData.slug || ''}
                                onChange={(e) => handleChange('slug', e.target.value)}
                                placeholder="Auto-generated if empty"
                                className="w-full px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-semibold text-muted-foreground mb-1">Publish Date</label>
                            <input 
                                type="datetime-local"
                                value={formData.publishedAt ? new Date(formData.publishedAt).toISOString().slice(0, 16) : ''}
                                onChange={(e) => handleChange('publishedAt', new Date(e.target.value).toISOString())}
                                className="w-full px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                        </div>
                        
                        <div className="pt-4 border-t border-border mt-4">
                            <label className="block text-xs font-semibold text-muted-foreground mb-3">Layout Overrides</label>
                            <label className="flex items-center gap-2 cursor-pointer mb-2">
                                <input 
                                    type="checkbox"
                                    checked={formData.layout_config?.override || false}
                                    onChange={(e) => handleChange('layout_config', { ...formData.layout_config, override: e.target.checked })}
                                    className="w-4 h-4 text-primary bg-background border-input rounded focus:ring-primary focus:ring-2"
                                />
                                <span className="text-sm font-medium">Override Global Sidebar</span>
                            </label>

                            {formData.layout_config?.override && (
                                <div className="pl-6 space-y-2 mt-2">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input 
                                            type="checkbox"
                                            checked={formData.layout_config?.showLeft || false}
                                            onChange={(e) => handleChange('layout_config', { ...formData.layout_config, showLeft: e.target.checked })}
                                            className="w-3.5 h-3.5 text-primary bg-background border-input rounded"
                                        />
                                        <span className="text-xs">Show Left Sidebar</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input 
                                            type="checkbox"
                                            checked={formData.layout_config?.showRight || false}
                                            onChange={(e) => handleChange('layout_config', { ...formData.layout_config, showRight: e.target.checked })}
                                            className="w-3.5 h-3.5 text-primary bg-background border-input rounded"
                                        />
                                        <span className="text-xs">Show Right Sidebar</span>
                                    </label>
                                </div>
                            )}
                        </div>

                        <button 
                            type="submit" 
                            disabled={saving}
                            className="w-full py-2.5 bg-primary text-primary-foreground font-bold rounded hover:bg-primary/90 transition-colors disabled:opacity-50 mt-4"
                        >
                            {saving ? 'Saving...' : 'Save Entry'}
                        </button>
                    </div>
                </div>
                {/* Taxonomies */}
                {(() => {
                    let supportedTax = [];
                    try { if (supports) supportedTax = JSON.parse(supports).taxonomies || []; } catch(e) {}
                    if (supportedTax.length === 0) supportedTax = taxonomies;
                    
                    let activePrimary = formData.primaryTaxonomyOverride;
                    if (!activePrimary) {
                        for (const slug of supportedTax) {
                            if (taxonomyMeta.find(t => t.slug === slug)?.prefixEntryUrl) {
                                activePrimary = slug;
                                break;
                            }
                        }
                    }

                    return taxonomies.map(taxSlug => {
                        const meta = taxonomyMeta.find(t => t.slug === taxSlug);
                        const isPrefixPriority = activePrimary === taxSlug;
                        return (
                            <div key={taxSlug} className="mt-6">
                                <TaxonomySelector 
                                    label={meta?.label || taxSlug}
                                    taxonomySlug={taxSlug}
                                    selectedTerms={formData.selectedTerms?.[taxSlug] || []}
                                    onChange={(terms) => handleChange('selectedTerms', { ...formData.selectedTerms, [taxSlug]: terms })}
                                    isPrefixPriority={isPrefixPriority}
                                    onTermData={(terms) => setAllTermsData(prev => ({ ...prev, [taxSlug]: terms }))}
                                    primaryTermId={formData.primaryTermId}
                                    onSetPrimaryTerm={(id) => handleChange('primaryTermId', id)}
                                    allowInlineCreation={meta?.allowInlineCreation}
                                    inlineSearchHint={meta?.inlineSearchHint}
                                />
                            </div>
                        );
                    });
                })()}
            </div>
        </form>

        {showRevisions && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
                {diffRevision ? (
                    <div className="bg-card w-full max-w-[95vw] h-[95vh] rounded-xl shadow-lg border border-border flex flex-col overflow-hidden">
                        <RevisionDiff 
                            currentData={formData}
                            revisionData={JSON.parse(diffRevision.data)}
                            schema={schema}
                            onRestore={() => restoreRevision(diffRevision)}
                            onBack={() => setDiffRevision(null)}
                        />
                    </div>
                ) : (
                    <div className="bg-card w-full max-w-3xl rounded-xl shadow-lg border border-border flex flex-col max-h-[85vh]">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h2 className="text-lg font-bold">Revision History</h2>
                            <button type="button" onClick={() => setShowRevisions(false)} className="text-muted-foreground hover:text-foreground">
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </div>
                        
                        <div className="flex items-center justify-between p-4 bg-accent/30 border-b border-border">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={revisions.length > 0 && selectedRevisions.length === revisions.length}
                                    onChange={toggleAllSelection}
                                    className="rounded border-input text-primary focus:ring-primary w-4 h-4"
                                />
                                <span className="text-sm font-medium">Select All</span>
                            </label>
                            
                            {selectedRevisions.length > 0 && (
                                <button 
                                    type="button"
                                    onClick={deleteSelectedRevisions}
                                    className="px-3 py-1.5 bg-red-500/10 text-red-600 hover:bg-red-500/20 text-xs font-bold rounded transition-colors"
                                >
                                    Delete Selected ({selectedRevisions.length})
                                </button>
                            )}
                        </div>

                        <div className="p-4 overflow-y-auto flex-1 space-y-2">
                            {revisions.length === 0 ? (
                                <p className="text-muted-foreground text-center py-8">No revisions found.</p>
                            ) : (
                                revisions.map((rev) => (
                                    <div key={rev.id} className="flex items-center justify-between p-3 rounded bg-accent/30 border border-border">
                                        <div className="flex items-center gap-4">
                                            <input 
                                                type="checkbox"
                                                checked={selectedRevisions.includes(rev.id)}
                                                onChange={() => toggleSelection(rev.id)}
                                                className="rounded border-input text-primary focus:ring-primary w-4 h-4"
                                            />
                                            <div>
                                                <div className="font-medium text-sm">{new Date(rev.createdAt).toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">Saved by {rev.authorName || 'Unknown'}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button 
                                                type="button"
                                                onClick={() => setDiffRevision(rev)}
                                                className="px-3 py-1.5 bg-background border border-input text-xs font-semibold rounded hover:bg-accent transition-colors"
                                            >
                                                Compare
                                            </button>
                                            <button 
                                                type="button"
                                                onClick={() => restoreRevision(rev)}
                                                className="px-3 py-1.5 bg-primary text-primary-foreground text-xs font-bold rounded hover:bg-primary/90 transition-colors"
                                            >
                                                Restore
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>
        )}
        </>
    );
}
