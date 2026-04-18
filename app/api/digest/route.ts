import { createClient } from "@supabase/supabase-js";

export const revalidate = 300;
export const dynamic = "force-dynamic";

type Commodity = {
  id: number;
  name: string;
  category: string | null;
  standing_floor: string | null;
};

type MaterialRow = {
  id: number;
  description: string;
  tier: string | null;
  supplier_name: string | null;
  sku_names: string[];
};

type ArticleRow = {
  id: number;
  title: string;
  link: string;
  summary: string | null;
  published_at: string | null;
  score: number;
  feeds: { name: string; priority_tier: number } | null;
  article_tags: { commodities: Commodity | null }[];
};

function getMondayOf(d: Date) {
  const dt = new Date(d);
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - (day - 1));
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const { data: articlesRaw, error } = await supabase
    .from("articles")
    .select(
      `id, title, link, summary, published_at, score,
       feeds(name, priority_tier),
       article_tags(commodities(id, name, category, standing_floor))`
    )
    .gte("published_at", since)
    .gte("score", 4)
    .order("score", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(300);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const articles = (articlesRaw as unknown as ArticleRow[]) ?? [];

  const { data: allMaterialsRaw } = await supabase
    .from("materials")
    .select(
      `id, description, tier,
       suppliers(name),
       sku_materials(skus(name)),
       material_commodities(commodity_id)`
    );

  const materialsByCommodity = new Map<number, MaterialRow[]>();
  for (const m of (allMaterialsRaw as any[]) ?? []) {
    const row: MaterialRow = {
      id: m.id,
      description: m.description,
      tier: m.tier,
      supplier_name: m.suppliers?.name ?? null,
      sku_names: (m.sku_materials ?? [])
        .map((sm: any) => sm.skus?.name)
        .filter(Boolean),
    };
    for (const mc of m.material_commodities ?? []) {
      if (!materialsByCommodity.has(mc.commodity_id)) {
        materialsByCommodity.set(mc.commodity_id, []);
      }
      materialsByCommodity.get(mc.commodity_id)!.push(row);
    }
  }

  const { data: allCommodities } = await supabase
    .from("commodities")
    .select("id, name, category");

  const commoditiesByCategory = new Map<string, number[]>();
  for (const c of (allCommodities as any[]) ?? []) {
    if (!c.category) continue;
    if (!commoditiesByCategory.has(c.category)) {
      commoditiesByCategory.set(c.category, []);
    }
    commoditiesByCategory.get(c.category)!.push(c.id);
  }

  const MACRO_CATEGORIES_HIT_ALL = new Set(["Freight", "FX", "Geopolitics"]);

function getMaterialsForCommodity(
  commodityId: number,
  category: string | null
): MaterialRow[] {
  const direct = materialsByCommodity.get(commodityId);
  if (direct && direct.length > 0) return direct;
  if (!category) return [];

  if (MACRO_CATEGORIES_HIT_ALL.has(category)) {
    const seen = new Set<number>();
    const all: MaterialRow[] = [];
    for (const rows of materialsByCommodity.values()) {
      for (const m of rows) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        all.push(m);
      }
    }
    return all;
  }

  const siblingIds = commoditiesByCategory.get(category) ?? [];
    const seen = new Set<number>();
    const result: MaterialRow[] = [];
    for (const sid of siblingIds) {
      for (const m of materialsByCommodity.get(sid) ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        result.push(m);
      }
    }
    return result;
  }

  const byCommodity = new Map<
    number,
    {
      commodity: string;
      category: string | null;
      standing_floor: string | null;
      signal_count: number;
      top_score: number;
      headlines: any[];
      affected_materials: MaterialRow[];
      materials_via_category: boolean;
    }
  >();

  for (const a of articles) {
    for (const tag of a.article_tags ?? []) {
      const c = tag.commodities;
      if (!c) continue;

      if (!byCommodity.has(c.id)) {
        const mats = getMaterialsForCommodity(c.id, c.category);
        const direct = materialsByCommodity.get(c.id) ?? [];

        byCommodity.set(c.id, {
          commodity: c.name,
          category: c.category,
          standing_floor: c.standing_floor,
          signal_count: 0,
          top_score: 0,
          headlines: [],
          affected_materials: mats,
          materials_via_category: direct.length === 0 && mats.length > 0,
        });
      }
      const entry = byCommodity.get(c.id)!;
      entry.signal_count++;
      entry.top_score = Math.max(entry.top_score, a.score);

      if (entry.headlines.length < 5) {
        entry.headlines.push({
          title: a.title,
          source: a.feeds?.name ?? "unknown",
          published_at: a.published_at,
          score: a.score,
          link: a.link,
        });
      }
    }
  }

  const commodity_signals = Array.from(byCommodity.values())
    .sort((a, b) => b.top_score - a.top_score || b.signal_count - a.signal_count)
    .map((entry) => ({
      commodity: entry.commodity,
      category: entry.category,
      standing_floor: entry.standing_floor,
      signal_count: entry.signal_count,
      top_score: entry.top_score,
      headlines: entry.headlines,
      materials_via_category: entry.materials_via_category,
      affected_materials: entry.affected_materials.map((m) => ({
        material: m.description,
        tier: m.tier,
        supplier: m.supplier_name,
        skus: m.sku_names,
      })),
    }));

  return Response.json({
    generated_at: new Date().toISOString(),
    week_starting: getMondayOf(new Date()).toISOString().slice(0, 10),
    total_articles: articles.length,
    commodity_signals,
  });
}
