# Market intelligence (Phase N4, first vertical slice)

Status: implemented and tested locally; **off by default** (`MARKET_INTELLIGENCE_ENABLED=false`: the endpoints answer 404). It uses **no data provider, no scraping, no AI model and no external call**: every figure is entered by a person from a source they name. A figure nobody supplied stays **UNKNOWN**; the module never estimates demand, sales volumes, prices or supplier ratings.

## What exists
1. **Import** a researched product from a record you supply (`POST /market/products`): name, market (country), category, supplier, **source URL** (stored and shown, never fetched), source description, the **date the figures were observed** (not the import date), costs and prices with their currencies, delivery estimate, and optional evidence (supplier rating, monthly searches, competitor count). Each piece of evidence **must name its source**, otherwise the import is refused.
2. **Duplicates:** the same words in any order, case and accents for the same market and supplier → 409 `DUPLICATE_PRODUCT` (with `existingId`); the same source page (tracking parameters, case and trailing slashes ignored) → 409 `DUPLICATE_SOURCE_URL`; a similar name in the same market (word-set similarity ≥ 0.75) is **reported** in `possibleDuplicates`, not blocked.
3. **Freshness** of each record: `FRESH` ≤ 7 days, `RECENT` ≤ 30, `STALE` ≤ 90, `OUTDATED` beyond, measured from the observation date; filterable.
4. **Analysis** (`POST /market/products/:id/analyses`): profitability and a transparent score from the assumptions you give; every run is kept as research history with the assumptions used (`GET /market/products/:id/analyses`).
5. **Dashboard** `/dashboard/market` (EN/FR): add a product, set assumptions, filter (market, category, freshness, name), compare in a table (margin, maximum advertising cost, score, source), open the details (provenance, unit economics line by line, how the score is built, history) and export the list as CSV.

Permissions: reading needs `analytics.read` (every member); importing and analyzing need `catalog.write` (editors and above). Tenant limits: `MARKET_MAX_PRODUCTS_PER_BUSINESS` (200), `MARKET_MAX_ANALYSES_PER_DAY` (100 per rolling 24 h), a creation rate limit; all queries are scoped by business.

## Profitability (per unit, in the selling currency)
Each line is rounded to 2 decimals (half up) **before** it is added, so the lines shown always add up to the totals.

| Line | Formula | Needs |
|---|---|---|
| Revenue | selling price | selling price |
| Acquisition cost | unit cost × rate (if the cost currency differs) | unit cost, and an exchange rate when currencies differ |
| Shipping cost | shipping × rate | shipping per unit |
| Payment fees | revenue × fee % ÷ 100 + fixed fee | fee %, fixed fee (enter 0 if none) |
| Returns allowance | revenue × returns % ÷ 100 | returns % |
| **Contribution before ads** | revenue − acquisition − shipping − fees − returns | all five lines |
| Advertising cost | cost per acquisition | supplied value |
| **Contribution after ads** | before ads − advertising | the above |
| **Margin %** | contribution after ads ÷ revenue × 100 | the above, revenue > 0 |
| **Break-even advertising cost** | = contribution before ads (can be negative) | before-ads figures |

Exchange rates are supplied by you: `rates[CUR]` = units of the selling currency per 1 unit of `CUR`, with a named source and a date; the rates actually used are stored with the result. A missing rate makes the converted lines UNKNOWN. A total is UNKNOWN when any line it needs is UNKNOWN, and each UNKNOWN says what is missing.

## Opportunity score (model version 1, 0-100)
| Component | Weight | Points (0-100) from | Evidence required |
|---|---|---|---|
| Demand | 25 | monthly searches: < 100 → 10; < 1,000 → 30; < 10,000 → 55; < 100,000 → 80; else 100 | figure + named source |
| Margin | 25 | margin % after ads ÷ 40 × 100 (≥ 40% = 100, ≤ 0 = 0) | margin computable |
| Competition | 15 | competitors: ≤ 4 → 90; ≤ 14 → 70; ≤ 39 → 45; ≤ 99 → 25; else 10 | count + named source |
| Supplier reliability | 15 | rating ÷ 5 × 100 | rating + named source |
| Shipping feasibility | 10 | delivery days: ≤ 7 → 100; ≤ 14 → 75; ≤ 21 → 50; ≤ 30 → 25; else 5 | delivery estimate |
| Data quality and freshness | 10 | 50% completeness (known evidence fields ÷ 7) + 50% freshness (FRESH 100, RECENT 70, STALE 40, OUTDATED 10) | always computable |

- Score = Σ(points × weight) ÷ Σ(weights of the **known** components), rounded half up. An UNKNOWN component is **left out, never counted as zero**.
- **Coverage** = the share of the 100 weight points that rest on known evidence. Below **50** the score is **not shown** (`score: null`, verdict `INSUFFICIENT_EVIDENCE`). Confidence: `HIGH` ≥ 85, `MEDIUM` ≥ 60, else `LOW`.
- Verdict: `PROMISING` ≥ 70, `MIXED` ≥ 40, `WEAK` below. Flags: `NEGATIVE_MARGIN`, `STALE_DATA`.
- Reproducible: the result depends only on the stored record, the assumptions and `asOf` (stored); the same inputs give the same output (tested). Every component returns the evidence it used.
- The bands and the weights are **TOUMA's documented starting model, not calibrated on market outcomes**: they will change as real evidence is collected, which bumps `modelVersion`.

## Data model
`MarketProduct` (the researched record with provenance: `sourceType` MANUAL, `sourceUrl`, `sourceName`, `observedAt`, normalised name and duplicate keys) and `MarketAnalysis` (assumptions, profitability, score, quality, `asOf`, `modelVersion`). Migration `20261119090000_market_intelligence`: two new tables, nothing dropped.

## Not in this slice (and what each would need)
- **Competitor price tracking, promotions, price-change detection, historical price series, trend charts:** need a permitted data source (a merchant-authorised export, a partner API under its terms, or manual observations as a new record type). No scraping and no access-restriction bypass will be added.
- **Supplier and product discovery pipelines, category/country research:** need a licensed catalogue or an API; the module currently only imports what a person supplies.
- **Scheduled analyses, report generation, queue processing:** can be built on the N3 workflow engine once a data source exists (an adapter that re-analyzes with stored assumptions).
- **Demand evidence beyond a typed figure** (search trends, marketplace sales ranks): needs a provider with clear terms.
- **Live exchange rates:** none; rates are entered with a source and date.
- A paid-ads cost per acquisition, payment fees and return rates are **assumptions you provide**; TOUMA suggests nothing except example values for the fee fields in the form.

## Tests
`market-calc.spec.ts` (19 unit tests with fixtures: normalisation, duplicate keys, URL normalisation, freshness boundaries, exact profitability figures with currency conversion and rounding, missing data, score bands, reproducibility, coverage threshold), `market.guard.spec.ts` (feature flag) and `apps/api/test/market.e2e-spec.ts` (15 tests with real PostgreSQL: RBAC, tenant isolation, provenance, validation, duplicates including concurrent imports, profitability and score, UNKNOWN handling, history, freshness filters, quotas).
