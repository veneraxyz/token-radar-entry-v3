// Launch Radar's entry program, version 4 (Node 22, standard library only).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input
// <file|dir>), calibrates the market from the protocols whose token
// already trades — category-median ratios, the log-log size curve, and
// the backtest that scores both out of sample — scores every pre-token
// launch candidate with the blended model in lib/model.ts, nets each
// farm plan to the dollar in lib/farm.ts, writes the ranked board to
// /output/board.json and the dashboard's data to /output/data.js, copies
// this repository's dashboard/ and screenshots/ to /output, and writes
// /output/dossier.json with the vendored make.fun library. The dashboard
// is a static page, no framework and no network.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNING, assembleRadar, calibrateMarket, payloadScript, readSnapshot, validateBoard } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier, the rest refuse. */
const TEXT_CAP = 65_536;
const SHOTS = { min: 3, max: 4, max_bytes: 524_288 };
const DASHBOARD = { max_files: 400, max_bytes: 4_194_304 };
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Stop with a message on stderr and exit code 1. */
function fail(message: string): never {
  process.stderr.write(`launch radar: ${message}\n`);
  process.exit(1);
}

/** --name <value> out of the arguments, or the fallback. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = readSnapshot(readFileSync(inputFile, 'utf8'));
const calibration = calibrateMarket(snapshot.protocols, TUNING);
const { board, payload } = assembleRadar(snapshot, calibration, TUNING);
const problem = validateBoard(board, snapshot);
if (problem !== null) fail(`the model wrote a board the gate refuses: ${problem}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), payloadScript(payload));

/** Copy one directory's regular files into `to`, skipping dot-names, and report what copied. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles.length < SHOTS.min || shotFiles.length > SHOTS.max) {
  fail(`screenshots/ holds ${shotFiles.length} image${shotFiles.length === 1 ? '' : 's'}: hand in 3 or 4 — the board, a detail view, a filtered view and the method`);
}
for (const name of shotFiles) {
  if (!SAFE_NAME.test(name)) {
    fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  }
  const bytes = statSync(join(outDir, 'screenshots', name)).size;
  if (bytes > SHOTS.max_bytes) {
    fail(`screenshots/${name} is ${bytes} bytes: the gate refuses any image over ${SHOTS.max_bytes}`);
  }
}

// The gate wants a page, a stylesheet and a script — refuse here, loudly,
// rather than handing in a dashboard the gate rejects.
const hasPage = dashFiles.includes('index.html');
const hasStyle = dashFiles.some((n) => n.endsWith('.css'));
const hasScript = dashFiles.some((n) => n.endsWith('.js'));
if (!hasPage || !hasStyle || !hasScript) {
  fail(`dashboard/ holds ${dashFiles.join(', ') || 'nothing'}: the gate wants index.html plus at least one .css and one .js`);
}

// The dossier carries at most TEXT_CAP bytes of source text: past that the
// judge sees a truncated page, so say so loudly instead of handing in a
// cut-down dossier without noticing.
let dashBytes = 0;
for (const name of dashFiles) dashBytes += statSync(join(outDir, 'dashboard', name)).size;
if (dashBytes > TEXT_CAP) {
  fail(`dashboard source is ${dashBytes} bytes, past the ${TEXT_CAP}-byte dossier text cap: the judge would see a truncated page`);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: TEXT_CAP, screenshots: SHOTS, dashboard: DASHBOARD }));
const dossierBytes = statSync(join(outDir, 'dossier.json')).size;
if (dossierBytes > 1_572_864) {
  fail(`dossier.json is ${dossierBytes} bytes, past the 1.5 MiB cap: shrink the screenshots or the dashboard`);
}

const bt = payload.backtest;
process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${payload.early_size} early, ${payload.live_size} live set aside)\n` +
    `launch radar: global mcap/TVL ${payload.global_ratio}, size curve slope ${payload.global_curve.slope.toFixed(3)} on ${payload.global_curve.n} live protocols\n` +
    `launch radar: backtest LOO (n=${bt.loo_n}) blend OOS x${bt.loo.blend.oos_factor} (${bt.loo.blend.median_abs_pct}% median error), winner ${bt.winner}; time-split (train ${bt.split_train_n}, test ${bt.split_test_n}) blend OOS x${bt.time_split.blend.oos_factor}\n` +
    `launch radar: farm verdicts FARM ${payload.verdict_counts.FARM}, MARGINAL ${payload.verdict_counts.MARGINAL}, SKIP ${payload.verdict_counts.SKIP}\n` +
    `launch radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashFiles.length} files), ${join(outDir, 'screenshots')} (${shotFiles.length} images) and ${join(outDir, 'dossier.json')} (${dossierBytes} bytes)\n`,
);
