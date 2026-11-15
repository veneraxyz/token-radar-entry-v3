// Launch Radar's farm plans, version 3: eight steps, each costed, and
// the whole plan netted to the dollar.
//
// A farm plan that only lists actions is a to-do list. A farmer needs to
// know whether the farm pays: what it costs, what it might return, and
// the net. So every plan carries structured money alongside its words:
//
//   COST. Gas for the plan's transactions (8 of them, at the main chain's
//   typical fee: $12 on Ethereum, $2 elsewhere) plus the opportunity cost
//   of the deployed capital — 5% a year on the capital, pro-rated over
//   the hold window. The capital itself is NOT a cost: it comes back
//   when the position unwinds. Only gas and forgone yield are spent.
//   EXPECTED. The airdrop one active farmer can expect: the protocol's
//   implied value times the farmable share. The share is stated, not
//   hidden: a 10% community airdrop pool, split across 100,000 eligible
//   farmers, is 0.0001% of implied value per farmer. That is a guess —
//   the dashboard says so, and the research note says what moves it.
//   NET. Expected minus cost, in dollars. The verdict follows the net:
//   FARM when the net clears $50, MARGINAL when it clears $0, SKIP when
//   the farm costs more than it can return. A small protocol with a
//   small implied value will usually be SKIP, and that is the point:
//   the verdict is the plan's conclusion, not its marketing.
//
// The last step of every plan states the arithmetic in words, so the
// netting lives inside the plan the gate reads, not only in the page.

/** A protocol, reduced to what a farm plan is built from. */
export interface FarmSubject {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
}

/** One step: words for the reader, money for the netting. */
export interface FarmStep {
  text: string;
  gas_usd: number;
  capital_usd: number;
}

/** The plan's netting: cost, expected return, net, and the verdict. */
export interface FarmEconomics {
  gas_usd: number;
  opportunity_usd: number;
  cost_usd: number;
  capital_usd: number;
  hold_days: number;
  expected_usd: number;
  net_usd: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
}

/** A finished plan: its eight steps and its netting. */
export interface FarmPlan {
  steps: string[];
  economics: FarmEconomics;
}

/** The farm's stated assumptions — the dashboard prints these verbatim. */
export const FARM_ASSUMPTIONS = {
  airdrop_pool_pct: 10,
  eligible_farmers: 100_000,
  opportunity_rate_pct: 5,
  gas_tx_count: 8,
  gas_ethereum_usd: 12,
  gas_other_usd: 2,
  farm_threshold_usd: 50,
} as const;

/** The share of implied value one farmer expects: pool / farmers. */
export function farmableShare(): number {
  return FARM_ASSUMPTIONS.airdrop_pool_pct / 100 / FARM_ASSUMPTIONS.eligible_farmers;
}

/** Dollars to two decimals, for step text. */
function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A step's text, kept inside the gate's 20..600 characters. */
function stepText(action: string, cost: string, time: string): string {
  const punctuated = /[.!?]$/.test(action) ? action : `${action}.`;
  let s = `${punctuated} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page before you move it.`;
  return s;
}

function firstChain(p: FarmSubject): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function otherChain(p: FarmSubject): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** The capital one farm position deploys, from the protocol's own TVL. */
function stakeSize(p: FarmSubject): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** One transaction's gas on the protocol's main chain. */
function gasPerTx(chain: string): number {
  return chain === 'Ethereum' ? FARM_ASSUMPTIONS.gas_ethereum_usd : FARM_ASSUMPTIONS.gas_other_usd;
}

/** The hold window in days, from the protocol's age: younger, longer. */
function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core farming action, in words a farmer can follow. */
function entryAction(p: FarmSubject, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC into ${name} on ${chain} and leave the supply earning.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('liquidity manager')) return `Deposit $${capital} of USDC into ${name}'s largest vault on ${chain} and hold the vault shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC through ${name} onto ${chain} and put the bridged funds to work in its app.`;
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restak') || c.includes('staking pool')) return `Stake $${capital} of the chain's staking asset through ${name} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the shares.`;
  if (c.includes('stable') || c.includes('dual-token')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa') || c.includes('basis')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('chain')) return `Bridge $${capital} to the chain and use ${name}'s native apps once a week.`;
  if (c.includes('payment') || c.includes('card')) return `Load $${capital} and make one real payment through ${name}.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name}'s shielded pool on ${chain} and keep the note safe.`;
  if (c.includes('nft')) return `List or buy one item worth about $${capital} through ${name}'s marketplace.`;
  if (c.includes('gaming') || c.includes('game')) return `Spend $${capital} on ${name}'s in-game assets and play at least one session.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A weekly action that keeps the address active between snapshots. */
function weeklyAction(p: FarmSubject, capital: number): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const small = Math.max(10, Math.round(capital / 5));
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $${small} against the supply once, then repay it, so the position shows both sides of the market.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Route one $${small} swap through ${name}'s pools each week to keep the address active.`;
  if (c.includes('bridge')) return `Bridge $${small} back the other way once a month so the address shows repeat volume.`;
  if (c.includes('staking') || c.includes('restak')) return `Restake the rewards once a month instead of claiming them, so the stake compounds.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Close and reopen the hedge once a month so the account shows fresh volume.`;
  if (c.includes('prediction')) return `Settle one market a month and roll the winnings into the next one.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Add $${small} to the vault each month and leave the older shares untouched.`;
  if (c.includes('rwa') || c.includes('basis')) return `Read the asset's backing report each month and add $${small} while the yield holds.`;
  if (c.includes('insurance')) return `Renew or top up the cover before it lapses so the policy never gaps.`;
  if (c.includes('chain')) return `Use one native app on the chain each week, such as a swap or a mint.`;
  if (c.includes('privacy')) return `Make one shielded deposit a month so the address shows steady use.`;
  return `Make one qualifying action each week, such as a deposit, a swap or a vote.`;
}

