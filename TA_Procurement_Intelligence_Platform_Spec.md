# TA Procurement Intelligence Platform

**Upstream data engine for the TA Weekly Procurement Early Warning Dashboard**

Version 1.0 · Build Spec · April 2026

---

## 1. What this is (and what it isn't)

This is a **procurement-calibrated RSS intelligence engine** — not a generic Feedly clone. It ingests 20+ curated feeds, scores every article against TA's actual material universe (50 SKUs, 21 suppliers, 159 commodity origins mapped in `TA_Commodity_Origin_Map.xlsx`), and outputs two things:

1. **Live public dashboard** — browsable by anyone, filtered by commodity/risk/SKU impact
2. **Machine-readable weekly digest** — the exact signals Claude needs to populate the Procurement Early Warning Dashboard table

**It is NOT:** a news reader, a replacement for human judgment, or a crystal ball. It surfaces *signals*; procurement still decides *actions*.

**Honest limitations upfront:**
- RSS feeds break, get paywalled, or change schemas — expect ~10% of listed feeds to need fixes in Year 1
- Scoring is rule-based keyword matching, not ML semantic understanding — good enough for signal detection, not for nuance
- "Free tier" holds at Supabase free (500MB DB, 2GB bandwidth) + Vercel hobby — upgrade needed only if traffic exceeds ~10k pageviews/month

---

## 2. System architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA SOURCES (RSS)                           │
│  Reuters · Bloomberg · FT · FreightWaves · SupplyChainDive ·        │
│  JakartaPost · CNBC Indonesia · BI · BPS · World Bank · IMF ·       │
│  Oilprice · Kitco · TradingEconomics · DailyFX · Loadstar · JOC     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ every 30 min
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│          INGESTION (Vercel Cron → Next.js API Route)                │
│  1. fetch RSS → parse XML (rss-parser)                              │
│  2. dedupe by article hash                                          │
│  3. enrich: keyword match, score, tag, map to TA materials          │
│  4. insert into Supabase                                            │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DATABASE (Supabase Postgres)                     │
│  articles · feeds · keywords · commodities · materials · suppliers  │
│  · skus · article_tags · weekly_digests                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  PUBLIC DASHBOARD (Next.js on Vercel)               │
│  /           → live feed dashboard (categories, filters, scores)    │
│  /critical   → 🔴/⚫ only                                           │
│  /commodity/[slug] → per-commodity deep dive                        │
│  /sku/[slug] → which signals affect this SKU                        │
│  /digest     → weekly Claude-ready JSON                             │
│  /api/digest → JSON endpoint for Claude to ingest                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Data flow in one sentence:** RSS → Vercel Cron fetches → Supabase stores with relevance scores → Public Next.js dashboard reads → Weekly digest API serves Claude on "Refresh Dashboard".

---

## 3. Tech stack decisions & reasoning

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 (App Router) | React + SSR + edge caching; best-in-class Vercel integration |
| Styling | Tailwind CSS + shadcn/ui | Fast iteration, zero design debt |
| Database | Supabase (Postgres) | Free tier viable, row-level security, auto-REST API |
| Hosting | Vercel | Free hobby tier, cron built-in, auto-deploy from GitHub |
| Cron | Vercel Cron Jobs | Free tier: unlimited schedules, runs `/api/ingest` every 30 min |
| RSS Parser | `rss-parser` npm | Handles RSS 2.0 + Atom + bad XML gracefully |
| Auth (admin only) | Supabase Auth (magic link) | For `/admin` panel to add feeds/keywords |
| Public access | No auth | Anyone with the URL can read |
| Repo | GitHub (public) | Open-source, one-click Vercel deploy |

**What we rejected and why:**
- **Firebase Firestore** — NoSQL is wrong for relational taxonomy (commodity → material → SKU joins)
- **Google Apps Script** — 6-min execution limit breaks with 20+ feeds; hard to share publicly; no real frontend
- **Python FastAPI** — needs DevOps, separate hosting bill, loses Vercel's free cron

