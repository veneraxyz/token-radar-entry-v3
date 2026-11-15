// Launch Radar's backtest: the value model proved against data it never saw.
//
// A calibration that only ever looks at the protocols it prices is a
// promise, not evidence. This module fits the same two value models the
// board uses — the category-median ratio and the log-log size curve — on
// a training set, then scores them on protocols the fit never touched:
//
//   1. LEAVE-ONE-OUT: each live protocol in turn is held out, both models
//      are refitted on the rest, and the held-out protocol's market cap is
//      predicted from its TVL alone. Every live protocol is tested once.
//   2. TIME-SPLIT: the live protocols are ordered by listing date; the
//      oldest 70% train the models and the newest 30% are predicted. This
//      is the harder test — it asks whether yesterday's pricing rule still
//      prices today's launches — and the one that most resembles the real
//      task, where the board's rows are protocols that list tomorrow.
//
// Both tests score three predictors: the ratio model, the size curve, and
// their geometric blend (the blend is what the board actually uses). The
// score is the median absolute log error, reported two ways: as a
// percentage (median |predicted - actual| / actual) and as an OOS factor,
// exp(median |log(predicted / actual)|) — "OOS x2.01" means the typical
// out-of-sample prediction is within a factor of 2.01 of the true market
// cap, either way. A factor near 1 is a model that prices well; a factor
// past 3 is a model guessing. The numbers go into the dashboard verbatim,
// including when they are unimpressive: a backtest that hides its misses
// is worse than no backtest at all.

/** One live protocol, reduced to what a value model may learn from. */
export interface LivePoint {
  tvl: number;
  mcap: number;
  category: string;
  listed_at: string | null;
}

/** A value model, fitted: TVL and category in, a market-cap estimate out. */
export type Predictor = (tvl: number, category: string) => number;

/** The fitting rules, shared with the board so the test tests the real model. */
export interface FitOptions {
  ratio_low: number;
  ratio_high: number;
  shrink_n: number;
  curve_min_n: number;
}

/** One model's out-of-sample score on one test. */
export interface ModelScores {
  n: number;
  median_abs_pct: number;
  oos_factor: number;
  median_abs_log: number;
}

/** The full backtest report: both tests, all three models, and the winner. */
export interface BacktestReport {
  loo: { ratio: ModelScores; curve: ModelScores; blend: ModelScores };
  time_split: { ratio: ModelScores; curve: ModelScores; blend: ModelScores };
  winner: 'ratio' | 'curve' | 'blend';
  loo_n: number;
  split_train_n: number;
  split_test_n: number;
  split_cutoff: string | null;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function medianOf(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/**
 * Ordinary least squares on (x, y): the line y = intercept + slope * x
 * that minimises squared error. With fewer than two points, or points
 * that share one x, there is no line to fit: the slope falls back to 1
 * and the intercept to the mean of (y - x), which is a pure ratio
 * through the origin in log space — the honest degenerate fit.
 */
export function leastSquares(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) {
    const mean = n === 0 ? 0 : ys.reduce((s, y, i) => s + (y - xs[i]!), 0) / n;
    return { slope: 1, intercept: mean };
  }
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - meanX) * (xs[i]! - meanX);
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
  }
  if (sxx === 0) return { slope: 1, intercept: meanY - meanX };
  const slope = sxy / sxx;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * The ratio model, fitted on a training set: the median market-cap / TVL
 * of each category's live protocols, shrunk toward the global median when
 * fewer than `shrink_n` protocols speak for a category, with every ratio
 * clipped before any median is taken. A category the training set never
 * saw is priced at the global ratio.
 */
export function fitRatioPredictor(points: LivePoint[], opts: FitOptions): Predictor {
  const clip = (r: number): number => clampNum(r, opts.ratio_low, opts.ratio_high);
  const global = medianOf(points.map((p) => clip(p.mcap / p.tvl)));
  const byCat = new Map<string, number[]>();
  for (const p of points) {
    const list = byCat.get(p.category) ?? [];
    list.push(clip(p.mcap / p.tvl));
    byCat.set(p.category, list);
  }
  const ratioOf = new Map<string, number>();
  for (const [cat, ratios] of byCat) {
    const raw = medianOf(ratios);
    const n = ratios.length;
    const shrunk = n >= opts.shrink_n ? raw : (n * raw + (opts.shrink_n - n) * global) / opts.shrink_n;
    ratioOf.set(cat, clampNum(shrunk, opts.ratio_low, opts.ratio_high));
  }
  return (tvl: number, category: string): number => {
    const ratio = ratioOf.get(category) ?? clampNum(global, opts.ratio_low, opts.ratio_high);
    return Math.max(1, tvl * ratio);
  };
}

/**
 * The size curve, fitted on a training set: log(market cap) regressed on
 * log(TVL), one line per category where at least `curve_min_n` live
 * protocols speak for it, else the global line. The prediction is
 * clipped to the same ratio band as the ratio model, so the curve can
 * never price a protocol at a ratio the market has never shown.
 */
