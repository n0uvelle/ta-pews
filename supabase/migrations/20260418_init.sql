-- ============================================================================
-- TA Procurement Intelligence Platform — Initial schema
-- Run this in Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS feeds (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  priority_tier   INT NOT NULL DEFAULT 2,
  category        TEXT,
  active          BOOLEAN DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  fetch_error     TEXT,
  fetch_notes     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS skus (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS materials (
  id              BIGSERIAL PRIMARY KEY,
  description     TEXT NOT NULL UNIQUE,
  tier            TEXT,
  supplier_id     BIGINT REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS commodities (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  category        TEXT,
  source_category TEXT,
  standing_floor  TEXT DEFAULT 'Stable',
  typical_origin  TEXT
);

CREATE TABLE IF NOT EXISTS material_commodities (
  material_id     BIGINT REFERENCES materials(id) ON DELETE CASCADE,
  commodity_id    BIGINT REFERENCES commodities(id) ON DELETE CASCADE,
  PRIMARY KEY (material_id, commodity_id)
);

CREATE TABLE IF NOT EXISTS sku_materials (
  sku_id          BIGINT REFERENCES skus(id) ON DELETE CASCADE,
  material_id     BIGINT REFERENCES materials(id) ON DELETE CASCADE,
  PRIMARY KEY (sku_id, material_id)
);

CREATE TABLE IF NOT EXISTS keywords (
  id              BIGSERIAL PRIMARY KEY,
  term            TEXT NOT NULL,
  commodity_id    BIGINT REFERENCES commodities(id) ON DELETE CASCADE,
  weight          INT DEFAULT 1,
  UNIQUE(term, commodity_id)
);
CREATE INDEX IF NOT EXISTS idx_keywords_term_lower ON keywords(LOWER(term));

CREATE TABLE IF NOT EXISTS articles (
  id              BIGSERIAL PRIMARY KEY,
  feed_id         BIGINT REFERENCES feeds(id) ON DELETE CASCADE,
  guid            TEXT NOT NULL,
  title           TEXT NOT NULL,
  link            TEXT NOT NULL,
  summary         TEXT,
  author          TEXT,
  published_at    TIMESTAMPTZ,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  score           INT DEFAULT 0,
  content_hash    TEXT,
  UNIQUE(feed_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_score ON articles(score DESC);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id      BIGINT REFERENCES articles(id) ON DELETE CASCADE,
  commodity_id    BIGINT REFERENCES commodities(id) ON DELETE CASCADE,
  match_location  TEXT,
  PRIMARY KEY (article_id, commodity_id)
);

CREATE TABLE IF NOT EXISTS weekly_digests (
  id              BIGSERIAL PRIMARY KEY,
  week_starting   DATE NOT NULL UNIQUE,
  payload         JSONB NOT NULL,
  generated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Allow public read access to articles, feeds, commodities (no login needed)
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE commodities ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_commodities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read articles"     ON articles FOR SELECT USING (true);
CREATE POLICY "public read feeds"        ON feeds FOR SELECT USING (true);
CREATE POLICY "public read commodities"  ON commodities FOR SELECT USING (true);
CREATE POLICY "public read article_tags" ON article_tags FOR SELECT USING (true);
CREATE POLICY "public read materials"    ON materials FOR SELECT USING (true);
CREATE POLICY "public read skus"         ON skus FOR SELECT USING (true);
CREATE POLICY "public read suppliers"    ON suppliers FOR SELECT USING (true);
CREATE POLICY "public read m_c"          ON material_commodities FOR SELECT USING (true);
CREATE POLICY "public read s_m"          ON sku_materials FOR SELECT USING (true);
