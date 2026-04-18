import Parser from "rss-parser";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; TA-Procurement-Intel/1.0; +https://ta-pews.vercel.app)",
  },
});

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: feeds, error: feedsErr } = await supabase
    .from("feeds")
    .select("*")
    .eq("active", true);

  if (feedsErr || !feeds) {
    return Response.json({ error: feedsErr?.message ?? "no feeds" }, { status: 500 });
  }

  const { data: keywords } = await supabase
    .from("keywords")
    .select("id, term, commodity_id, weight");

  if (!keywords) {
    return Response.json({ error: "no keywords" }, { status: 500 });
  }

  let totalInserted = 0;
  const errors: string[] = [];

  const results = await Promise.allSettled(
    feeds.map((feed: any) => ingestFeed(feed, keywords, supabase))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      totalInserted += r.value;
    } else {
      errors.push(`${feeds[i].name}: ${r.reason}`);
      await supabase
        .from("feeds")
        .update({ fetch_error: String(r.reason).slice(0, 500) })
        .eq("id", feeds[i].id);
    }
  }

  return Response.json({
    totalInserted,
    feedsProcessed: feeds.length,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
}

async function ingestFeed(feed: any, keywords: any[], supabase: any): Promise<number> {
  const parsed = await parser.parseURL(feed.url);
  let inserted = 0;

  for (const item of parsed.items) {
    const guid = item.guid || item.link || "";
    if (!guid) continue;

    const contentHash = crypto
      .createHash("md5")
      .update((item.title || "") + (item.link || ""))
      .digest("hex");

    const { score, matches } = scoreArticle(
      item.title || "",
      item.contentSnippet || item.content || "",
      feed.priority_tier,
      item.pubDate,
      keywords
    );

    const { data: article, error } = await supabase
      .from("articles")
      .upsert(
        {
          feed_id: feed.id,
          guid,
          title: item.title || "(untitled)",
          link: item.link || "",
          summary: (item.contentSnippet || "").slice(0, 2000),
          published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          score,
          content_hash: contentHash,
        },
        { onConflict: "feed_id,guid" }
      )
      .select("id")
      .single();

    if (error || !article) continue;

    if (matches.length > 0) {
      await supabase.from("article_tags").upsert(
        matches.map((m) => ({
          article_id: article.id,
          commodity_id: m.commodity_id,
          match_location: m.location,
        })),
        { onConflict: "article_id,commodity_id", ignoreDuplicates: true }
      );
    }

    inserted++;
  }

  await supabase
    .from("feeds")
    .update({ last_fetched_at: new Date().toISOString(), fetch_error: null })
    .eq("id", feed.id);

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

    if (!seenCommodities.has(kw.commodity_id)) {
      seenCommodities.add(kw.commodity_id);
      if (inTitle) score += 3 * kw.weight;
      else if (inSummary) score += 2 * kw.weight;
      matches.push({
        commodity_id: kw.commodity_id,
        location: inTitle && inSummary ? "both" : inTitle ? "title" : "summary",
        weight: kw.weight,
      });
    }
  }

  if (matches.length >= 2) score += 1;
  if (matches.length >= 4) score += 1;
  if (priorityTier === 1) score += 2;

  if (pubDate) {
    const hours = (Date.now() - new Date(pubDate).getTime()) / 3600000;
    if (hours < 6) score += 1;
  }

  return { score: Math.min(score, 10), matches };
}
