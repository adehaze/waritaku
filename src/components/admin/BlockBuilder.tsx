import React, { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown, Plus, Trash2 } from 'lucide-react';
import { blockRegistry } from '../../config/blockRegistry';
import type { BlockConfig, BlockField } from '../../config/blockRegistry';

type Block = { id: string; type: string; [key: string]: any };

export default function BlockBuilder({ blocks: rawBlocks, setBlocks }: any) {
  const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
  const [taxonomies, setTaxonomies] = useState<any[]>([]);
  const [terms, setTerms] = useState<any[]>([]);
  const [collections, setCollections] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/taxonomies/all')
      .then(res => res.json())
      .then((data) => {
        const d = data as { taxonomies?: any[]; terms?: any[] };
        setTaxonomies(d.taxonomies || []);
        setTerms(d.terms || []);
      })
      .catch(err => console.error("Error fetching taxonomies:", err));

    fetch('/api/content-builder')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setCollections(data);
      })
      .catch(err => console.error("Error fetching collections:", err));
  }, []);

  const updateBlock = (index: number, updates: Partial<Block>) => {
    const newBlocks = [...blocks];
    newBlocks[index] = { ...newBlocks[index], ...updates };
    setBlocks(newBlocks);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newBlocks = [...blocks];
    const temp = newBlocks[index - 1];
    newBlocks[index - 1] = newBlocks[index];
    newBlocks[index] = temp;
    setBlocks(newBlocks);
  };

  const moveDown = (index: number) => {
    if (index === blocks.length - 1) return;
    const newBlocks = [...blocks];
    const temp = newBlocks[index + 1];
    newBlocks[index + 1] = newBlocks[index];
    newBlocks[index] = temp;
    setBlocks(newBlocks);
  };

  const removeBlock = (index: number) => {
    if (confirm('Are you sure you want to remove this block?')) {
      const newBlocks = [...blocks];
      newBlocks.splice(index, 1);
      setBlocks(newBlocks);
    }
  };

  const addBlock = (config: BlockConfig) => {
    const id = config.type + '-' + Date.now();
    const newBlock: Block = { id, type: config.type, ...config.defaultData };
    setBlocks([...blocks, newBlock]);
  };

  const getLayoutBadge = (group: string) => {
    if (group.includes('MAIN COLUMN')) {
      return <span className="px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-600 dark:text-amber-500 font-bold rounded">{group}</span>;
    }
    return <span className="px-2 py-0.5 text-[10px] bg-primary/20 text-primary font-bold rounded">{group}</span>;
  };

  const renderField = (field: BlockField, block: Block, index: number) => {
    if (field.condition && !field.condition(block)) return null;

    if (field.type === 'text') {
      return (
        <div key={field.name}>
          <label className="block text-xs font-semibold uppercase text-muted-foreground mb-1">{field.label}</label>
          <input 
            type="text" 
            value={block[field.name] || ''} 
            onChange={(e) => updateBlock(index, { [field.name]: e.target.value })}
            className="w-full px-3 py-2 border border-input rounded-md bg-transparent text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {field.helpText && <p className="text-[10px] text-muted-foreground mt-1">{field.helpText}</p>}
        </div>
      );
    }
    if (field.type === 'number') {
      return (
        <div key={field.name}>
          <label className="block text-xs font-semibold uppercase text-muted-foreground mb-1">{field.label}</label>
          <input 
            type="number" 
            min={field.min} max={field.max}
            value={block[field.name] ?? field.defaultValue ?? ''} 
            onChange={(e) => updateBlock(index, { [field.name]: parseInt(e.target.value) || field.defaultValue })}
            className="w-full md:w-1/3 px-3 py-2 border border-input rounded-md bg-transparent text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {field.helpText && <p className="text-[10px] text-muted-foreground mt-1">{field.helpText}</p>}
        </div>
      );
    }
    if (field.type === 'checkbox') {
      return (
        <div key={field.name} className="pt-2 border-t border-border mt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="checkbox" 
              checked={!!block[field.name]}
              onChange={(e) => updateBlock(index, { [field.name]: e.target.checked })}
              className="w-4 h-4 rounded border-input text-primary focus:ring-primary cursor-pointer"
            />
            <span className="text-sm font-semibold">{field.label}</span>
          </label>
        </div>
      );
    }
    if (field.type === 'select') {
      return (
        <div key={field.name}>
          <label className="block text-xs font-semibold uppercase text-muted-foreground mb-1">{field.label}</label>
          <select 
            value={block[field.name] || ''} 
            onChange={(e) => updateBlock(index, { [field.name]: e.target.value })} 
            className="w-full px-3 py-2 border border-input rounded-md bg-transparent text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {field.options?.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          {field.helpText && <p className="text-[10px] text-muted-foreground mt-1">{field.helpText}</p>}
        </div>
      );
    }
    if (field.type === 'range') {
      return (
        <div key={field.name}>
          <label className="block text-xs font-semibold uppercase text-muted-foreground mb-1 flex justify-between">
            <span>{field.label}</span>
            <span>{block[field.name] ?? field.defaultValue}{field.label.includes('%') ? '%' : ''}</span>
          </label>
          <input 
            type="range" 
            min={field.min} max={field.max} 
            value={block[field.name] ?? field.defaultValue} 
            onChange={(e) => updateBlock(index, { [field.name]: parseInt(e.target.value) })}
            className="w-full mt-2 accent-primary"
          />
        </div>
      );
    }
    if (field.type === 'info') {
      return <p key={field.name} className="text-xs text-muted-foreground">{field.helpText}</p>;
    }
    
    // Complex fields
    if (field.type === 'collection_selector') {
      return (
        <div key={field.name} className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-muted/10 p-3 rounded-lg border border-border mb-4">
          <div>
            <label className="block text-[10px] font-bold uppercase text-primary mb-1">{field.label}</label>
            <select 
              value={block[field.name] || 'articles'} 
              onChange={(e) => updateBlock(index, { [field.name]: e.target.value })}
              className="w-full px-2 py-1.5 border border-input rounded text-sm font-semibold bg-background focus:ring-1 focus:ring-primary"
            >
              {collections.length > 0 ? (
                collections.map(c => <option key={c.slug} value={c.slug}>{c.label}</option>)
              ) : (
                <option value="articles">Articles</option>
              )}
            </select>
            {field.helpText && <p className="text-[10px] text-muted-foreground mt-1">{field.helpText}</p>}
          </div>
        </div>
      );
    }

    if (field.type === 'taxonomy_term_selector') {
      return (
        <div key={field.name} className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-muted/10 p-4 border border-border rounded-xl mb-4">
          <div>
            <label className="block text-xs font-semibold uppercase text-muted-foreground mb-1">{field.label}</label>
            <select 
              value={block[field.name] || 'all'} 
              onChange={(e) => updateBlock(index, { [field.name]: e.target.value, termIds: 'all' })}
              className="w-full px-3 py-2 border border-input rounded-md bg-transparent text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="all">All Taxonomies</option>
              {taxonomies.map((tax: any) => (
                <option key={tax.slug} value={tax.slug}>{tax.label || tax.slug}</option>
              ))}
            </select>
          </div>
          
          {block[field.name] && block[field.name] !== 'all' && (
            <div>
              <label className="block text-xs font-semibold uppercase text-muted-foreground mb-1">Filter By Terms</label>
              <select 
                value={block.termIds || 'all'} 
                onChange={(e) => updateBlock(index, { termIds: e.target.value })}
                className="w-full px-3 py-2 border border-input rounded-md bg-transparent text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">All Terms</option>
                {terms.filter((t: any) => t.taxonomyId.toString() === (taxonomies.find((x:any) => x.slug === block[field.name])?.id || '').toString()).map((c: any) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      );
    }

    if (field.type === 'taxonomy_filter_builder') {
      return (
        <div key={field.name} className="bg-muted/10 p-4 border border-border rounded-xl mb-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{field.label}</h4>
            <select
              value={block.filterMatchType || 'AND'}
              onChange={(e) => updateBlock(index, { filterMatchType: e.target.value })}
              className="px-2 py-1 bg-background border border-input rounded text-xs font-semibold focus:ring-1 focus:ring-primary"
            >
              <option value="AND">Match ALL (AND)</option>
              <option value="OR">Match ANY (OR)</option>
            </select>
          </div>

          {(block[field.name] || []).map((filter: any, fIdx: number) => (
            <div key={fIdx} className="flex flex-col md:flex-row gap-2 mb-2 items-center bg-background p-2 rounded border border-border">
              <select
                value={filter.taxonomyId || ''}
                onChange={(e) => {
                  const newFilters = [...(block[field.name] || [])];
                  newFilters[fIdx] = { taxonomyId: e.target.value, termId: 'all' };
                  const firstFilter = newFilters[0];
                  updateBlock(index, { 
                    [field.name]: newFilters,
                    filterTaxonomyId: firstFilter?.taxonomyId || '',
                    filterTermId: firstFilter?.termId || 'all'
                  });
                }}
                className="w-full md:w-1/2 px-2 py-1.5 border border-input rounded text-sm bg-transparent"
              >
                <option value="">Select Taxonomy...</option>
                {taxonomies.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>

              <select
                value={filter.termId || 'all'}
                onChange={(e) => {
                  const newFilters = [...(block[field.name] || [])];
                  newFilters[fIdx] = { ...newFilters[fIdx], termId: e.target.value };
                  const firstFilter = newFilters[0];
                  updateBlock(index, { 
                    [field.name]: newFilters,
                    filterTaxonomyId: firstFilter?.taxonomyId || '',
                    filterTermId: firstFilter?.termId || 'all'
                  });
                }}
                disabled={!filter.taxonomyId}
                className="w-full md:w-1/2 px-2 py-1.5 border border-input rounded text-sm bg-transparent disabled:opacity-50"
              >
                <option value="all">All Terms in Taxonomy</option>
                {terms.filter(t => t.taxonomyId.toString() === (filter.taxonomyId || '').toString()).map(term => (
                  <option key={term.id} value={term.id}>{term.name}</option>
                ))}
              </select>

              <button 
                type="button" 
                onClick={() => {
                  const newFilters = [...(block[field.name] || [])];
                  newFilters.splice(fIdx, 1);
                  const firstFilter = newFilters[0];
                  updateBlock(index, { 
                    [field.name]: newFilters,
                    filterTaxonomyId: firstFilter?.taxonomyId || '',
                    filterTermId: firstFilter?.termId || 'all'
                  });
                }}
                className="p-1.5 text-destructive hover:bg-destructive/10 rounded"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          {(!block[field.name] || block[field.name].length === 0) && ((block.filterTaxonomyId && block.filterTaxonomyId !== 'all') || (block.categoryId && block.categoryId !== 'all')) && (
            <div className="mb-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-600">
              <strong>Legacy Filter Active:</strong> Using legacy taxonomy/category filter. Add a new filter above to upgrade.
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              const newFilters = [...(block[field.name] || []), { taxonomyId: '', termId: 'all' }];
              updateBlock(index, { [field.name]: newFilters });
            }}
            className="text-xs font-semibold text-primary hover:bg-primary/10 px-2 py-1 rounded mt-1 flex items-center gap-1 transition-colors"
          >
            <Plus size={14} /> Add Taxonomy Filter
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {blocks.map((block: Block, index: number) => {
          const config = blockRegistry.find(b => b.type === block.type);
          const group = config?.group || 'FULL WIDTH (100%)';

          return (
            <div key={block.id} className="bg-card border border-border rounded-xl p-4 shadow-sm relative">
              <div className="flex items-center justify-between mb-4 pb-2 border-b border-border">
                <div className="flex items-center gap-3">
                  <span className="font-bold uppercase tracking-wider text-sm text-primary">
                    {(block.type || 'unknown').replace(/_/g, ' ')}
                  </span>
                  {getLayoutBadge(group)}
                  {block.title && <span className="text-muted-foreground text-sm">- {block.title}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => moveUp(index)} disabled={index === 0} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded disabled:opacity-30"><ArrowUp size={16} /></button>
                  <button type="button" onClick={() => moveDown(index)} disabled={index === blocks.length - 1} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded disabled:opacity-30"><ArrowDown size={16} /></button>
                  <button type="button" onClick={() => removeBlock(index)} className="p-1.5 text-destructive hover:bg-destructive/10 rounded ml-2"><Trash2 size={16} /></button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {config ? (
                  config.fields.map(field => (
                    <div key={field.name} className={['taxonomy_filter_builder', 'collection_selector', 'taxonomy_term_selector', 'info'].includes(field.type) ? 'col-span-1 md:col-span-2' : ''}>
                      {renderField(field, block, index)}
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-amber-600 col-span-2">Warning: Unknown block type. Settings cannot be edited.</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-muted/30 p-4 rounded-xl border border-border">
          <div className="flex flex-wrap gap-2">
            <span className="text-sm font-semibold mr-2 flex items-center">Add Block:</span>
            {blockRegistry.map(config => (
              <button 
                key={config.type} 
                type="button" 
                onClick={() => addBlock(config)} 
                className={`px-3 py-1.5 text-xs font-bold uppercase rounded transition-colors ${config.colorClass}`}
              >
                {config.label}
              </button>
            ))}
          </div>
      </div>
    </div>
  );
}