---

## 4. Database schema (Supabase / Postgres)

```sql
-- Feeds we ingest from
CREATE TABLE feeds (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  priority_tier   INT NOT NULL DEFAULT 2,  -- 1=premium (Reuters/Bloomberg/FT), 2=standard, 3=niche
  category        TEXT,                    -- 'macro' | 'fx' | 'commodities' | 'logistics' | 'indonesia'
  active          BOOLEAN DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  fetch_error     TEXT,                    -- latest error if feed is broken
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Normalized articles
CREATE TABLE articles (
  id              BIGSERIAL PRIMARY KEY,
  feed_id         BIGINT REFERENCES feeds(id),
  guid            TEXT NOT NULL,           -- RSS guid or link hash
  title           TEXT NOT NULL,
  link            TEXT NOT NULL,
  summary         TEXT,
  author          TEXT,
  published_at    TIMESTAMPTZ,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  score           INT DEFAULT 0,           -- 0-10 relevance
  content_hash    TEXT,                    -- for dedupe across feeds
  UNIQUE(feed_id, guid)
);
CREATE INDEX idx_articles_published ON articles(published_at DESC);
CREATE INDEX idx_articles_score ON articles(score DESC);

-- TA's taxonomy (seeded from TA_Commodity_Origin_Map.xlsx)
CREATE TABLE commodities (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,    -- 'Palm Oil (CPO)', 'Petroleum (Propylene)', 'Bovine Hide / Bone'
  category        TEXT,                    -- 'Petrochemical' | 'Agricultural' | 'Chemical (China)' | 'Paper & Pulp' | 'Vitamins' | 'FX' | 'Freight'
  source_category TEXT,                    -- 'Plant' | 'Synthetic' | 'Mineral' | 'Animal' (from Origin Map)
  standing_floor  TEXT DEFAULT 'Stable',   -- 'Stable' | 'Monitor' (enforces 🟡 floor rule)
  typical_origin  TEXT                     -- 'China', 'Indonesia', 'Malaysia', 'India', 'West Africa'
);

CREATE TABLE materials (
  id              BIGSERIAL PRIMARY KEY,
  description     TEXT NOT NULL,           -- 'Filling - Daily PrOATect Cream 150gr'
  tier            TEXT,                    -- 'Main Product' | 'Primary Packaging' | ...
  supplier_id     BIGINT REFERENCES suppliers(id),
  UNIQUE(description)
);

CREATE TABLE suppliers (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE     -- 'Nose Herbalindo, PT', 'Yupi Indo Jelly Gum, PT'
);

CREATE TABLE skus (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE     -- 'Expert Care - Face & Body Lotion Cream Moisturizer 150 gr'
);

-- Material ↔ Commodity (many-to-many; one material uses many commodities)
CREATE TABLE material_commodities (
  material_id     BIGINT REFERENCES materials(id),
  commodity_id    BIGINT REFERENCES commodities(id),
  PRIMARY KEY (material_id, commodity_id)
);

-- SKU ↔ Material (many-to-many; one SKU uses many materials)
CREATE TABLE sku_materials (
  sku_id          BIGINT REFERENCES skus(id),
  material_id     BIGINT REFERENCES materials(id),
  PRIMARY KEY (sku_id, material_id)
);

-- Keywords that trigger a commodity match
CREATE TABLE keywords (
  id              BIGSERIAL PRIMARY KEY,
  term            TEXT NOT NULL,           -- 'brent crude', 'strait of hormuz', 'CPO', 'gelatin'
  commodity_id    BIGINT REFERENCES commodities(id),
  weight          INT DEFAULT 1,           -- some terms are stronger signals
  is_synonym_of   BIGINT REFERENCES keywords(id)  -- 'Fed' → 'Federal Reserve'
);
CREATE INDEX idx_keywords_term_lower ON keywords(LOWER(term));

-- Tags applied to articles after scoring
CREATE TABLE article_tags (
  article_id      BIGINT REFERENCES articles(id) ON DELETE CASCADE,
  commodity_id    BIGINT REFERENCES commodities(id),
  match_location  TEXT,                    -- 'title' | 'summary' | 'both'
  PRIMARY KEY (article_id, commodity_id)
);

-- Computed weekly digest (the Claude-ready payload)
CREATE TABLE weekly_digests (
  id              BIGSERIAL PRIMARY KEY,
  week_starting   DATE NOT NULL UNIQUE,
  payload         JSONB NOT NULL,          -- the full Signal→SKU structure
  generated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. Keyword taxonomy (calibrated to TA)

Seeded from `TA_Commodity_Origin_Map.xlsx`. Every commodity TA actually uses gets keywords. High-weight terms trigger priority scoring.

```yaml
# Top signal commodities with keyword sets
Petrochemical:
  "Petroleum (Propylene)":     [propylene, PP polymer, polypropylene, naphtha crack]
  "Petroleum (Ethylene)":      [ethylene, LLDPE, HDPE, ethylene spot]
  "Petroleum (PTA + MEG)":     [PET resin, PTA price, MEG price, polyester film]
  "Petroleum (Caprolactam)":   [caprolactam, nylon 6, NYL film]
  "Petroleum (Silicon + Methanol)": [dimethicone, silicone oil, siloxane]
  "Petroleum / Phenol":        [phenol, phenoxyethanol]
  Brent / geopolitical:        [brent crude, WTI, strait of hormuz, iran oil, OPEC, opec+]