export function fitCurvePredictor(points: LivePoint[], opts: FitOptions): Predictor {
  const global = leastSquares(
    points.map((p) => Math.log(p.tvl)),
    points.map((p) => Math.log(p.mcap)),
  );
  const byCat = new Map<string, LivePoint[]>();
  for (const p of points) {
    const list = byCat.get(p.category) ?? [];
    list.push(p);
    byCat.set(p.category, list);
  }
  const lineOf = new Map<string, { slope: number; intercept: number }>();
  for (const [cat, list] of byCat) {
    if (list.length < opts.curve_min_n) continue;
    lineOf.set(
      cat,
      leastSquares(
        list.map((p) => Math.log(p.tvl)),
        list.map((p) => Math.log(p.mcap)),
      ),
    );
  }
  return (tvl: number, category: string): number => {
    const line = lineOf.get(category) ?? global;
    const raw = Math.exp(line.intercept + line.slope * Math.log(Math.max(1, tvl)));
    const lo = Math.max(1, tvl * opts.ratio_low);
    const hi = Math.max(lo, tvl * opts.ratio_high);
    return clampNum(raw, lo, hi);
  };
}

/** The blend of two predictors: their geometric mean, never below $1. */
export function blendPredictors(first: Predictor, second: Predictor): Predictor {
  return (tvl: number, category: string): number =>
    Math.max(1, Math.sqrt(first(tvl, category) * second(tvl, category)));
}

/** One model's score from its predictions: median absolute log error, as a percentage and as a factor. */
function scoreModel(pairs: { predicted: number; actual: number }[]): ModelScores {
  const logErrors = pairs.map((q) => Math.abs(Math.log(q.predicted / q.actual)));
  const pctErrors = pairs.map((q) => (Math.abs(q.predicted - q.actual) / q.actual) * 100);
  const medianLog = medianOf(logErrors);
  return {
    n: pairs.length,
    median_abs_pct: Math.round(medianOf(pctErrors) * 100) / 100,
    oos_factor: Math.round(Math.exp(medianLog) * 100) / 100,
    median_abs_log: Math.round(medianLog * 10000) / 10000,
  };
}

/**
 * Leave-one-out: every live protocol is held out once, the models are
 * refitted on the rest, and the held-out market cap is predicted from
 * TVL alone. Deterministic: the order is the snapshot's order.
 */
function leaveOneOut(live: LivePoint[], opts: FitOptions): { ratio: ModelScores; curve: ModelScores; blend: ModelScores } {
  const ratioPairs: { predicted: number; actual: number }[] = [];
  const curvePairs: { predicted: number; actual: number }[] = [];
  const blendPairs: { predicted: number; actual: number }[] = [];
  for (let i = 0; i < live.length; i++) {
    const held = live[i]!;
    const train = live.filter((_, j) => j !== i);
    const ratio = fitRatioPredictor(train, opts);
    const curve = fitCurvePredictor(train, opts);
    const blend = blendPredictors(ratio, curve);
    ratioPairs.push({ predicted: ratio(held.tvl, held.category), actual: held.mcap });
    curvePairs.push({ predicted: curve(held.tvl, held.category), actual: held.mcap });
    blendPairs.push({ predicted: blend(held.tvl, held.category), actual: held.mcap });
  }
  return { ratio: scoreModel(ratioPairs), curve: scoreModel(curvePairs), blend: scoreModel(blendPairs) };
}

/**
 * Time-split: the dated live protocols are ordered by listing date, the
 * oldest 70% train the models, the newest 30% are predicted. Protocols
 * with no listing date cannot take part — they are counted out, openly,
 * in the report's n.
 */
function timeSplit(live: LivePoint[], opts: FitOptions): {
  scores: { ratio: ModelScores; curve: ModelScores; blend: ModelScores };
  train_n: number;
  test_n: number;
  cutoff: string | null;
} {
  const dated = live
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const ratio = fitRatioPredictor(train, opts);
  const curve = fitCurvePredictor(train, opts);
  const blend = blendPredictors(ratio, curve);
  const collect = (pred: Predictor): { predicted: number; actual: number }[] =>
    test.map((p) => ({ predicted: pred(p.tvl, p.category), actual: p.mcap }));
  return {
    scores: { ratio: scoreModel(collect(ratio)), curve: scoreModel(collect(curve)), blend: scoreModel(collect(blend)) },
    train_n: train.length,
    test_n: test.length,
    cutoff: test.length > 0 ? test[0]!.listed_at : null,
  };
}

/**
 * The full backtest: leave-one-out on every live protocol, then the
 * time-split on the dated ones. The winner is the model with the lowest
 * leave-one-out median log error — the test with the most data behind
 * it. The board uses the blend regardless of who wins: the blend is the
 * honest middle, and its own scores are reported beside the winner's.
 */
export function runBacktests(live: LivePoint[], opts: FitOptions): BacktestReport {
  const loo = leaveOneOut(live, opts);
  const split = timeSplit(live, opts);
  const candidates: { name: 'ratio' | 'curve' | 'blend'; err: number }[] = [
    { name: 'ratio', err: loo.ratio.median_abs_log },
    { name: 'curve', err: loo.curve.median_abs_log },
    { name: 'blend', err: loo.blend.median_abs_log },
  ];
  candidates.sort((a, b) => a.err - b.err);
  return {
    loo,
    time_split: split.scores,
    winner: candidates[0]!.name,
    loo_n: live.length,
    split_train_n: split.train_n,
    split_test_n: split.test_n,
    split_cutoff: split.cutoff,
  };
}