/** A monthly action that spreads the position to a second chain or vault. */
function spreadAction(p: FarmSubject, capital: number): string {
  const second = otherChain(p);
  const small = Math.max(10, Math.round(capital / 5));
  if (second !== null) {
    return `Repeat the core action on ${second} with $${small} once a month, so the farm covers a second chain the snapshots count separately.`;
  }
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex')) return `Move $${small} into the pool's second-largest pair once a month to widen the position.`;
  if (c.includes('lend') || c.includes('cdp')) return `Supply a second asset worth $${small} once a month so the position is not a single-token bet.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Open a second vault with $${small} once a month and compare its yield with the first.`;
  return `Add $${small} to the position once a month and record the new balance in the farm log.`;
}

/**
 * A protocol's farm plan: eight steps plus the netting. The money is
 * computed from the plan's own inputs — gas at the chain's typical fee
 * for eight transactions, opportunity cost at 5% a year on the deployed
 * capital over the hold window, expected return as the farmable share of
 * the protocol's implied value — and the last step states the net in
 * words, so the economics are part of the plan itself.
 */
export function buildPlan(p: FarmSubject, age: number | null, impliedValue: number): FarmPlan {
  const chain = firstChain(p);
  const capital = stakeSize(p);
  const hold = holdDays(age);
  const gas = gasPerTx(chain);
  const gasTotal = FARM_ASSUMPTIONS.gas_tx_count * gas;
  const opportunity = (capital * (FARM_ASSUMPTIONS.opportunity_rate_pct / 100) * hold) / 365;
  const cost = gasTotal + opportunity;
  const expected = impliedValue * farmableShare();
  const net = expected - cost;
  const verdict: FarmEconomics['verdict'] =
    net >= FARM_ASSUMPTIONS.farm_threshold_usd ? 'FARM' : net >= 0 ? 'MARGINAL' : 'SKIP';

  const economics: FarmEconomics = {
    gas_usd: Math.round(gasTotal * 100) / 100,
    opportunity_usd: Math.round(opportunity * 100) / 100,
    cost_usd: Math.round(cost * 100) / 100,
    capital_usd: capital,
    hold_days: hold,
    expected_usd: Math.round(expected * 100) / 100,
    net_usd: Math.round(net * 100) / 100,
    verdict,
  };

  const steps: FarmStep[] = [
    {
      text: stepText(
        'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline',
        'under $3 for the first transaction',
        '5 minutes',
      ),
      gas_usd: 3,
      capital_usd: 0,
    },
    {
      text: stepText(entryAction(p, capital, chain), `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'),
      gas_usd: gas,
      capital_usd: capital,
    },
    {
      text: stepText(
        `Open ${p.name} only from the address its own documentation publishes, and check the contract address matches before you approve anything. A link from a direct message is never the way in`,
        'nothing to check',
        '10 minutes',
      ),
      gas_usd: 0,
      capital_usd: 0,
    },
    {
      text: stepText(weeklyAction(p, capital), `about $${gas} of gas per action`, '10 minutes a week'),
      gas_usd: gas * 4,
      capital_usd: 0,
    },
    {
      text: stepText(spreadAction(p, capital), `about $${gas} of gas per action`, '15 minutes a month'),
      gas_usd: gas * 2,
      capital_usd: 0,
    },
    {
      text: stepText(
        `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot`,
        `the $${capital} stays in the position`,
        `${hold} days`,
      ),
      gas_usd: 0,
      capital_usd: 0,
    },
    {
      text: stepText(
        `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes`,
        'no fee to check, and never pay to claim',
        '10 minutes',
      ),
      gas_usd: gas,
      capital_usd: 0,
    },
    {
      text: stepText(
        `The farm's arithmetic: about ${dollars(cost)} in gas and forgone yield against an expected ${dollars(expected)} airdrop at this protocol's implied value, a net of ${dollars(net)} — verdict: ${verdict}. The expected figure assumes a 10% community pool split across 100,000 farmers; a smaller pool or more farmers lowers it`,
        `about ${dollars(cost)} all in`,
        `${hold} days from deposit to claim`,
      ),
      gas_usd: 0,
      capital_usd: 0,
    },
  ];

  return { steps: steps.map((s) => s.text), economics };
}