Agricultural (Palm):
  "Palm Oil (CPO)":            [CPO, crude palm oil, palm oil, MPOB, GAPKI, BMD palm, malaysia palm]
  "Coconut Oil / Palm Kernel Oil": [palm kernel oil, PKO, coconut oil, copra]
  "Shea Tree Nut":             [shea butter, shea nut, burkina faso shea]
  "Sugarcane / Olive Oil":     [squalane price, sugarcane squalane, olive squalene]

Animal-origin (ACTIVE pressure):
  "Bovine Hide / Bone":        [bovine gelatin, gelatin sapi, gelita, rousselot, PB leiner, hide price, cattle hide]

Chemical (China-sourced):
  "Zinc Ore (Mineral)":        [zinc oxide, ZnO, china zinc, zinc export]
  "Petroleum (3-Methylpyridine)": [niacinamide, niacin price, china niacinamide]
  "Ilmenite / Rutile Ore":     [titanium dioxide, TiO2, china TiO2 export]

Vitamins / Nutraceutical:
  "Vitamin D3 / Cholecalciferol": [vitamin D3, cholecalciferol, lanolin vitamin]
  "Vitamin Premix":            [vitamin premix, DSM vitamins, BASF vitamins]

Paper & Pulp:
  "Wood Pulp (NBSK/BHKP)":     [NBSK, BHKP, softwood pulp, hardwood pulp, pulp price]
  "Wood Pulp / Recycled Fibre (OCC)": [OCC, containerboard, corrugated price]

FX / Macro:
  IDR:                         [USD/IDR, rupiah, bank indonesia, BI rate]
  Fed / US:                    [fed rate, federal reserve, FOMC, US inflation, CPI]
  China:                       [china PMI, PBOC, yuan, RMB]

Freight:
  Container / ocean:           [baltic dry, BDI, shanghai containerized, SCFI, drewry, suez, red sea]
  Tariffs:                     [section 301, china tariff, US tariff, trade war]
```

Full seed script provided in `/supabase/seed_keywords.sql` in the repo.

---

## 6. Ingestion logic (working code)

`app/api/ingest/route.ts` — runs every 30 minutes via Vercel Cron.

```typescript
// app/api/ingest/route.ts
import Parser from 'rss-parser';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const parser = new Parser({ timeout: 15000 });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const maxDuration = 300; // 5 min (Vercel Pro) or 60 (Hobby)

