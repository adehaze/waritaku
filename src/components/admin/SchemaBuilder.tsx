import React, { useState, useEffect } from 'react';

interface FieldSchema {
    name: string;
    type: string;
    label: string;
    required?: boolean;
    options?: any;
}

interface Collection {
    id: number;
    slug: string;
    label: string;
    labelSingular: string;
    description: string | null;
    icon: string;
    routePrefix: string;
    fields: string;
    supports: string;
}

interface SchemaBuilderProps {
    collection: Collection;
    availableTaxonomies: { slug: string, name: string }[];
}

const DEFAULT_SCHEMAS: Record<string, { fields: FieldSchema[]; supports: any }> = {
    articles: {
        fields: [
            { name: 'title', label: 'Title', type: 'text', required: true },
            { name: 'excerpt', label: 'Excerpt', type: 'textarea', required: false },
            { name: 'content', label: 'Content', type: 'richtext', required: true },
            { name: 'featuredImage', label: 'Featured Image', type: 'image', required: false },
        ],
        supports: {
            revisions: true,
            taxonomies: ['categories', 'tags'],
            layoutBlocks: [
                { id: 'block_hero', type: 'hero', config: {} },
                { id: 'block_breadcrumbs', type: 'breadcrumbs', config: { visibility: 'hidden' } },
                { id: 'block_body', type: 'body_content', config: {} },
                { id: 'block_tags', type: 'taxonomy_terms', config: { targetTaxonomy: 'tags' } },
                { id: 'block_related', type: 'related_items', config: { targetTaxonomy: 'categories' } },
                { id: 'block_author', type: 'author_box', config: {} }
            ],
            mappings: {
                titleField: 'title',
                imageField: 'featuredImage',
                excerptField: 'excerpt',
                contentField: 'content'
            }
        }
    },
    pages: {
        fields: [
            { name: 'title', label: 'Title', type: 'text', required: true },
            { name: 'is_block_builder', label: 'Use Block Builder', type: 'boolean', required: false, options: { default: true } },
            { name: 'content', label: 'Content', type: 'richtext', required: false },
            { name: 'layout_blocks', label: 'Layout Blocks', type: 'blockbuilder', required: false }
        ],
        supports: {
            revisions: true,
            layoutBlocks: [
                { id: 'block_hero', type: 'hero', config: {} },
                { id: 'block_breadcrumbs', type: 'breadcrumbs', config: { visibility: 'hidden' } },
                { id: 'block_body', type: 'body_content', config: {} }
            ],
            mappings: {
                titleField: 'title',
                excerptField: '',
                contentField: 'content'
            }
        }
    }
};

function safeParseJson(val: any, fallback: any) {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try {
        return JSON.parse(val);
    } catch {
        return fallback;
    }
}

function normalizeFields(raw: any, collectionSlug?: string): FieldSchema[] {
    let list: any[] = [];
    if (Array.isArray(raw)) {
        list = raw;
    } else if (typeof raw === 'string') {
        const parsed = safeParseJson(raw, null);
        if (Array.isArray(parsed)) list = parsed;
    }

    if (list.length === 0 && collectionSlug && DEFAULT_SCHEMAS[collectionSlug]) {
        return DEFAULT_SCHEMAS[collectionSlug].fields;
    }

    return list.map((f: any) => {
        let type = f.type || 'text';
        if (type === 'rich_content') type = 'richtext';
        if (type === 'media') type = 'image';
        return {
            name: f.name || f.slug || `field_${Date.now()}`,
            label: f.label || f.name || f.slug || 'Untitled Field',
            type,
            required: !!f.required,
            options: f.options
        };
    });
}

