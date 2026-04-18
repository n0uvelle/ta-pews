# Seed scripts — setup & run guide

## What each file does

| File | Purpose | Idempotent? |
|---|---|---|
| `supabase/migrations/20260418_init.sql` | Creates all tables (from Section 4 of spec) | Yes (IF NOT EXISTS) |
| `supabase/seed/feeds_verified.sql` | Populates the `feeds` table with 22 verified/validated feeds | Yes (ON CONFLICT DO NOTHING) |
| `supabase/seed/import_ta_taxonomy.ts` | Reads the two TA xlsx files, fills suppliers/skus/materials/commodities/keywords | Yes (upsert on natural keys) |

## Required dependencies

Add to `package.json`:

```json
{
  "scripts": {
    "seed:feeds": "psql $DATABASE_URL -f supabase/seed/feeds_verified.sql",
    "seed:taxonomy": "tsx supabase/seed/import_ta_taxonomy.ts"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "tsx": "^4.15.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

## Run order (first deploy)

```bash
# 1. Create Supabase project, copy URL + service_role key to .env.local
# 2. Apply schema
npx supabase db push

# 3. Seed feed registry
npm run seed:feeds

# 4. Drop the two xlsx files into ./data/
cp /path/to/Updated__Material_List.xlsx ./data/
cp /path/to/TA_Commodity_Origin_Map.xlsx ./data/

# 5. Seed taxonomy (reads xlsx → populates DB)
npm run seed:taxonomy
```

Expected console output from step 5:

```
━━━ TA Taxonomy Import ━━━
→ Loaded 94 material rows
✔ 19 suppliers, 50 skus, 52 materials
→ Loaded 238 commodity rows
✔ ~75 commodities, ~220 material↔commodity links (~18 orphaned — review in /admin)
✔ 7 macro aggregates seeded with keywords
✔ ~180 keyword↔commodity pairs seeded
━━━ Import complete ━━━
```

Orphaned rows come from minor label drift between the two xlsx files (e.g., `Filling - Daily PrOATect Cream 150gr` vs `Filling - Daily PrOATect Soothing & Calming Cream 150 gr`). The `/admin` panel should surface these for one-click remapping.

## Re-running after xlsx updates

The script is idempotent. When TA updates the xlsx files (new SKUs, new materials), just re-run step 5. Existing rows are updated in-place; new rows are added; nothing is deleted.

**Deletion is intentional not supported.** If a material is retired, flag it `active=FALSE` in the admin panel rather than removing it — historical articles tagged to it should still be queryable.

## Manual review after first run

Log into `/admin` and check:

1. **Orphaned commodity links** — materials in the Commodity Map that didn't find a matching material in the Material List. Fix the label in one file or the other, then re-run.
2. **Category assignments** — `deriveCategory()` is rule-based and catches ~90% correctly. Review commodities where `category = 'Other'` and reassign.
3. **Standing-floor flags** — confirm all petrochemicals, gelatin, zinc, TiO2, niacinamide are flagged `standing_floor = 'Monitor'`. Anything missed should be flipped.

These reviews are a 15-minute one-time task for the procurement lead (Zabina), not the engineer.