export async function GET(req: Request) {
  // Verify cron secret so random internet can't hit this
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { data: feeds } = await supabase
    .from('feeds')
    .select('*')
    .eq('active', true);

  let totalInserted = 0;
  const errors: string[] = [];

  // Fetch all feeds in parallel (with concurrency cap)
  const results = await Promise.allSettled(
    feeds!.map(feed => ingestFeed(feed))
  );

  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      totalInserted += result.value;
    } else {
      errors.push(`${feeds![i].name}: ${result.reason}`);
      // mark feed with error
      await supabase
        .from('feeds')
        .update({ fetch_error: String(result.reason).slice(0, 500) })
        .eq('id', feeds![i].id);
    }
  }

  return Response.json({ totalInserted, errors, feedsProcessed: feeds!.length });
}

async function ingestFeed(feed: any): Promise<number> {
  const parsed = await parser.parseURL(feed.url);
  let inserted = 0;

  // Load keywords once per feed run
  const { data: keywords } = await supabase
    .from('keywords')
    .select('id, term, commodity_id, weight');

  for (const item of parsed.items) {
    const guid = item.guid || item.link || '';
    const contentHash = crypto
      .createHash('md5')
      .update((item.title || '') + (item.link || ''))
      .digest('hex');

    // Score it
    const { score, matches } = scoreArticle(
      item.title || '',
      item.contentSnippet || item.content || '',
      feed.priority_tier,
      item.pubDate,
      keywords!
    );

    // Insert article (ignore conflicts on (feed_id, guid))
    const { data: article, error } = await supabase
      .from('articles')
      .upsert({
        feed_id: feed.id,
        guid,
        title: item.title,
        link: item.link,
        summary: (item.contentSnippet || '').slice(0, 2000),
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        score,
        content_hash: contentHash,
      }, { onConflict: 'feed_id,guid', ignoreDuplicates: false })
      .select('id')
      .single();

    if (error || !article) continue;

    // Insert tags for every matched commodity
    if (matches.length > 0) {
      await supabase.from('article_tags').upsert(
        matches.map(m => ({
          article_id: article.id,
          commodity_id: m.commodity_id,
          match_location: m.location,
        })),
        { onConflict: 'article_id,commodity_id', ignoreDuplicates: true }
      );
    }

    inserted++;
  }

  await supabase
    .from('feeds')
    .update({ last_fetched_at: new Date().toISOString(), fetch_error: null })
    .eq('id', feed.id);

  return inserted;
}