function normalizeSupports(raw: any, collectionSlug?: string): any {
    const parsed = safeParseJson(raw, {});
    const hasKeys = parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
    if (!hasKeys && collectionSlug && DEFAULT_SCHEMAS[collectionSlug]) {
        return DEFAULT_SCHEMAS[collectionSlug].supports;
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
}

export default function SchemaBuilder({ collection, availableTaxonomies = [] }: SchemaBuilderProps) {
    const [fields, setFields] = useState<FieldSchema[]>(() => normalizeFields(collection?.fields, collection?.slug));
    const [supports, setSupports] = useState<any>(() => normalizeSupports(collection?.supports, collection?.slug));
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [termsCache, setTermsCache] = useState<Record<string, any[]>>({});

    const taxonomyKey = (supports?.taxonomies || []).join(',');

    useEffect(() => {
        const fetchTerms = async () => {
            if (!supports?.taxonomies || supports.taxonomies.length === 0) return;
            const newCache = { ...termsCache };
            let updated = false;
            for (const taxSlug of supports.taxonomies) {
                if (!newCache[taxSlug]) {
                    try {
                        const res = await fetch(`/api/taxonomies/${taxSlug}/terms?limit=50`);
                        if (!res.ok) continue;
                        const json = await res.json() as any;
                        const termList = Array.isArray(json) ? json : (json?.data || []);
                        if (termList.length > 0) {
                            newCache[taxSlug] = termList;
                            updated = true;
                        }
                    } catch(e) {}
                }
            }
            if (updated) setTermsCache(newCache);
        };
        fetchTerms();
    }, [taxonomyKey]);

    useEffect(() => {
        if (collection) {
            setFields(normalizeFields(collection.fields, collection.slug));
            setSupports(normalizeSupports(collection.supports, collection.slug));
        }
    }, [collection?.fields, collection?.supports, collection?.slug]);

    const handleSave = async () => {
        setSaving(true);
        setMessage('');
        try {
            const res = await fetch(`/api/content-builder/${collection.slug}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: JSON.stringify(fields),
                    supports: JSON.stringify(supports)
                })
            });
            const json = await res.json() as any;
            if (res.ok) {
                setMessage('Schema saved successfully!');
            } else {
                setMessage(`Error: ${json.error}`);
            }
        } catch(e: any) {
            setMessage(`Error saving schema: ${e.message}`);
        }
        setSaving(false);
    };

    const addField = (type: string) => {
        const newField: FieldSchema = {
            name: `field_${Date.now()}`,
            type,
            label: `New ${type} Field`,
            required: false
        };
        setFields([...fields, newField]);
    };

    const updateField = (index: number, key: keyof FieldSchema, value: any) => {
        const newFields = [...fields];
        newFields[index] = { ...newFields[index], [key]: value };
        setFields(newFields);
    };

    const removeField = (index: number) => {
        const newFields = [...fields];
        newFields.splice(index, 1);
        setFields(newFields);
    };

    const toggleTaxonomy = (taxSlug: string) => {
        const currentTax = supports.taxonomies || [];
        const newTax = currentTax.includes(taxSlug)
            ? currentTax.filter((t: string) => t !== taxSlug)
            : [...currentTax, taxSlug];
        setSupports({ ...supports, taxonomies: newTax });
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
                {message && (
                    <div className={`p-4 rounded-lg font-medium text-sm ${message.includes('Error') ? 'bg-red-500/10 text-red-500' : 'bg-emerald-500/10 text-emerald-600'}`}>
                        {message}
                    </div>
                )}
                
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold">Fields ({fields.length})</h2>
                    <div className="flex gap-2">
                        <select id="addFieldSelect" className="text-sm bg-background border border-input rounded px-3 py-1.5 focus:ring-1 focus:ring-primary">
                            <option value="text">Text (Short)</option>
                            <option value="textarea">Text (Long)</option>
                            <option value="richtext">Rich Text</option>
                            <option value="image">Image</option>
                            <option value="boolean">Boolean (Checkbox)</option>
                            <option value="blockbuilder">Block Builder</option>
                        </select>
                        <button 
                            onClick={() => addField((document.getElementById('addFieldSelect') as unknown as HTMLSelectElement).value)}
                            className="bg-primary text-primary-foreground px-3 py-1.5 rounded text-sm font-medium hover:bg-primary/90 transition-colors"
                        >
                            + Add Field
                        </button>
                    </div>
                </div>

                <div className="space-y-4">
                    {fields.length === 0 ? (
                        <div className="p-8 text-center border border-dashed border-border rounded-xl text-muted-foreground bg-muted/20">
                            No fields defined. Add your first field to start building the schema!
                        </div>
                    ) : (
                        fields.map((field, index) => (
                            <div key={index} className="p-4 bg-card border border-border rounded-xl shadow-sm flex flex-col gap-4">
                                <div className="flex items-center justify-between border-b border-border pb-3">
                                    <div className="flex items-center gap-3">
                                        <span className="bg-primary/10 text-primary text-xs font-bold px-2 py-1 rounded uppercase tracking-wider">{field.type}</span>
                                        <span className="font-semibold text-sm">{field.name}</span>
                                    </div>
                                    <button onClick={() => removeField(index)} className="text-red-500 hover:text-red-700 hover:bg-red-500/10 p-1.5 rounded transition-colors" title="Remove Field">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                                    </button>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-bold text-muted-foreground mb-1 uppercase tracking-wider">Field Label</label>
                                        <input 
                                            type="text" 
                                            value={field.label} 
                                            onChange={(e) => updateField(index, 'label', e.target.value)}
                                            className="w-full text-sm px-3 py-1.5 bg-background border border-input rounded focus:ring-1 focus:ring-primary"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-muted-foreground mb-1 uppercase tracking-wider">Field Name (API Key)</label>
                                        <input 
                                            type="text" 
                                            value={field.name} 
                                            onChange={(e) => updateField(index, 'name', e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                                            className="w-full text-sm px-3 py-1.5 bg-background border border-input rounded focus:ring-1 focus:ring-primary font-mono"
                                        />
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                                        <input 
                                            type="checkbox" 
                                            checked={field.required || false}
                                            onChange={(e) => updateField(index, 'required', e.target.checked)}
                                            className="w-4 h-4 text-primary rounded"
                                        />
                                        Required Field
                                    </label>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            
            <div className="space-y-6">
                <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden mb-6">
                    <div className="bg-muted/30 p-4 border-b border-border">
                        <h3 className="font-bold text-foreground flex items-center gap-2">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                            Collection Field Mappings
                        </h3>
                        <p className="text-xs text-muted-foreground mt-1">
                            Map your custom fields to core system roles (used in archive layouts and SEO).
                        </p>
                    </div>
                    <div className="p-4 space-y-4">
                        <div>
                            <label className="block text-sm font-semibold mb-1 text-foreground">Primary Title Field</label>
                            <select 
                                value={supports?.mappings?.titleField || ''} 
                                onChange={e => setSupports({ ...supports, mappings: { ...supports.mappings, titleField: e.target.value } })}
                                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary"
                            >
                                <option value="">-- Fallback to Entry Slug --</option>
                                {fields.filter(f => ['text', 'textarea', 'richtext'].includes(f.type)).map(f => (
                                    <option key={f.name} value={f.name}>{f.label} ({f.name})</option>
                                ))}
                            </select>
                        </div>
                        
                        <div>
                            <label className="block text-sm font-semibold mb-1 text-foreground">Featured Image Field</label>
                            <select 
                                value={supports?.mappings?.imageField || ''} 
                                onChange={e => setSupports({ ...supports, mappings: { ...supports.mappings, imageField: e.target.value } })}
                                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary"
                            >
                                <option value="">-- None --</option>
                                {fields.filter(f => ['image', 'file'].includes(f.type)).map(f => (
                                    <option key={f.name} value={f.name}>{f.label} ({f.name})</option>
                                ))}
                            </select>
                        </div>
                        
                        <div>
                            <label className="block text-sm font-semibold mb-1 text-foreground">Excerpt / Summary Field</label>
                            <select 
                                value={supports?.mappings?.excerptField || ''} 
                                onChange={e => setSupports({ ...supports, mappings: { ...supports.mappings, excerptField: e.target.value } })}
                                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary"
                            >
                                <option value="">-- None (Auto-generate if possible) --</option>
                                {fields.filter(f => ['text', 'textarea', 'richtext'].includes(f.type)).map(f => (
                                    <option key={f.name} value={f.name}>{f.label} ({f.name})</option>
                                ))}
                            </select>
                        </div>
                        
                        <div>
                            <label className="block text-sm font-semibold mb-1 text-foreground">Main Content Field (for indexing)</label>
                            <select 
                                value={supports?.mappings?.contentField || ''} 
                                onChange={e => setSupports({ ...supports, mappings: { ...supports.mappings, contentField: e.target.value } })}
                                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary"
                            >
                                <option value="">-- None --</option>
                                {fields.filter(f => ['richtext', 'textarea', 'blockbuilder'].includes(f.type)).map(f => (
                                    <option key={f.name} value={f.name}>{f.label} ({f.name})</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
                
                <div className="bg-card border border-border rounded-xl shadow-sm p-6">

                    <h3 className="text-sm font-bold uppercase tracking-wider mb-4 pb-2 border-b border-border">Configuration</h3>
                    
                    <div className="space-y-4">
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <h4 className="text-xs font-bold text-muted-foreground">Supported Taxonomies</h4>
                                <div className="text-[10px] text-primary/70 font-semibold bg-primary/10 px-2 py-0.5 rounded">Ordered by Priority</div>
                            </div>
                            <p className="text-[10px] text-muted-foreground mb-3">
                                The order below determines which taxonomy is used for the URL prefix if an entry belongs to multiple taxonomies.
                            </p>

                            {availableTaxonomies.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic">No taxonomies found in the system.</p>
                            ) : (
                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        {(supports.taxonomies || []).map((taxSlug: string, idx: number) => {
                                            const tax = availableTaxonomies.find(t => t.slug === taxSlug);
                                            if (!tax) return null;
                                            return (
                                                <div key={taxSlug} className="flex justify-between items-center p-2 bg-muted/30 border border-border rounded-lg text-sm">
                                                    <div className="flex items-center gap-2">
                                                        <button 
                                                            type="button"
                                                            onClick={() => {
                                                                if (idx === 0) return;
                                                                const newTax = [...supports.taxonomies];
                                                                const temp = newTax[idx-1];
                                                                newTax[idx-1] = newTax[idx];
                                                                newTax[idx] = temp;
                                                                setSupports({ ...supports, taxonomies: newTax });
                                                            }}
                                                            className="p-1 hover:bg-muted rounded disabled:opacity-30"
                                                            disabled={idx === 0}
                                                            title="Move Priority Up"
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                                                        </button>
                                                        <button 
                                                            type="button"
                                                            onClick={() => {
                                                                if (idx === (supports.taxonomies.length - 1)) return;
                                                                const newTax = [...supports.taxonomies];
                                                                const temp = newTax[idx+1];
                                                                newTax[idx+1] = newTax[idx];
                                                                newTax[idx] = temp;
                                                                setSupports({ ...supports, taxonomies: newTax });
                                                            }}
                                                            className="p-1 hover:bg-muted rounded disabled:opacity-30"
                                                            disabled={idx === (supports.taxonomies.length - 1)}
                                                            title="Move Priority Down"
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                                                        </button>
                                                        <span className="font-semibold text-sm">{tax.name}</span>
                                                    </div>
                                                    <button 
                                                        type="button"
                                                        onClick={() => toggleTaxonomy(taxSlug)}
                                                        className="text-red-500 hover:bg-red-500/10 p-1 rounded"
                                                        title="Remove Taxonomy"
                                                    >
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                        {(!supports.taxonomies || supports.taxonomies.length === 0) && (
                                            <div className="p-3 text-center border border-dashed border-border rounded-lg text-xs text-muted-foreground">
                                                No taxonomies enabled for this content type.
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex gap-2">
                                        <select id="addTaxonomySelect" className="flex-1 text-sm bg-background border border-input rounded px-2 py-1.5 focus:ring-1 focus:ring-primary">
                                            {availableTaxonomies.filter(tax => !(supports.taxonomies || []).includes(tax.slug)).map(tax => (
                                                <option key={`opt_${tax.slug}`} value={tax.slug}>{tax.name}</option>
                                            ))}
                                        </select>
                                        <button 
                                            type="button"
                                            onClick={() => {
                                                const select = document.getElementById('addTaxonomySelect') as HTMLSelectElement;
                                                const val = select?.value;
                                                if (val) {
                                                    const currentTax = supports.taxonomies || [];
                                                    if (!currentTax.includes(val)) {
                                                        setSupports({ ...supports, taxonomies: [...currentTax, val] });
                                                    }
                                                }
                                            }}
                                            className="bg-primary/20 text-primary px-3 py-1.5 rounded text-sm font-medium hover:bg-primary/30 transition-colors whitespace-nowrap"
                                            disabled={availableTaxonomies.filter(tax => !(supports.taxonomies || []).includes(tax.slug)).length === 0}
                                        >
                                            + Add
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {(supports.taxonomies && supports.taxonomies.length > 0) && (
                            <div className="pt-4 border-t border-border mt-4">
                                <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-xs font-bold text-muted-foreground">Default Primary Term</h4>
                                </div>
                                <p className="text-[10px] text-muted-foreground mb-3">
                                    Optionally select a default term. When creating a new entry, this term will be automatically starred as the primary URL prefix (the user can still override it).
                                </p>
                                <select 
                                    className="w-full text-sm bg-background border border-input rounded px-3 py-2 focus:ring-1 focus:ring-primary"
                                    value={supports.defaultPrimaryTermId || ''}
                                    onChange={(e) => setSupports({ ...supports, defaultPrimaryTermId: e.target.value })}
                                >
                                    <option value="">-- No Default Primary Term --</option>
                                    {supports.taxonomies.map((taxSlug: string) => {
                                        const tax = availableTaxonomies.find(t => t.slug === taxSlug);
                                        const terms = termsCache[taxSlug] || [];
                                        if (terms.length === 0) return null;
                                        return (
                                            <optgroup key={`optg_${taxSlug}`} label={tax?.name || taxSlug}>
                                                {terms.map(term => (
                                                    <option key={`opt_${term.id}`} value={term.id}>{term.name}</option>
                                                ))}
                                            </optgroup>
                                        );
                                    })}
                                </select>
                            </div>
                        )}

                        <div className="pt-4 border-t border-border">
                            <h4 className="text-xs font-bold text-muted-foreground mb-2">Frontend View Template</h4>
                            <p className="text-[10px] text-muted-foreground mb-3">
                                Construct the frontend layout for this content type by stacking modular blocks. If empty, the system will try to use a smart default.
                            </p>
                            
                            <div className="space-y-2 mb-3">
                                {(supports.layoutBlocks || []).map((block: any, idx: number) => (
                                    <div key={block.id} className="flex flex-col gap-2 p-2 bg-muted/30 border border-border rounded-lg text-sm">
                                        <div className="flex justify-between items-center">
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={() => {
                                                        if (idx === 0) return;
                                                        const newBlocks = [...supports.layoutBlocks];
                                                        const temp = newBlocks[idx-1];
                                                        newBlocks[idx-1] = newBlocks[idx];
                                                        newBlocks[idx] = temp;
                                                        setSupports({ ...supports, layoutBlocks: newBlocks });
                                                    }}
                                                    className="p-1 hover:bg-muted rounded disabled:opacity-30"
                                                    disabled={idx === 0}
                                                    title="Move Up"
                                                >
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                                                </button>
                                                <button 
                                                    onClick={() => {
                                                        if (idx === (supports.layoutBlocks.length - 1)) return;
                                                        const newBlocks = [...supports.layoutBlocks];
                                                        const temp = newBlocks[idx+1];
                                                        newBlocks[idx+1] = newBlocks[idx];
                                                        newBlocks[idx] = temp;
                                                        setSupports({ ...supports, layoutBlocks: newBlocks });
                                                    }}
                                                    className="p-1 hover:bg-muted rounded disabled:opacity-30"
                                                    disabled={idx === (supports.layoutBlocks.length - 1)}
                                                    title="Move Down"
                                                >
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                                                </button>
                                                <span className="font-bold text-xs uppercase tracking-wider">{block.type.replace('_', ' ')}</span>
                                            </div>
                                            <button 
                                                onClick={() => {
                                                    const newBlocks = [...supports.layoutBlocks];
                                                    newBlocks.splice(idx, 1);
                                                    setSupports({ ...supports, layoutBlocks: newBlocks });
                                                }}
                                                className="text-red-500 hover:bg-red-500/10 p-1 rounded"
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                            </button>
                                        </div>

                                        {/* Block-specific Configuration */}
                                        {block.type === 'breadcrumbs' && (
                                            <div className="mt-2 pl-8 pr-2">
                                                <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                                    Visibility:
                                                    <select 
                                                        value={block.config?.visibility || 'visible'}
                                                        onChange={(e) => {
                                                            const newBlocks = [...supports.layoutBlocks];
                                                            newBlocks[idx].config = { ...newBlocks[idx].config, visibility: e.target.value };
                                                            setSupports({ ...supports, layoutBlocks: newBlocks });
                                                        }}
                                                        className="ml-auto flex-1 text-xs bg-background border border-border rounded px-2 py-1"
                                                    >
                                                        <option value="visible">Visible</option>
                                                        <option value="hidden">Hidden (SEO Only)</option>
                                                    </select>
                                                </label>
                                            </div>
                                        )}

                                        {block.type === 'related_items' && (
                                            <div className="mt-2 pl-8 pr-2">
                                                <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                                    Relate to Taxonomy:
                                                    <select 
                                                        value={block.config?.targetTaxonomy || ''}
                                                        onChange={(e) => {
                                                            const newBlocks = [...supports.layoutBlocks];
                                                            newBlocks[idx].config = { ...newBlocks[idx].config, targetTaxonomy: e.target.value };
                                                            setSupports({ ...supports, layoutBlocks: newBlocks });
                                                        }}
                                                        className="ml-auto flex-1 text-xs bg-background border border-border rounded px-2 py-1"
                                                    >
                                                        <option value="">-- Dynamic (Current Context) --</option>
                                                        {availableTaxonomies.map(tax => (
                                                            <option key={tax.slug} value={tax.slug}>{tax.name}</option>
                                                        ))}
                                                    </select>
                                                </label>
                                            </div>
                                        )}

                                        {block.type === 'taxonomy_terms' && (
                                            <div className="mt-2 pl-8 pr-2">
                                                <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                                    Target Taxonomy:
                                                    <select 
                                                        value={block.config?.targetTaxonomy || ''}
                                                        onChange={(e) => {
                                                            const newBlocks = [...supports.layoutBlocks];
                                                            newBlocks[idx].config = { ...newBlocks[idx].config, targetTaxonomy: e.target.value };
                                                            setSupports({ ...supports, layoutBlocks: newBlocks });
                                                        }}
                                                        className="ml-auto flex-1 text-xs bg-background border border-border rounded px-2 py-1"
                                                    >
                                                        <option value="">-- Select Taxonomy --</option>
                                                        {availableTaxonomies.map(tax => (
                                                            <option key={tax.slug} value={tax.slug}>{tax.name}</option>
                                                        ))}
                                                    </select>
                                                </label>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <div className="flex gap-2">
                                <select id="addBlockSelect" className="flex-1 text-sm bg-background border border-input rounded px-2 py-1.5 focus:ring-1 focus:ring-primary">
                                    <option value="breadcrumbs">Breadcrumbs Navigation</option>
                                    <option value="hero">Hero Header (Article Style)</option>
                                    <option value="product_split">Product Split Header (Image Left, Info Right)</option>
                                    <option value="body_content">Body Content (Rich Text + Accordions)</option>
                                    <option value="author_box">Author Box (Bio & Avatar)</option>
                                    <option value="taxonomy_terms">Taxonomy Terms List (Tags/Categories)</option>
                                    <option value="related_items">Related Items Grid</option>
                                </select>
                                <button 
                                    onClick={() => {
                                        const type = (document.getElementById('addBlockSelect') as unknown as HTMLSelectElement).value;
                                        const currentBlocks = supports.layoutBlocks || [];
                                        setSupports({ 
                                            ...supports, 
                                            layoutBlocks: [...currentBlocks, { id: `block_${Date.now()}`, type, config: {} }] 
                                        });
                                    }}
                                    className="bg-primary/20 text-primary px-3 py-1.5 rounded text-sm font-medium hover:bg-primary/30 transition-colors whitespace-nowrap"
                                >
                                    + Add
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                
                <button 
                    onClick={handleSave}
                    disabled={saving}
                    className="w-full py-3 bg-primary text-primary-foreground font-bold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 shadow-sm"
                >
                    {saving ? 'Saving...' : 'Save Schema'}
                </button>
            </div>
        </div>
    );
}
