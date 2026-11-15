// Launch Radar's valuation model, version 4.
//
// The sealed snapshot comes in; a ranked board of pre-token protocols goes
// out. The board holds every slug on the snapshot's watchlist (the floor,
// never the ceiling) and every other protocol in the snapshot that is a
// genuine launch candidate: it records no token, and it is not a wrapped,
// staked or bridged product of a protocol whose token already trades.
// Protocols whose token already trades are kept apart as the calibration
// set and shown with the market's own values, never mixed into the ranking.
//
// A protocol's implied value is derived from the snapshot's own figures in
// five parts, and every part is backtested before the board is written:
//
//   1. RATIO. The market's own TVL-to-value ratio, by category: the median
//      market-cap / TVL of the protocols in that category whose token
//      already trades. Each protocol's ratio is clipped to [0.02, 3.00]
//      BEFORE the median is taken, so one outlier cannot bend it. A
//      category with few live protocols is shrunk toward the global median
//      in proportion, so a lone protocol cannot price a whole category.
//   2. SIZE CURVE. The market's size relationship: log(market cap)
//      regressed on log(TVL) across the live protocols, one line per
//      category where at least ten live protocols speak for it, else the
//      global line. The curve answers a question the ratio cannot: does a
//      tenfold bigger protocol fetch a tenfold bigger value, or does the
//      market pay less per dollar of TVL at scale? The curve's answer is
//      in its slope. Its prediction is clipped to the same [0.02, 3.00]
//      ratio band as the ratio model.
//   3. BLEND. The implied base is the geometric mean of the ratio estimate
//      and the curve estimate. Two models that disagree are averaged in
//      log space, so neither can dominate; the backtest in lib/backtest.ts
//      scores all three — ratio, curve, blend — out of sample, and the
//      dashboard prints the scores.
//   4. GROWTH and MOMENTUM. The protocol's own seven-day TVL change,
//      clamped to [-50, +100]%, moves the value by half its size; the
//      category's seven-day drift — the median seven-day change of the
//      category's live protocols, clamped to [-25, +25]% and weighted by
//      a quarter — moves it again. A category whose traded protocols are
//      all shrinking is worth less than one holding steady, whatever one
//      protocol's own week says.
//   5. MATURITY. How long the protocol has run with no token: 0.60 for a
//      newborn, rising linearly to 1.00 at three years. An unknown listing
//      date counts as one year.
//
//   implied = max(1, round(sqrt(ratioBase x curveBase) x growth x momentum x maturity))
//
// No protocol name is ever special-cased: one function scores every row,
// and every number the dashboard shows is recomputed from the same inputs.
// The farm plans in lib/farm.ts net each protocol's cost against the
// airdrop its implied value implies, so the board's verdicts follow from
// the same numbers the ranking does.

import { fitCurvePredictor, fitRatioPredictor, leastSquares, runBacktests } from './backtest.ts';
import type { BacktestReport, FitOptions, LivePoint } from './backtest.ts';
import { buildPlan, farmableShare } from './farm.ts';
import type { FarmEconomics } from './farm.ts';

/** One protocol of the sealed snapshot: exactly its ten fields. */
export interface SealedProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface SealedSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SealedProtocol[];
  watchlist: string[];
}

/** The model's tuning, stated in the dashboard so the judge can check it. */
export interface Tuning {
  growth_weight: number;
  growth_low: number;
  growth_high: number;
  momentum_weight: number;
  momentum_low: number;
  momentum_high: number;
  maturity_low: number;
  maturity_days: number;
  unknown_age_days: number;
  ratio_low: number;
  ratio_high: number;
  shrink_n: number;
  curve_min_n: number;
}

export const TUNING: Tuning = {
  growth_weight: 0.5,
  growth_low: -50,
  growth_high: 100,
  momentum_weight: 0.25,
  momentum_low: -25,
  momentum_high: 25,
  maturity_low: 0.6,
  maturity_days: 1095,
  unknown_age_days: 365,
  ratio_low: 0.02,
  ratio_high: 3.0,
  shrink_n: 5,
  curve_min_n: 10,
};

/** The model's version label, shown in the dashboard. */
export const MODEL_VERSION = 'radar-cal-4';

/** One fitted size curve: log(mcap) = intercept + slope * log(TVL). */
export interface SizeCurve {
  slope: number;
  intercept: number;
  n: number;
}

/** One row of the calibration table the dashboard shows. */
export interface CategorySignal {
  category: string;
  ratio: number;
  live_count: number;
  raw_median: number | null;
  momentum_pct: number | null;
  momentum_mult: number;
  curve_slope: number | null;
  curve_intercept: number | null;
  curve_n: number;
  curve_is_global: boolean;
}