function scoreArticle(
  title: string,
  summary: string,
  priorityTier: number,
  pubDate: string | undefined,
  keywords: any[]
) {
  const titleLower = title.toLowerCase();
  const summaryLower = summary.toLowerCase();
  let score = 0;
  const matches: { commodity_id: number; location: string; weight: number }[] = [];
  const seenCommodities = new Set<number>();

  for (const kw of keywords) {
    const term = kw.term.toLowerCase();
    const inTitle = titleLower.includes(term);
    const inSummary = summaryLower.includes(term);
    if (!inTitle && !inSummary) continue;

    // Dedupe per commodity — only first match per commodity adds to score
    if (!seenCommodities.has(kw.commodity_id)) {
      seenCommodities.add(kw.commodity_id);
      if (inTitle) score += 3 * kw.weight;
      else if (inSummary) score += 2 * kw.weight;
      matches.push({
        commodity_id: kw.commodity_id,
        location: inTitle && inSummary ? 'both' : (inTitle ? 'title' : 'summary'),
        weight: kw.weight,
      });
    }
  }

  // Multi-match bonus
  if (matches.length >= 2) score += 1;
  if (matches.length >= 4) score += 1;

  // Premium source bonus (Reuters, Bloomberg, FT)
  if (priorityTier === 1) score += 2;

  // Recency bonus (<6h)
  if (pubDate) {
    const hours = (Date.now() - new Date(pubDate).getTime()) / 3600000;
    if (hours < 6) score += 1;
  }

  return { score: Math.min(score, 10), matches };
}
```

**`vercel.json`:**
```json
{
  "crons": [
    { "path": "/api/ingest", "schedule": "*/30 * * * *" },
    { "path": "/api/digest/generate", "schedule": "0 1 * * 1" }
  ]
}
```

---

## 7. Weekly digest endpoint (the bridge to Claude)

`app/api/digest/route.ts` — returns Claude-ready JSON that maps every signal to SKU impact.

```typescript
// app/api/digest/route.ts
export async function GET() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  // Get top-scored articles with their commodity tags
  const { data: articles } = await supabase
    .from('articles')
    .select(`
      id, title, link, summary, published_at, score,
      feeds(name, priority_tier),
      article_tags(
        commodities(
          id, name, category, standing_floor,
          material_commodities(
            materials(
              id, description, tier,
              suppliers(name),
              sku_materials(skus(name))
            )
          )
        )
      )
    `)
    .gte('published_at', sevenDaysAgo)
    .gte('score', 4)
    .order('score', { ascending: false })
    .limit(200);

  // Pivot into Signal → Commodity → Material → SKU → Supplier structure
  const pivoted = pivotByCommodity(articles);

  return Response.json({
    generated_at: new Date().toISOString(),
    week_starting: getMondayOf(new Date()).toISOString().slice(0, 10),
    commodity_signals: pivoted,
  });
}
```

**Output shape (what Claude ingests on "Refresh Dashboard"):**
```json
{
  "generated_at": "2026-04-18T03:00:00Z",
  "week_starting": "2026-04-13",
  "commodity_signals": [
    {
      "commodity": "Palm Oil (CPO)",
      "category": "Agricultural",
      "standing_floor": "Stable",
      "signal_count": 12,
      "top_score": 9,
      "headlines": [
        {
          "title": "MPOB April stocks fall 6% on weather disruption",
          "source": "Reuters",
          "published_at": "2026-04-17T02:00:00Z",
          "score": 9,
          "link": "https://..."
        }
      ],
      "affected_materials": [
        {
          "material": "Glycerin",
          "used_in": ["Filling - Daily PrOATect Cream 150gr", "..."],
          "supplier": "Nose Herbalindo, PT",
          "skus": ["Expert Care - Face & Body Lotion Cream Moisturizer 150 gr", "..."]
        }
      ]
    }
  ]
}
```

**How Claude uses this:** On "Refresh Dashboard", Claude hits `GET /api/digest` → gets the pivoted signals → applies the risk-level rules from the Procurement Early Warning Dashboard prompt → outputs the table. No web search needed for the bulk of rows; Claude only does targeted web search to resolve ambiguity on top-scored signals.

---

## 8. Public UI — page map

| Route | Purpose | Key elements |
|---|---|---|
| `/` | Live dashboard | Category sidebar · main feed cards · critical alerts strip · filters (score/time/category) |
| `/critical` | 🔴/⚫ signals only | High-score articles, grouped by commodity |
| `/commodity/[slug]` | Deep dive per commodity | Signal timeline · affected materials · affected SKUs · supplier exposure |
| `/sku/[slug]` | SKU risk view | All commodity signals affecting this SKU, grouped by material |
| `/supplier/[slug]` | Supplier exposure view | All signals affecting a given supplier's input materials |
| `/digest` | Weekly digest viewer | Human-readable version of `/api/digest` |
| `/api/digest` | Claude endpoint | JSON for the Procurement Dashboard refresh |
| `/admin` | Feed & keyword management | Add feeds, test feeds, manage keyword taxonomy (auth required) |

---

## 9. Deployment steps (single engineer, ~1 day)

```bash
# 1. Clone the repo
git clone https://github.com/<org>/ta-procurement-intel.git
cd ta-procurement-intel
npm install

# 2. Create a Supabase project (free tier)
#    https://supabase.com/dashboard → New Project → copy URL + anon key + service_role key

# 3. Run migrations
npx supabase link --project-ref <your-ref>
npx supabase db push

