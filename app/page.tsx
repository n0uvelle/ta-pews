import { createClient } from "@supabase/supabase-js";

export const revalidate = 300;
export const dynamic = "force-dynamic";

type Article = {
  id: number;
  title: string;
  link: string;
  summary: string | null;
  published_at: string | null;
  score: number;
  feeds: { name: string; priority_tier: number } | null;
  article_tags: {
    commodities: {
      id: number;
      name: string;
      category: string | null;
    } | null;
  }[];
};

async function getArticles(): Promise<Article[]> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const { data } = await supabase
    .from("articles")
    .select(
      `id, title, link, summary, published_at, score,
       feeds(name, priority_tier),
       article_tags(commodities(id, name, category))`
    )
    .gte("published_at", since)
    .gte("score", 3)
    .order("score", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(100);

  return (data as unknown as Article[]) ?? [];
}

async function getCategoryCounts() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await supabase
    .from("articles")
    .select(`id, article_tags(commodities(category))`)
    .gte("published_at", since)
    .gte("score", 3);

  const counts: Record<string, number> = {};
  (data ?? []).forEach((a: any) => {
    const cats = new Set<string>();
    (a.article_tags ?? []).forEach((t: any) => {
      if (t.commodities?.category) cats.add(t.commodities.category);
    });
    cats.forEach((c) => {
      counts[c] = (counts[c] ?? 0) + 1;
    });
  });
  return counts;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function scoreColor(score: number) {
  if (score >= 8) return "bg-red-50 text-red-800 border-red-200";
  if (score >= 6) return "bg-amber-50 text-amber-800 border-amber-200";
  if (score >= 4) return "bg-blue-50 text-blue-800 border-blue-200";
  return "bg-gray-50 text-gray-700 border-gray-200";
}

export default async function Home() {
  const [articles, catCounts] = await Promise.all([
    getArticles(),
    getCategoryCounts(),
  ]);

  const critical = articles.filter((a) => a.score >= 8);
  const total = articles.length;
  const categories = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

  return (
    <main className="min-h-screen bg-white text-gray-900">
      <header className="border-b border-gray-200 px-8 py-5">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div>
            <h1 className="text-lg font-medium">TA procurement intel</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Live supply chain &amp; commodity signals · {total} scored this week
            </p>
          </div>
          <div className="flex gap-2">
            <span className="text-xs font-medium px-3 py-1 rounded-md bg-red-50 text-red-800">
              {critical.length} critical
            </span>
            <span className="text-xs font-medium px-3 py-1 rounded-md bg-amber-50 text-amber-800">
              {articles.filter((a) => a.score >= 6 && a.score < 8).length} watch
            </span>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-8 py-6 grid grid-cols-[200px_1fr] gap-8">
        <aside>
          <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">
            Commodity category
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <div className="px-2.5 py-1.5 rounded-md bg-gray-100 flex justify-between">
              <span>All signals</span>
              <span className="text-gray-500">{total}</span>
            </div>
            {categories.map(([cat, count]) => (
              <div
                key={cat}
                className="px-2.5 py-1.5 text-gray-600 flex justify-between"
              >
                <span className="truncate">{cat}</span>
                <span>{count}</span>
              </div>
            ))}
          </div>
        </aside>

        <section>
          {critical.length > 0 && (
            <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-red-700 font-medium mb-1">
                Critical alert · score ≥ 8
              </div>
              <a
                href={critical[0].link}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[15px] font-medium text-gray-900 hover:underline leading-snug"
              >
                {critical[0].title}
              </a>
              <div className="text-xs text-gray-600 mt-1">
                {critical[0].feeds?.name} · {timeAgo(critical[0].published_at)}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {articles.map((a) => (
              <article
                key={a.id}
                className="rounded-xl border border-gray-200 bg-white px-4 py-3.5 hover:border-gray-300 transition"
              >
                <div className="flex justify-between gap-3 items-start">
                  <div className="flex-1 min-w-0">
                    <a
                      href={a.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[14px] font-medium text-gray-900 hover:underline leading-snug"
                    >
                      {a.title}
                    </a>
                    <div className="text-xs text-gray-500 mt-1">
                      {a.feeds?.name ?? "—"} · {timeAgo(a.published_at)}
                    </div>
                    <div className="flex gap-1.5 flex-wrap mt-2">
                      {Array.from(
                        new Set(
                          (a.article_tags ?? [])
                            .map((t) => t.commodities?.category)
                            .filter(Boolean) as string[]
                        )
                      )
                        .slice(0, 3)
                        .map((cat) => (
                          <span
                            key={cat}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-gray-100 text-gray-700"
                          >
                            {cat}
                          </span>
                        ))}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 w-8 h-8 rounded-full border flex items-center justify-center text-[13px] font-medium ${scoreColor(
                      a.score
                    )}`}
                  >
                    {a.score}
                  </span>
                </div>
              </article>
            ))}
            {articles.length === 0 && (
              <div className="text-sm text-gray-500 py-8 text-center">
                No scored signals in the last 7 days yet. Run the ingestion endpoint
                to populate.
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="border-t border-gray-200 mt-10 px-8 py-4 text-xs text-gray-500 text-center">
        Tentang Anak · procurement intelligence · data refreshes every 30 min
      </footer>
    </main>
  );
}
