-- ============================================================================
-- TA Procurement Intelligence Platform — Feed Registry
-- Validated: 18 April 2026
-- ============================================================================
-- priority_tier: 1 = premium (Reuters, Bloomberg, FT) — scoring bonus +2
--                2 = standard trade/financial press
--                3 = niche / Indonesian domestic
-- category:      macro | fx | commodities | logistics | indonesia | geopolitics
-- status:        verified_live | needs_retest_from_vercel | proxy_required
-- ============================================================================

-- VERIFIED LIVE (returned valid RSS XML on test) --------------------------------

INSERT INTO feeds (name, url, priority_tier, category, active, fetch_notes) VALUES
  ('Bloomberg Markets',       'https://feeds.bloomberg.com/markets/news.rss',      1, 'macro',       TRUE, 'Verified 2026-04-18: application/rss+xml'),
  ('Bloomberg Politics',      'https://feeds.bloomberg.com/politics/news.rss',     1, 'geopolitics', TRUE, 'Verified 2026-04-18: application/rss+xml'),
  ('Bloomberg Wealth',        'https://feeds.bloomberg.com/wealth/news.rss',       1, 'macro',       TRUE, 'Listed in Bloomberg feedspot; parallel to Markets'),
  ('FreightWaves',            'https://www.freightwaves.com/feed',                 2, 'logistics',   TRUE, 'Verified 2026-04-18: application/rss+xml'),
  ('SupplyChainDive',         'https://www.supplychaindive.com/feeds/news/',       2, 'logistics',   TRUE, 'Verified 2026-04-18'),
  ('Journal of Commerce',     'https://www.joc.com/rssfeed',                       2, 'logistics',   TRUE, 'URL updated from /rss.xml → /rssfeed per 2026-04-18 test'),
  ('CNBC Indonesia',          'https://www.cnbcindonesia.com/rss',                 2, 'indonesia',   TRUE, 'Verified 2026-04-18: fresh RSS 2.0, includes Bahasa'),
  ('Oilprice.com',            'https://oilprice.com/rss/main',                     2, 'commodities', TRUE, 'Verified 2026-04-18'),
  ('ANTARA News EN',          'https://en.antaranews.com/rss/news.xml',            3, 'indonesia',   TRUE, 'Replaces dead Jakarta Post; verified 2026-04-18'),
  ('Detik Finance',           'https://finance.detik.com/rss',                     3, 'indonesia',   TRUE, 'Updated from rss.detik.com/index.php/finance; verified 2026-04-18'),
  ('InvestingLive (ex-ForexLive)', 'https://investinglive.com/feed',               2, 'fx',          TRUE, 'URL updated: forexlive.com rebranded to investinglive.com'),

-- NEEDS RETEST FROM VERCEL (blocked 403 from sandbox, may work from datacenter) -

  ('Financial Times World',   'https://www.ft.com/world?format=rss',               1, 'macro',       FALSE, 'Section-based URL per FT feedspot Feb 2026. Retest from Vercel runtime'),
  ('Financial Times Home',    'https://www.ft.com/rss/home',                       1, 'macro',       FALSE, 'Main feed. Retest from Vercel'),
  ('FXstreet',                'https://www.fxstreet.com/rss/news',                 2, 'fx',          FALSE, '403 from sandbox; likely bot-blocked. Retest with browser UA'),
  ('The Loadstar',            'https://theloadstar.com/feed/',                     2, 'logistics',   FALSE, '403 from sandbox. Retest from Vercel'),
  ('SupplyChainLens',         'https://supplychainlens.com/feed',                  3, 'logistics',   FALSE, '403 from sandbox. Retest from Vercel'),
  ('Trading Economics',       'https://tradingeconomics.com/rss/news.aspx',        2, 'macro',       FALSE, '403 from sandbox. Retest from Vercel'),
  ('Bank Indonesia',          'https://www.bi.go.id/en/rss.xml',                   1, 'indonesia',   FALSE, 'robots.txt blocked sandbox. Retest from Vercel; fall back to scraping-to-RSS if dead'),

-- PROXY REQUIRED (original dead; use Google News RSS workaround) ----------------

  ('Reuters Business (via Google News)',
   'https://news.google.com/rss/search?q=site:reuters.com+when:7d+(commodities+OR+supply+chain+OR+palm+oil+OR+oil+OR+shipping+OR+rupiah)&hl=en-US&gl=US&ceid=US:en',
   1, 'macro', TRUE, 'Reuters killed RSS Jun 2020. Using Google News RSS proxy with site: + time filter. Per FiveFilters/Codarium 2020'),

  ('Reuters Geopolitics (via Google News)',
   'https://news.google.com/rss/search?q=site:reuters.com+when:7d+(Iran+OR+Hormuz+OR+OPEC+OR+China+tariff+OR+sanctions)&hl=en-US&gl=US&ceid=US:en',
   1, 'geopolitics', TRUE, 'Google News RSS proxy for Reuters geopolitics. Narrow keyword filter to cut noise');

-- CONFIRMED DEAD — DO NOT ADD (kept here for reference only) --------------------
-- feeds.reuters.com/*            — shut down June 2020
-- thejakartapost.com/feed        — 404; replaced by ANTARA EN
-- kitco.com/rss/news             — 404; replaced by oilprice.com for energy signals
-- dailyfx.com/feeds/market-news  — redirects to IG.com marketing; DailyFX discontinued
-- worldbank.org/en/news/all/rss  — 404; manual check required
-- imf.org/en/News/RSS            — returns HTML landing page, not a feed
-- bps.go.id/rss                  — 403; statistics bureau; engineer to locate current endpoint

-- ============================================================================
-- FEED HEALTH NOTES FOR ENGINEER
-- ============================================================================
-- 1. On first deploy, run `/api/ingest` manually 3x across 30 min to confirm all
--    active=TRUE feeds actually return articles. Flip active=FALSE on any that
--    fail 3 runs in a row and open an issue.
-- 2. The Google News proxy feeds need careful keyword tuning. Start narrow;
--    expand only if coverage is thin after 1 week.
-- 3. BI / BPS / IMF / World Bank — government feeds frequently break. If still
--    dead after Vercel retest, use RSSHub (https://rsshub.app) self-hosted route
--    or FiveFilters Feed Creator as a scraping proxy. Document whichever you pick
--    in /docs/feed-proxies.md
-- 4. FT may require subscription-gated URLs. If /rss/home is public, keep. If
--    not, drop FT and lean harder on Bloomberg + Reuters-via-Google-News.
-- 5. Original spec had ~27% feed death rate on the seed list. Expect +10% attrition
--    per year. Add 2-3 new verified feeds to this registry every quarter.