# 4. Seed taxonomy from TA's xlsx files
npm run seed:taxonomy  # reads TA_Commodity_Origin_Map.xlsx + Updated__Material_List.xlsx

# 5. Deploy to Vercel
vercel --prod

# 6. Set environment variables in Vercel:
#    NEXT_PUBLIC_SUPABASE_URL
#    NEXT_PUBLIC_SUPABASE_ANON_KEY
#    SUPABASE_SERVICE_ROLE_KEY
#    CRON_SECRET (random long string)

# 7. Verify cron:
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/ingest
```

---

## 10. GitHub repo structure

```
ta-procurement-intel/
├── README.md                    # Setup + architecture diagram + screenshots
├── LICENSE                      # MIT
├── .env.example
├── package.json
├── next.config.js
├── vercel.json                  # cron schedules
├── tailwind.config.ts
│
├── app/
│   ├── layout.tsx
│   ├── page.tsx                 # live dashboard
│   ├── critical/page.tsx
│   ├── commodity/[slug]/page.tsx
│   ├── sku/[slug]/page.tsx
│   ├── supplier/[slug]/page.tsx
│   ├── digest/page.tsx
│   ├── admin/page.tsx
│   └── api/
│       ├── ingest/route.ts      # RSS fetch + score
│       ├── digest/route.ts      # Claude-facing JSON
│       └── digest/generate/route.ts  # Monday 1am weekly snapshot
│
├── components/
│   ├── ArticleCard.tsx
│   ├── ScoreBadge.tsx
│   ├── CommodityFilter.tsx
│   ├── CriticalAlertStrip.tsx
│   └── SignalTimeline.tsx
│
├── lib/
│   ├── supabase.ts
│   ├── scoring.ts               # the score function — unit tested
│   └── pivot.ts                 # digest pivot logic
│
├── supabase/
│   ├── migrations/
│   │   └── 20260418_init.sql
│   └── seed/
│       ├── feeds.sql
│       ├── commodities.sql
│       ├── keywords.sql
│       └── import_ta_taxonomy.ts  # reads xlsx → populates materials/skus/suppliers
│
└── docs/
    ├── architecture.png
    ├── adding-feeds.md
    └── tuning-keywords.md
```

---

## 11. What to build in week 1 vs later

**Week 1 (MVP — deploy-ready):**
- Schema + Supabase setup
- RSS ingestion + scoring
- Public home dashboard
- `/api/digest` endpoint for Claude

**Week 2:**
- Commodity / SKU / Supplier deep-dive pages
- Admin panel
- Weekly digest UI

**Later:**
- Email alerts for 🔴/⚫ signals
- LLM-based semantic enrichment (optional — keyword matching gets 80% of value at 5% of cost)
- Historical price overlay charts (needs paid commodity data API — out of scope for free tier)

---

## 12. Known risks & honest answers

| Risk | Reality | Mitigation |
|---|---|---|
| Feed breakage | ~10% of feeds will break in Year 1 | Admin panel shows `fetch_error`, manual swap |
| Keyword noise | "propylene" matches unrelated chemistry news | Tune `weight` column, add negative keywords later |
| False positive scoring | Premium source + keyword match ≠ actionable signal | Claude is the final filter; platform surfaces, Claude decides |
| Supabase free tier limits | 500MB DB = ~300k articles at current shape | Set retention: delete articles >90 days old if score <4 |
| Vercel cron on Hobby tier | 60s timeout per invocation | Batch feeds: ingest in chunks of 5 per cron run, stagger |
| No login = anyone sees data | That's the feature (open access) | Admin panel is auth-gated; raw data is not sensitive |

---

## 13. Success criteria

Platform is working when:
1. ≥18 of 22 seed feeds are ingesting successfully (weekly check)
2. `/api/digest` returns ≥10 commodity signals in any given week
3. Claude can generate the full Procurement Dashboard from the digest + ≤3 targeted web searches (instead of 10+ today)
4. Signal-to-table time drops from ~45 min manual to <5 min
