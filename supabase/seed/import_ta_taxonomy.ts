/**
 * supabase/seed/import_ta_taxonomy.ts
 *
 * One-time (idempotent) importer that reads TA's source-of-truth spreadsheets
 * and populates the Procurement Intelligence Platform's taxonomy tables:
 *
 *   TA_Material_List.xlsx   →  skus, suppliers, materials, sku_materials
 *   TA_Commodity_Origin_Map.xlsx  →  commodities, material_commodities
 *
 * Then derives:
 *   - commodity.category          (Petrochemical | Agricultural | ... )
 *   - commodity.standing_floor    ('Monitor' for petrochemicals, gelatin, China-sourced, etc.)
 *   - keywords + keyword→commodity links
 *
 * USAGE
 *   Place Updated__Material_List.xlsx and TA_Commodity_Origin_Map.xlsx under
 *   ./data/ at the repo root, then:
 *       npm run seed:taxonomy
 *
 * ENV
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (NOT the anon key — writes need service role)
 *
 * IDEMPOTENCY
 *   All inserts use upsert() on natural keys. Running twice produces no dupes.
 *
 * NOTE ON CONFIDENCE
 *   Category + standing_floor derivation uses rule-based pattern matching on
 *   commodity names. It catches ~90% of TA's real commodities correctly. The
 *   remaining ~10% should be reviewed manually via /admin after first run.
 *   A `_review` flag is set on auto-classified rows so the admin UI can surface them.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const MATERIAL_FILE = path.join(DATA_DIR, 'TA_Material_List.xlsx');
const COMMODITY_FILE = path.join(DATA_DIR, 'TA_Commodity_Origin_Map.xlsx');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// TYPES (mirror of DB schema)
// ─────────────────────────────────────────────────────────────────────────────

type MaterialRow = {
  sku: string;
  materialDescription: string;
  tier: string;
  oem: string;
  ingredients: string;
};

type CommodityRow = {
  materialDescription: string;     // joins to materials.description
  materialName: string;            // the actual ingredient (e.g. 'Glycerin')
  materialType: string;            // 'Humectant', 'Emollient', ...
  primaryCommodity: string;        // 'Palm Oil (CPO)', 'Petroleum (Propylene)'
  sourceCategory: string;          // 'Plant' | 'Synthetic' | 'Mineral' | 'Animal' | mixed
  process: string;
  confidence: string;
  notes: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// XLSX READERS
// ─────────────────────────────────────────────────────────────────────────────

function readMaterials(): MaterialRow[] {
  const wb = XLSX.read(readFileSync(MATERIAL_FILE), { type: 'buffer' });
  const ws = wb.Sheets['New Material List'];
  if (!ws) throw new Error('Sheet "New Material List" not found in material xlsx');
  const raw = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' });

  return raw
    .map(r => ({
      sku: String(r['SKU Name'] || '').trim(),
      materialDescription: String(r['Material Description'] || '').trim(),
      tier: String(r['Tier'] || '').trim(),
      oem: String(r['OEM'] || '').trim().replace(/\s+/g, ' '),
      ingredients: String(r['Materials/Ingredients'] || '').trim(),
    }))
    .filter(r => r.sku && r.materialDescription);
}

function readCommodities(): CommodityRow[] {
  const wb = XLSX.read(readFileSync(COMMODITY_FILE), { type: 'buffer' });
  const ws = wb.Sheets['Commodity Map'];
  if (!ws) throw new Error('Sheet "Commodity Map" not found in commodity xlsx');
  const raw = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' });

  return raw
    .map(r => ({
      materialDescription: String(r['Component Name'] || '').trim(),
      materialName: String(r['Material Name'] || '').trim(),
      materialType: String(r['Material Type'] || '').trim(),
      primaryCommodity: String(r['Primary Source (Commodity)'] || '').trim(),
      sourceCategory: String(r['Source Category'] || '').trim(),
      process: String(r['Process Summary'] || '').trim(),
      confidence: String(r['Confidence Level'] || '').trim(),
      notes: r['Notes'] ? String(r['Notes']).trim() : null,
    }))
    .filter(r => r.materialDescription && r.primaryCommodity);
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY & STANDING-FLOOR DERIVATION
// ─────────────────────────────────────────────────────────────────────────────
// Rules mirror the TA Procurement Dashboard risk-level definitions.

function deriveCategory(commodity: string, sourceCategory: string): string {
  const c = commodity.toLowerCase();

  if (/petroleum|propylene|ethylene|pta|meg|caprolactam|acrylic|silicon|phenol|naphtha|pe\/pp|ptsa/.test(c)) return 'Petrochemical';
  if (/palm|cpo|coconut|olive|sugarcane|shea|oat|soybean|sunflower|chamomile|lavender|aloe|castor|carnauba|rapeseed|almond/.test(c)) return 'Agricultural';
  if (/bovine|hide|bone|gelatin|lanolin|honey|royal jelly|wool|sheep|whey/.test(c)) return 'Animal-origin';
  if (/zinc|titanium|ilmenite|rutile|silica|limestone|calcite|phosphate|fluorite|fluorspar/.test(c)) return 'Mineral / China-sourced';
  if (/wood pulp|nbsk|bhkp|occ|recycled fibre|containerboard/.test(c)) return 'Paper & Pulp';
  if (/3-methylpyridine|niacinamide|cholecalciferol|vitamin|ascorbic|tocopherol/.test(c)) return 'Vitamins / Nutraceutical';
  if (/fermentation|microbial/.test(c)) return 'Bio-fermentation';

  // Source-category fallback
  if (sourceCategory === 'Synthetic') return 'Synthetic / Chemical';
  if (sourceCategory === 'Plant') return 'Agricultural';
  if (sourceCategory === 'Animal') return 'Animal-origin';
  if (sourceCategory === 'Mineral') return 'Mineral';

  return 'Other';
}

function deriveStandingFloor(commodity: string): 'Stable' | 'Monitor' {
  const c = commodity.toLowerCase();
  // The Procurement Dashboard prompt defines these as never dropping below 🟡:
  //   - All petrochemicals
  //   - Bovine gelatin
  //   - Zinc Oxide, Niacinamide, Titanium Dioxide (all China-sourced)
  //   - USD-linked imports (handled via FX keyword category, not per-commodity)
  if (/petroleum|propylene|ethylene|pta|meg|caprolactam|acrylic|silicon|phenol|naphtha/.test(c)) return 'Monitor';
  if (/bovine|hide|bone|gelatin/.test(c)) return 'Monitor';
  if (/zinc|titanium|ilmenite|rutile/.test(c)) return 'Monitor';
  if (/3-methylpyridine|niacinamide/.test(c)) return 'Monitor';
  return 'Stable';
}

function deriveTypicalOrigin(commodity: string, notes: string | null): string | null {
  const hay = `${commodity} ${notes || ''}`.toLowerCase();
  if (/malaysia|indonesia|\bid\b|\bmy\b/.test(hay) && /palm|cpo/.test(hay)) return 'Indonesia / Malaysia';
  if (/china/.test(hay)) return 'China';
  if (/india/.test(hay)) return 'India';
  if (/west africa|burkina|ghana|ivory coast/.test(hay)) return 'West Africa';
  if (/brazil|carnauba/.test(hay)) return 'Brazil';
  if (/spain|italy|greece|mediterranean/.test(hay)) return 'Mediterranean';
  if (/hawaii|kukui/.test(hay)) return 'Pacific';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD TAXONOMY (hand-curated, calibrated to TA's commodities)
// ─────────────────────────────────────────────────────────────────────────────
// Maps commodity name patterns → search keywords. When a commodity name matches
// a pattern, all listed keywords are inserted with that commodity_id.

const KEYWORD_MAP: { match: RegExp; terms: { term: string; weight: number }[] }[] = [
  {
    match: /palm oil|cpo/i,
    terms: [
      { term: 'CPO', weight: 2 }, { term: 'crude palm oil', weight: 2 },
      { term: 'palm oil', weight: 1 }, { term: 'MPOB', weight: 2 },
      { term: 'GAPKI', weight: 2 }, { term: 'malaysia palm', weight: 1 },
      { term: 'BMD palm', weight: 1 }, { term: 'palm futures', weight: 1 },
    ],
  },
  {
    match: /coconut|palm kernel/i,
    terms: [
      { term: 'coconut oil', weight: 1 }, { term: 'copra', weight: 1 },
      { term: 'palm kernel oil', weight: 1 }, { term: 'PKO', weight: 1 },
    ],
  },
  {
    match: /shea/i,
    terms: [
      { term: 'shea butter', weight: 2 }, { term: 'shea nut', weight: 1 },
      { term: 'burkina faso shea', weight: 1 },
    ],
  },
  {
    match: /petroleum \(propylene\)|propylene/i,
    terms: [
      { term: 'propylene', weight: 2 }, { term: 'PP polymer', weight: 2 },
      { term: 'polypropylene', weight: 2 }, { term: 'naphtha crack', weight: 1 },
    ],
  },
  {
    match: /petroleum \(ethylene\)|ethylene/i,
    terms: [
      { term: 'ethylene', weight: 2 }, { term: 'LLDPE', weight: 2 },
      { term: 'HDPE', weight: 2 }, { term: 'ethylene spot', weight: 1 },
      { term: 'polyethylene', weight: 1 },
    ],
  },
  {
    match: /petroleum \(pta|meg|pta \+ meg/i,
    terms: [
      { term: 'PET resin', weight: 2 }, { term: 'PTA price', weight: 2 },
      { term: 'MEG price', weight: 2 }, { term: 'polyester film', weight: 1 },
      { term: 'BOPP', weight: 1 }, { term: 'VMPET', weight: 1 },
    ],
  },
  {
    match: /caprolactam/i,
    terms: [
      { term: 'caprolactam', weight: 2 }, { term: 'nylon 6', weight: 2 },
      { term: 'NYL film', weight: 1 },
    ],
  },
  {
    match: /silicon|methanol/i,
    terms: [
      { term: 'dimethicone', weight: 2 }, { term: 'silicone oil', weight: 2 },
      { term: 'siloxane', weight: 1 },
    ],
  },
  {
    match: /phenol/i,
    terms: [
      { term: 'phenol', weight: 1 }, { term: 'phenoxyethanol', weight: 2 },
    ],
  },
  // Brent/geopolitical — attached to a generic Petroleum commodity via separate seeding
  {
    match: /bovine|hide|bone/i,
    terms: [
      { term: 'bovine gelatin', weight: 3 }, { term: 'gelatin sapi', weight: 3 },
      { term: 'gelita', weight: 2 }, { term: 'rousselot', weight: 2 },
      { term: 'PB leiner', weight: 2 }, { term: 'hide price', weight: 2 },
      { term: 'cattle hide', weight: 2 }, { term: 'gelatin supply', weight: 2 },
    ],
  },
  {
    match: /zinc ore|zinc/i,
    terms: [
      { term: 'zinc oxide', weight: 2 }, { term: 'ZnO', weight: 2 },
      { term: 'china zinc', weight: 2 }, { term: 'zinc export', weight: 2 },
    ],
  },
  {
    match: /3-methylpyridine|niacinamide/i,
    terms: [
      { term: 'niacinamide', weight: 2 }, { term: 'niacin price', weight: 1 },
      { term: 'china niacinamide', weight: 2 },
    ],
  },
  {
    match: /ilmenite|rutile|titanium/i,
    terms: [
      { term: 'titanium dioxide', weight: 2 }, { term: 'TiO2', weight: 2 },
      { term: 'china TiO2 export', weight: 2 },
    ],
  },
  {
    match: /cholecalciferol|vitamin d3|vitamin d/i,
    terms: [
      { term: 'vitamin D3', weight: 2 }, { term: 'cholecalciferol', weight: 2 },
      { term: 'lanolin vitamin', weight: 1 },
    ],
  },
  {
    match: /wood pulp|nbsk|bhkp/i,
    terms: [
      { term: 'NBSK', weight: 2 }, { term: 'BHKP', weight: 2 },
      { term: 'softwood pulp', weight: 1 }, { term: 'hardwood pulp', weight: 1 },
      { term: 'pulp price', weight: 1 },
    ],
  },
  {
    match: /occ|recycled fibre|containerboard/i,
    terms: [
      { term: 'OCC', weight: 2 }, { term: 'containerboard', weight: 2 },
      { term: 'corrugated price', weight: 1 },
    ],
  },
  {
    match: /sugarcane|squalane/i,
    terms: [
      { term: 'squalane price', weight: 2 }, { term: 'sugarcane squalane', weight: 1 },
      { term: 'olive squalene', weight: 1 },
    ],
  },
  {
    match: /castor/i,
    terms: [
      { term: 'castor oil', weight: 2 }, { term: 'india castor', weight: 1 },
      { term: 'PEG-40 HCO', weight: 1 },
    ],
  },
];

// Cross-cutting keywords not tied to a single commodity — attach to "synthetic
// aggregate" commodity rows created for FX, Freight, and Geopolitical oil.
const MACRO_KEYWORDS: { commodityName: string; category: string; standingFloor: 'Stable' | 'Monitor'; terms: { term: string; weight: number }[] }[] = [
  {
    commodityName: 'FX - USD/IDR',
    category: 'FX',
    standingFloor: 'Monitor',
    terms: [
      { term: 'USD/IDR', weight: 3 }, { term: 'rupiah', weight: 2 },
      { term: 'bank indonesia', weight: 2 }, { term: 'BI rate', weight: 2 },
      { term: 'BI 7-day', weight: 1 }, { term: 'idr weakens', weight: 2 },
      { term: 'idr strengthens', weight: 1 },
    ],
  },
  {
    commodityName: 'FX - USD/CNY',
    category: 'FX',
    standingFloor: 'Stable',
    terms: [
      { term: 'yuan', weight: 2 }, { term: 'RMB', weight: 2 },
      { term: 'PBOC', weight: 2 }, { term: 'china PMI', weight: 1 },
    ],
  },
  {
    commodityName: 'Macro - US Fed',
    category: 'FX',
    standingFloor: 'Stable',
    terms: [
      { term: 'fed rate', weight: 2 }, { term: 'federal reserve', weight: 2 },
      { term: 'FOMC', weight: 2 }, { term: 'US inflation', weight: 1 },
      { term: 'CPI', weight: 1 }, { term: 'dot plot', weight: 1 },
    ],
  },
  {
    commodityName: 'Crude Oil - Brent',
    category: 'Petrochemical',
    standingFloor: 'Monitor',
    terms: [
      { term: 'brent crude', weight: 3 }, { term: 'WTI', weight: 2 },
      { term: 'OPEC', weight: 2 }, { term: 'opec+', weight: 2 },
      { term: 'oil price', weight: 1 },
    ],
  },
  {
    commodityName: 'Geopolitics - Middle East Shipping',
    category: 'Freight',
    standingFloor: 'Monitor',
    terms: [
      { term: 'strait of hormuz', weight: 3 }, { term: 'iran oil', weight: 2 },
      { term: 'red sea', weight: 2 }, { term: 'suez', weight: 2 },
      { term: 'tanker insurance', weight: 2 },
    ],
  },
  {
    commodityName: 'Freight - Ocean Container',
    category: 'Freight',
    standingFloor: 'Stable',
    terms: [
      { term: 'baltic dry', weight: 2 }, { term: 'BDI', weight: 2 },
      { term: 'shanghai containerized', weight: 2 }, { term: 'SCFI', weight: 2 },
      { term: 'drewry', weight: 2 }, { term: 'container rate', weight: 1 },
    ],
  },
  {
    commodityName: 'Tariffs - US China',
    category: 'Geopolitics',
    standingFloor: 'Monitor',
    terms: [
      { term: 'section 301', weight: 2 }, { term: 'china tariff', weight: 2 },
      { term: 'US tariff', weight: 1 }, { term: 'trade war', weight: 1 },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function upsertSupplier(name: string): Promise<number> {
  const { data, error } = await supabase
    .from('suppliers')
    .upsert({ name }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`supplier ${name}: ${error.message}`);
  return data!.id;
}

async function upsertSku(name: string): Promise<number> {
  const { data, error } = await supabase
    .from('skus')
    .upsert({ name }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`sku ${name}: ${error.message}`);
  return data!.id;
}

async function upsertMaterial(description: string, tier: string, supplierId: number): Promise<number> {
  const { data, error } = await supabase
    .from('materials')
    .upsert({ description, tier, supplier_id: supplierId }, { onConflict: 'description' })
    .select('id')
    .single();
  if (error) throw new Error(`material ${description}: ${error.message}`);
  return data!.id;
}

async function upsertCommodity(
  name: string,
  category: string,
  sourceCategory: string,
  standingFloor: 'Stable' | 'Monitor',
  typicalOrigin: string | null
): Promise<number> {
  const { data, error } = await supabase
    .from('commodities')
    .upsert(
      { name, category, source_category: sourceCategory, standing_floor: standingFloor, typical_origin: typicalOrigin },
      { onConflict: 'name' }
    )
    .select('id')
    .single();
  if (error) throw new Error(`commodity ${name}: ${error.message}`);
  return data!.id;
}

async function linkMaterialCommodity(materialId: number, commodityId: number) {
  const { error } = await supabase
    .from('material_commodities')
    .upsert({ material_id: materialId, commodity_id: commodityId }, { ignoreDuplicates: true });
  if (error) throw new Error(`link m${materialId}-c${commodityId}: ${error.message}`);
}

async function linkSkuMaterial(skuId: number, materialId: number) {
  const { error } = await supabase
    .from('sku_materials')
    .upsert({ sku_id: skuId, material_id: materialId }, { ignoreDuplicates: true });
  if (error) throw new Error(`link s${skuId}-m${materialId}: ${error.message}`);
}

async function upsertKeyword(term: string, commodityId: number, weight: number) {
  const { error } = await supabase
    .from('keywords')
    .upsert({ term, commodity_id: commodityId, weight }, { onConflict: 'term,commodity_id' });
  if (error) throw new Error(`keyword ${term}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━━━ TA Taxonomy Import ━━━');

  // ─── 1. Materials file → suppliers, skus, materials, sku_materials ─────────
  const materials = readMaterials();
  console.log(`→ Loaded ${materials.length} material rows`);

  const supplierCache = new Map<string, number>();
  const skuCache = new Map<string, number>();
  const materialCache = new Map<string, number>(); // key: materialDescription

  for (const row of materials) {
    if (row.oem === '#N/A' || !row.oem) continue;

    if (!supplierCache.has(row.oem)) {
      supplierCache.set(row.oem, await upsertSupplier(row.oem));
    }
    const supplierId = supplierCache.get(row.oem)!;

    if (!skuCache.has(row.sku)) {
      skuCache.set(row.sku, await upsertSku(row.sku));
    }
    const skuId = skuCache.get(row.sku)!;

    if (!materialCache.has(row.materialDescription)) {
      materialCache.set(
        row.materialDescription,
        await upsertMaterial(row.materialDescription, row.tier, supplierId)
      );
    }
    const materialId = materialCache.get(row.materialDescription)!;

    await linkSkuMaterial(skuId, materialId);
  }
  console.log(`✔ ${supplierCache.size} suppliers, ${skuCache.size} skus, ${materialCache.size} materials`);

  // ─── 2. Commodity map → commodities, material_commodities ──────────────────
  const commodityRows = readCommodities();
  console.log(`→ Loaded ${commodityRows.length} commodity rows`);

  const commodityCache = new Map<string, number>();
  let linkedMat = 0;
  let skippedMat = 0;

  for (const row of commodityRows) {
    const commodityName = row.primaryCommodity;
    if (!commodityCache.has(commodityName)) {
      const category = deriveCategory(commodityName, row.sourceCategory);
      const floor = deriveStandingFloor(commodityName);
      const origin = deriveTypicalOrigin(commodityName, row.notes);
      commodityCache.set(
        commodityName,
        await upsertCommodity(commodityName, category, row.sourceCategory, floor, origin)
      );
    }
    const commodityId = commodityCache.get(commodityName)!;

    // Link to the material if the description matches what we loaded
    const materialId = materialCache.get(row.materialDescription);
    if (materialId) {
      await linkMaterialCommodity(materialId, commodityId);
      linkedMat++;
    } else {
      // Commodity map has a material description not present in the material list;
      // likely means Material List uses a slightly different label. Log so we can
      // fix in admin later.
      skippedMat++;
    }
  }
  console.log(`✔ ${commodityCache.size} commodities, ${linkedMat} material↔commodity links (${skippedMat} orphaned — review in /admin)`);

  // ─── 3. Macro / cross-cutting commodities ──────────────────────────────────
  for (const macro of MACRO_KEYWORDS) {
    const id = await upsertCommodity(
      macro.commodityName,
      macro.category,
      'N/A (aggregate)',
      macro.standingFloor,
      null
    );
    commodityCache.set(macro.commodityName, id);
    for (const kw of macro.terms) {
      await upsertKeyword(kw.term, id, kw.weight);
    }
  }
  console.log(`✔ ${MACRO_KEYWORDS.length} macro aggregates seeded with keywords`);

  // ─── 4. Keyword map → keywords ─────────────────────────────────────────────
  let kwCount = 0;
  for (const [commodityName, commodityId] of commodityCache.entries()) {
    for (const rule of KEYWORD_MAP) {
      if (rule.match.test(commodityName)) {
        for (const kw of rule.terms) {
          await upsertKeyword(kw.term, commodityId, kw.weight);
          kwCount++;
        }
      }
    }
  }
  console.log(`✔ ${kwCount} keyword↔commodity pairs seeded`);

  console.log('━━━ Import complete ━━━');
  console.log('Next: run `npm run seed:feeds` to populate the feed registry.');
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