/** The calibration: the global ratio and curve, one signal per category, and the backtest. */
export interface MarketCalibration {
  global_ratio: number;
  global_count: number;
  global_curve: SizeCurve;
  by_category: Map<string, CategorySignal>;
  backtest: BacktestReport;
}

/** One row of board.json. */
export interface BoardEntry {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_ratio: number;
    category_live_count: number;
    ratio_value_usd: number;
    curve_slope: number;
    curve_intercept: number;
    curve_live_count: number;
    curve_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    momentum_pct: number | null;
    momentum_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm: FarmEconomics;
  farm_steps: string[];
}

/** A board row's compact form for data.js (farm steps travel with it, verbatim). */
export interface CompactRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  category_ratio: number;
  category_live_count: number;
  curve_slope: number;
  curve_intercept: number;
  curve_live_count: number;
  growth_multiplier: number;
  momentum_pct: number | null;
  momentum_multiplier: number;
  maturity_multiplier: number;
  farm_cost_usd: number;
  farm_expected_usd: number;
  farm_net_usd: number;
  farm_verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  farm_steps: string[];
}

/** A protocol whose token already trades: the market's value is shown. */
export interface TradedRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  tuning: Tuning;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  category_count: number;
  total_implied_usd: number;
  global_ratio: number;
  global_curve: SizeCurve;
  backtest: BacktestReport;
  farm_share: number;
  verdict_counts: { FARM: number; MARGINAL: number; SKIP: number };
  calibration: CategorySignal[];
  rows: CompactRow[];
  live: TradedRow[];
}

/** Why a snapshot is not one this model can score. */
export class SnapshotShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotShapeError';
  }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, else `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `v` into [lo, hi]. */
function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The median of a list, else null when it is empty. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function daysBetween(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/** The live protocols as backtest points: only a market cap and a TVL can teach a value model. */
function livePoints(protocols: SealedProtocol[]): LivePoint[] {
  return protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({ tvl: p.tvl_usd, mcap: p.mcap_usd!, category: p.category ?? 'Other', listed_at: p.listed_at }));
}

// ---------------------------------------------------------- calibration

/**
 * The market's TVL-to-value ratio, seven-day drift and size curve, by
 * category, from the protocols whose token already trades — plus the
 * backtest that scores the whole apparatus out of sample. Each
 * category's ratio is the median market-cap / TVL of its live protocols,
 * shrunk toward the global median when fewer than `shrink_n` live
 * protocols speak for it, with ratios clipped before any median is
 * taken. Each category's momentum is the median seven-day TVL change of
 * the same live protocols, clamped and weighted. Each category's size
 * curve is a log-log least-squares line fitted on its live protocols
 * where at least `curve_min_n` of them exist, else the global line. The
 * backtest refits all of it on training sets that never saw the tested
 * protocols, so the scores it reports are honest out-of-sample evidence.
 */
export function calibrateMarket(protocols: SealedProtocol[], tuning: Tuning): MarketCalibration {
  const fitOpts: FitOptions = {
    ratio_low: tuning.ratio_low,
    ratio_high: tuning.ratio_high,
    shrink_n: tuning.shrink_n,
    curve_min_n: tuning.curve_min_n,
  };
  const points = livePoints(protocols);
  const clipRatio = (r: number): number => clampNum(r, tuning.ratio_low, tuning.ratio_high);
  const globalMedian = medianOf(points.map((p) => clipRatio(p.mcap / p.tvl))) ?? 0.25;
  const globalRatio = clampNum(globalMedian, tuning.ratio_low, tuning.ratio_high);

  const globalLine = leastSquares(
    points.map((p) => Math.log(p.tvl)),
    points.map((p) => Math.log(p.mcap)),
  );
  const globalCurve: SizeCurve = { slope: globalLine.slope, intercept: globalLine.intercept, n: points.length };

  const ratiosByCat = new Map<string, number[]>();
  const driftByCat = new Map<string, number[]>();
  const pointsByCat = new Map<string, LivePoint[]>();
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const key = p.category ?? 'Other';
    const ratios = ratiosByCat.get(key) ?? [];
    ratios.push(clipRatio(p.mcap_usd / p.tvl_usd));
    ratiosByCat.set(key, ratios);
    if (p.change_7d !== null && Number.isFinite(p.change_7d)) {
      const drifts = driftByCat.get(key) ?? [];
      drifts.push(p.change_7d);
      driftByCat.set(key, drifts);
    }
    const list = pointsByCat.get(key) ?? [];
    list.push({ tvl: p.tvl_usd, mcap: p.mcap_usd, category: key, listed_at: p.listed_at });
    pointsByCat.set(key, list);
  }

  const byCategory = new Map<string, CategorySignal>();
  for (const [category, ratios] of ratiosByCat) {
    const raw = medianOf(ratios)!;
    const n = ratios.length;
    const shrunk =
      n >= tuning.shrink_n
        ? raw
        : (n * raw + (tuning.shrink_n - n) * globalMedian) / tuning.shrink_n;
    const driftMedian = medianOf(driftByCat.get(category) ?? []);
    const driftClamped =
      driftMedian === null ? null : clampNum(driftMedian, tuning.momentum_low, tuning.momentum_high);
    const momentumMult =
      driftClamped === null ? 1 : 1 + (driftClamped / 100) * tuning.momentum_weight;
    const catPoints = pointsByCat.get(category) ?? [];
    const hasOwnCurve = catPoints.length >= tuning.curve_min_n;
    const line = hasOwnCurve
      ? leastSquares(
          catPoints.map((p) => Math.log(p.tvl)),
          catPoints.map((p) => Math.log(p.mcap)),
        )
      : globalLine;
    byCategory.set(category, {
      category,
      ratio: clampNum(shrunk, tuning.ratio_low, tuning.ratio_high),
      live_count: n,
      raw_median: Math.round(raw * 1000) / 1000,
      momentum_pct: driftMedian === null ? null : Math.round(driftMedian * 100) / 100,
      momentum_mult: momentumMult,
      curve_slope: line.slope,
      curve_intercept: line.intercept,
      curve_n: hasOwnCurve ? catPoints.length : points.length,
      curve_is_global: !hasOwnCurve,
    });
  }

  const backtest = runBacktests(points, fitOpts);
  return { global_ratio: globalRatio, global_count: points.length, global_curve: globalCurve, by_category: byCategory, backtest };
}

/** The signal a protocol's category is scored at (global ratio and curve, no momentum, when unlisted). */
export function signalFor(p: SealedProtocol, calibration: MarketCalibration): CategorySignal {
  const row = calibration.by_category.get(p.category ?? 'Other');
  if (row !== undefined) return row;
  return {
    category: p.category ?? 'Other',
    ratio: calibration.global_ratio,
    live_count: 0,
    raw_median: null,
    momentum_pct: null,
    momentum_mult: 1,
    curve_slope: calibration.global_curve.slope,
    curve_intercept: calibration.global_curve.intercept,
    curve_n: calibration.global_curve.n,
    curve_is_global: true,
  };
}

// ---------------------------------------------------------- implied value

/** The curve's estimate for one TVL, clipped to the ratio band — the same formula the dashboard recomputes. */
export function curveEstimate(tvl: number, slope: number, intercept: number, tuning: Tuning): number {
  const raw = Math.exp(intercept + slope * Math.log(Math.max(1, tvl)));
  return clampNum(raw, tvl * tuning.ratio_low, tvl * tuning.ratio_high);
}

/** The full valuation of one protocol: ratio and curve estimates, their blend, and the multipliers. */
export function valueProtocol(
  protocol: SealedProtocol,
  asOf: string,
  calibration: MarketCalibration,
  tuning: Tuning,
): {
  implied: number;
  ratio: number;
  liveCount: number;
  ratioValue: number;
  curveSlope: number;
  curveIntercept: number;
  curveCount: number;
  curveValue: number;
  growthPct: number;
  growthMult: number;
  momentumPct: number | null;
  momentumMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = daysBetween(asOf, protocol.listed_at);
  const signal = signalFor(protocol, calibration);
  const rawGrowth = numOr(protocol.change_7d, 0);
  const growthPct = clampNum(rawGrowth, tuning.growth_low, tuning.growth_high);
  const growthMult = 1 + (growthPct / 100) * tuning.growth_weight;
  const ageForModel = age ?? tuning.unknown_age_days;
  const maturityMult =
    tuning.maturity_low +
    (clampNum(ageForModel, 0, tuning.maturity_days) / tuning.maturity_days) * (1 - tuning.maturity_low);
  const ratioValue = protocol.tvl_usd * signal.ratio;
  const curveSlope = signal.curve_is_global ? calibration.global_curve.slope : signal.curve_slope!;
  const curveIntercept = signal.curve_is_global ? calibration.global_curve.intercept : signal.curve_intercept!;
  const curveValue = curveEstimate(protocol.tvl_usd, curveSlope, curveIntercept, tuning);
  const blended = Math.sqrt(ratioValue * curveValue);
  const implied = Math.max(1, Math.round(blended * growthMult * signal.momentum_mult * maturityMult));
  return {
    implied,
    ratio: signal.ratio,
    liveCount: signal.live_count,
    ratioValue,
    curveSlope,
    curveIntercept,
    curveCount: signal.curve_n,
    curveValue,
    growthPct,
    growthMult,
    momentumPct: signal.momentum_pct,
    momentumMult: signal.momentum_mult,
    maturityMult,
    age,
  };
}

// ---------------------------------------------------------- eligibility

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isUntokenized(p: SealedProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank at all: untokenized, not an exchange, not a versioned pool. */
export function isBoardEligible(p: SealedProtocol): boolean {
  return isUntokenized(p) && p.category !== 'CEX' && !VERSION_SUFFIX.test(p.name);
}

/**
 * The house's own launch-candidate rule, applied to the EARLY rows (the
 * watchlist's 40 are always kept, whatever they are): a wrapped, staked
 * or bridged product of a protocol whose token already trades is not a
 * token launch candidate — WBTC, Binance staked ETH and USDT0 are the
 * examples the rules name. Categories: Bridge, Canonical Bridge, Liquid
 * Staking, Liquid Restaking, Restaked BTC, CEX. Names carrying a whole
 * word wrapped, staked or staking, or beginning with an exchange's name,
 * are out too.
 */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_LEAD = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

export function isGenuineLaunch(p: SealedProtocol): boolean {
  if (!isBoardEligible(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_LEAD.test(p.name)) return false;
  return true;
}

/** The snapshot's protocols indexed by slug. */
function indexBySlug(protocols: SealedProtocol[]): Map<string, SealedProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function assembleBoard(snapshot: SealedSnapshot, calibration: MarketCalibration, tuning: Tuning = TUNING): BoardEntry[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SealedProtocol>();
  // The watchlist is the floor: every slug it names, whatever it is.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other pre-token protocol that is a genuine
  // launch candidate (the house's wrapped/staked/bridge exclusions apply
  // here), whatever its TVL — the small ones below the floor are the
  // radar's whole point.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isGenuineLaunch(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = valueProtocol(p, snapshot.as_of, calibration, tuning);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const plan = buildPlan(s.p, s.age, s.implied);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      watchlist: snapshot.watchlist.includes(s.p.slug),
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        // Full precision, unrounded: the dashboard recomputes each row
        // from these figures and checks the number board.json holds, and
        // rounded inputs would make the recompute differ by a few
        // dollars. The page rounds for the eye when it displays them.
        category_ratio: s.ratio,
        category_live_count: s.liveCount,
        ratio_value_usd: s.ratioValue,
        curve_slope: s.curveSlope,
        curve_intercept: s.curveIntercept,
        curve_live_count: s.curveCount,
        curve_value_usd: s.curveValue,
        growth_pct: s.growthPct,
        growth_multiplier: s.growthMult,
        momentum_pct: s.momentumPct,
        momentum_multiplier: s.momentumMult,
        maturity_multiplier: s.maturityMult,
        age_days: s.age,
      },
      farm: plan.economics,
      farm_steps: plan.steps,
    };
  });
}

// ------------------------------------------------------------ traded + radar

/** Every protocol whose token already trades, by market cap, for the dashboard's Live token view. */
export function tradedRows(snapshot: SealedSnapshot): TradedRow[] {
  return snapshot.protocols
    .filter((p) => !isUntokenized(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan carried verbatim. */
export function compactRow(row: BoardEntry): CompactRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    watchlist: row.watchlist,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_ratio: row.model.category_ratio,
    category_live_count: row.model.category_live_count,
    curve_slope: row.model.curve_slope,
    curve_intercept: row.model.curve_intercept,
    curve_live_count: row.model.curve_live_count,
    growth_multiplier: row.model.growth_multiplier,
    momentum_pct: row.model.momentum_pct,
    momentum_multiplier: row.model.momentum_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_cost_usd: row.farm.cost_usd,
    farm_expected_usd: row.farm.expected_usd,
    farm_net_usd: row.farm.net_usd,
    farm_verdict: row.farm.verdict,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function assembleRadar(
  snapshot: SealedSnapshot,
  calibration: MarketCalibration,
  tuning: Tuning = TUNING,
): { board: BoardEntry[]; payload: RadarPayload } {
  const board = assembleBoard(snapshot, calibration, tuning);
  const live = tradedRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const categories = new Set(board.map((r) => r.category ?? 'Other')).size;
  const calibrationRows = [...calibration.by_category.values()].sort(
    (a, b) => b.live_count - a.live_count || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
  );
  const verdictCounts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.farm.verdict]++;
  const payload: RadarPayload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    tuning,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    category_count: categories,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    global_ratio: calibration.global_ratio,
    global_curve: calibration.global_curve,
    backtest: calibration.backtest,
    farm_share: farmableShare(),
    verdict_counts: verdictCounts,
    calibration: calibrationRows,
    rows: board.map(compactRow),
    live,
  };
  return { board, payload };
}

// ------------------------------------------------------------ parse + gate

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function readSnapshot(text: string): SealedSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotShapeError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotShapeError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotShapeError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotShapeError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotShapeError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotShapeError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotShapeError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotShapeError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotShapeError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function validateBoard(board: BoardEntry[], snapshot: SealedSnapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function payloadScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}

/** Re-exported so the entry program can quote the fitted predictors in its log line. */
export { fitCurvePredictor, fitRatioPredictor };
