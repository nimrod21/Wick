/**
 * Prompt builder (task 3.5): PURE function (botConfig, snapshot) →
 * {system, user}. No I/O, no clocks, no randomness — deterministic output
 * for a given input (golden-tested). Target < 2.5k tokens (chars/4
 * heuristic); candle history is truncated first when over (PLAN §8).
 */

// ── snapshot types (PLAN §8 step 2) — built by snapshot.ts / Phase 4 ────

export interface SnapshotCandle {
  ts: number; // UTC ms, candle open time
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SnapshotIndicator {
  name: string;
  value: number | null;
  vote: string | null; // 'bull'|'bear'|'neutral'|null
  weight: number | null; // learned trust (Phase 5); null → "n/a"
  hitRate: number | null; // 0..1, Laplace-smoothed; null → "n/a" (no samples)
  /** Samples behind hitRate. Omitted/null → shown as 0. */
  samples?: number | null;
  /**
   * Auto-disabled indicator (PLAN §11.2): it stays in `snapshot_json` so its
   * votes keep being recorded, but it is EXCLUDED from the prompt.
   */
  shadow?: boolean;
}

export interface SnapshotPastDecision {
  ts: number;
  action: string;
  symbol: string | null;
  sizePct: number | null;
  confidence: number | null;
  status: string; // 'executed'|'vetoed'|'llm_failed'
  /** 4h-horizon outcome (primary, PLAN §11); null = not evaluated yet. */
  fwdRet4hPct: number | null;
  score4h: number | null;
}

export interface Snapshot {
  symbol: string;
  ts: number; // snapshot build time, UTC ms
  candles1h: SnapshotCandle[]; // oldest-first, nominally 24
  indicators: SnapshotIndicator[]; // enabled indicators only
  funding: number | null; // fraction, e.g. 0.0001 = 0.01%
  fearGreed: number | null; // 0-100
  position: {
    qty: number;
    avgEntry: number;
    uPnlPct: number;
    stopPrice: number | null;
    tpPrice: number | null;
  } | null;
  account: {
    cash: number;
    equity: number;
    drawdownPct: number; // from bankroll high-water mark
    fees7d: number; // USD paid in fees, last 7d
    grossPnl7d: number; // USD gross P&L, last 7d (fee drag context)
  };
  lastDecisions: SnapshotPastDecision[]; // newest-first, max 5
  lessons: string[]; // ≤10 standing lessons
  triggerReason: string; // "Woken by: ..."
  guardState: string; // "3 trades left today, cooldown 12min remaining"
}

export interface PromptBotConfig {
  name: string;
  personality: string;
  minConfidence: number;
  feePctPerSide: number; // e.g. 0.1
  slippagePct: number; // e.g. 0.05
}

export interface RenderedPrompt {
  system: string;
  user: string;
  /** chars/4 heuristic over system+user. */
  estTokens: number;
}

export const PROMPT_TOKEN_TARGET = 2500;
const MIN_CANDLES = 6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── formatting helpers (deterministic) ──────────────────────────────────

function fmtNum(n: number, dp = 2): string {
  return n.toFixed(dp).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
}

/** Price-ish values: keep enough precision for sub-dollar alts. */
function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function fmtUtc(ts: number): string {
  // "08-07 14:00" — month-day hour:minute UTC
  return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
}

// ── system prompt ───────────────────────────────────────────────────────

export function buildSystem(cfg: PromptBotConfig): string {
  const roundTrip = fmtNum(2 * (cfg.feePctPerSide + cfg.slippagePct), 2);
  return [
    `You are "${cfg.name}", an autonomous crypto paper-trading bot. Personality: ${cfg.personality}`,
    ``,
    `HARD RULES:`,
    `- The default action is "wait". Most of the time the right move is to do nothing.`,
    `- Trade only when your conviction in that trade is >= ${cfg.minConfidence}. Below that, output "wait".`,
    `- You win by being right, not by being busy.`,
    `- Fees are ${fmtNum(cfg.feePctPerSide)}% per side plus ~${fmtNum(cfg.slippagePct)}% slippage; a round trip costs ~${roundTrip}% — a trade must clear that just to break even.`,
    ``,
    `OUTPUT: reply with ONLY one JSON object, no prose, no markdown fences, exactly this shape:`,
    `{"action":"buy"|"sell"|"wait","symbol":string|null,"size_pct":number|null,"confidence":number,"reasoning":string,"sl_pct":number|null,"tp_pct":number|null}`,
    `- symbol + size_pct required for buy/sell. size_pct: buy = % of cash, sell = % of position, 1-100.`,
    `- confidence: 0-100 — your conviction in the action you ACTUALLY chose, "wait" included. A clear "nothing to do here" is 80+; a coin-flip you resolved by waiting is 30. Never leave it at 0 as a default: 0 means you have no idea what you just decided.`,
    `- reasoning: <= 400 chars.`,
    `- sl_pct/tp_pct: optional per-position overrides (sl negative e.g. -5, tp positive e.g. 10); null to use defaults.`,
  ].join('\n');
}

// ── user prompt (the snapshot) ──────────────────────────────────────────

function renderUser(s: Snapshot, candles: SnapshotCandle[]): string {
  const lines: string[] = [];

  lines.push(`${s.triggerReason}`);
  lines.push(`Symbol in focus: ${s.symbol}. Snapshot time: ${fmtUtc(s.ts)} UTC.`);
  lines.push('');

  lines.push(`1h candles, oldest first (${candles.length} of last 24; time o/h/l/c/vol):`);
  for (const c of candles) {
    lines.push(
      `${fmtUtc(c.ts)} ${fmtPrice(c.o)}/${fmtPrice(c.h)}/${fmtPrice(c.l)}/${fmtPrice(c.c)}/${fmtNum(c.v, 1)}`,
    );
  }
  lines.push('');

  lines.push('Indicators (1h; w = learned trust 0.25-2.0, hit-rate = YOUR accuracy on it, n = samples):');
  // Shadow (auto-disabled) indicators are deliberately absent: they lost your
  // trust, they keep recording votes in the background (PLAN §11.2).
  for (const ind of s.indicators) {
    if (ind.shadow === true) continue;
    const value = ind.value === null ? 'n/a' : fmtNum(ind.value, 2);
    const vote = ind.vote ?? 'none';
    const weight = ind.weight === null ? 'n/a' : fmtNum(ind.weight, 2);
    const hit = ind.hitRate === null ? 'n/a' : `${fmtNum(ind.hitRate * 100, 0)}%`;
    lines.push(
      `- ${ind.name}: ${value} [${vote}] — hit-rate ${hit} (w ${weight}, n ${ind.samples ?? 0})`,
    );
  }
  lines.push(`- funding=${s.funding === null ? 'n/a' : `${fmtNum(s.funding * 100, 4)}%`}`);
  lines.push(`- fear_greed=${s.fearGreed === null ? 'n/a' : fmtNum(s.fearGreed, 0)}`);
  lines.push('');

  if (s.position) {
    const p = s.position;
    lines.push(
      `Open position: ${fmtNum(p.qty, 6)} ${s.symbol} @ avg ${fmtPrice(p.avgEntry)}, unrealized P&L ${fmtNum(p.uPnlPct, 2)}%, stop ${p.stopPrice === null ? 'none' : fmtPrice(p.stopPrice)}, tp ${p.tpPrice === null ? 'none' : fmtPrice(p.tpPrice)}.`,
    );
  } else {
    lines.push(`Open position: none.`);
  }
  const a = s.account;
  lines.push(
    `Account: cash $${fmtNum(a.cash, 2)}, equity $${fmtNum(a.equity, 2)}, drawdown ${fmtNum(a.drawdownPct, 1)}% from high-water mark.`,
  );
  lines.push(
    `Fee drag (7d): $${fmtNum(a.fees7d, 2)} paid in fees vs $${fmtNum(a.grossPnl7d, 2)} gross P&L.`,
  );
  lines.push('');

  lines.push('Your last 5 decisions (newest first; outcome = 4h forward return, score in [-1,1]):');
  if (s.lastDecisions.length === 0) {
    lines.push('- none yet');
  } else {
    for (const d of s.lastDecisions.slice(0, 5)) {
      const head = `- ${fmtUtc(d.ts)} ${d.action}${d.symbol ? ` ${d.symbol}` : ''}${d.sizePct !== null ? ` ${fmtNum(d.sizePct, 0)}%` : ''}${d.confidence !== null ? ` conf ${fmtNum(d.confidence, 0)}` : ''} [${d.status}]`;
      const outcome =
        d.fwdRet4hPct === null
          ? 'outcome pending'
          : `4h ret ${fmtNum(d.fwdRet4hPct, 2)}%${d.score4h === null ? '' : `, score ${fmtNum(d.score4h, 2)}`}`;
      lines.push(`${head} → ${outcome}`);
    }
  }
  lines.push('');

  lines.push('Standing lessons from your own trading history:');
  if (s.lessons.length === 0) {
    lines.push('- none yet');
  } else {
    for (const lesson of s.lessons.slice(0, 10)) lines.push(`- ${lesson}`);
  }
  lines.push('');

  lines.push(`Guard state: ${s.guardState}`);
  lines.push('');
  lines.push('Decide now. JSON only.');

  return lines.join('\n');
}

// ── indicator portfolio review (IMPL-7) — a SEPARATE prompt ─────────────
//
// Nothing above this line changes for it: the decision prompt is untouched,
// this is its own call with its own contract. It is rendered from whatever
// rows the caller passes, so a registry of 15 and a registry of 150 both
// work with zero edits here (IMPL-7 "LEAVE IT OPEN").

export interface ReviewIndicatorRow {
  name: string;
  enabled: boolean;
  samples: number;
  hits: number;
  /** Laplace-smoothed; null until the indicator has any sample at all. */
  hitRate: number | null;
  weight: number;
  /** Registry vote rule, so he can judge an indicator he has never scored. */
  rule: string;
}

export interface ReviewGuards {
  minActive: number;
  maxChanges: number;
  cooldownDays: number;
  activeNow: number;
  registered: number;
  /** Scored votes below which a hit-rate is noise (learn/indicator-stats). */
  sampleFloor: number;
}

export interface ReviewInput {
  botName: string;
  personality: string;
  /** EVERY registered indicator, on and off alike (off ones carry shadow stats). */
  indicators: ReviewIndicatorRow[];
  lessons: string[];
  /** System advice — the old auto-disable thresholds, as opinions. */
  advisories: string[];
  pnl: {
    equity: number;
    bankrollStart: number;
    pnlPct: number;
    drawdownPct: number;
    trades: number;
    meanScore4h: number | null;
    windowDays: number;
  };
  guards: ReviewGuards;
  /** Prior changes ("you switched X off 3 weeks ago"), newest first. */
  recentChanges: string[];
}

export function buildReviewSystem(input: ReviewInput): string {
  const g = input.guards;
  return [
    `You are "${input.botName}", an autonomous crypto paper-trading bot. Personality: ${input.personality}`,
    ``,
    `This is not a trade. This is your periodic INDICATOR PORTFOLIO REVIEW: you decide which indicators you still want to see when you trade. Indicators you switch off keep voting in the background, so their record keeps building and you can bring them back later.`,
    ``,
    `HOW TO THINK ABOUT IT:`,
    `- Judge an indicator on ITS OWN record for YOU, not on reputation. Hit-rate under ~50% on a large sample is evidence against it.`,
    `- A small sample proves nothing. Below ${g.sampleFloor} scored votes, leave it alone and let it collect.`,
    `- Fewer, better indicators beat a wall of noise — but do not gut your own inputs to look decisive. Changing NOTHING is a valid, common answer.`,
    ``,
    `THE FRAME (enforced in code — wishes outside it are logged and refused, not silently trimmed):`,
    `- You must keep at least ${g.minActive} indicators active. You have ${g.activeNow} active of ${g.registered} registered.`,
    `- At most ${g.maxChanges} changes per review.`,
    `- An indicator you changed within the last ${g.cooldownDays} days cannot be flipped again yet.`,
    `- Only the exact indicator names listed below exist.`,
    ``,
    `OUTPUT: reply with ONLY one JSON object, no prose, no markdown fences, exactly this shape:`,
    `{"enable":[string],"disable":[string],"reasoning":string}`,
    `- enable/disable: arrays of indicator names, possibly empty. Never list the same name in both.`,
    `- reasoning: <= 500 chars, naming the evidence you acted on.`,
  ].join('\n');
}

function reviewUser(input: ReviewInput): string {
  const lines: string[] = [];
  const p = input.pnl;

  lines.push(`Your indicators (n = scored votes, w = learned trust 0.25-2.0):`);
  for (const ind of input.indicators) {
    const hit = ind.hitRate === null ? 'n/a' : `${fmtNum(ind.hitRate * 100, 0)}%`;
    lines.push(
      `- ${ind.name} [${ind.enabled ? 'ON' : 'OFF'}] hit-rate ${hit} (n ${ind.samples}, w ${fmtNum(ind.weight, 2)}) — ${ind.rule}`,
    );
  }
  lines.push('');

  lines.push('System advisories (advice, not orders — you may disagree):');
  if (input.advisories.length === 0) lines.push('- nothing stands out right now');
  else for (const a of input.advisories) lines.push(`- ${a}`);
  lines.push('');

  lines.push(`Your P&L (last ${p.windowDays} days):`);
  lines.push(
    `- equity $${fmtNum(p.equity, 2)} vs bankroll $${fmtNum(p.bankrollStart, 2)} (${fmtNum(p.pnlPct, 2)}%), drawdown ${fmtNum(p.drawdownPct, 1)}% from high-water mark.`,
  );
  lines.push(
    `- ${p.trades} trade${p.trades === 1 ? '' : 's'} executed; mean 4h decision score ${p.meanScore4h === null ? 'n/a (nothing evaluated yet)' : fmtNum(p.meanScore4h, 2)} in [-1,1].`,
  );
  lines.push('');

  lines.push('Your standing lessons:');
  if (input.lessons.length === 0) lines.push('- none yet');
  else for (const l of input.lessons.slice(0, 10)) lines.push(`- ${l}`);
  lines.push('');

  lines.push('Your recent indicator changes:');
  if (input.recentChanges.length === 0) lines.push('- none yet — this is your first review');
  else for (const c of input.recentChanges) lines.push(`- ${c}`);
  lines.push('');

  lines.push('Review your indicator set now. JSON only.');
  return lines.join('\n');
}

/**
 * Build the review prompt. PURE — same input, same output. No candle block to
 * trim: the stats table is the payload, and it is one short line per
 * registered indicator, so it scales with the registry instead of a constant.
 */
export function buildReviewPrompt(input: ReviewInput): RenderedPrompt {
  const system = buildReviewSystem(input);
  const user = reviewUser(input);
  return { system, user, estTokens: estimateTokens(system) + estimateTokens(user) };
}

/**
 * Build the full prompt. If over PROMPT_TOKEN_TARGET, drop the oldest
 * candles (4 at a time, down to MIN_CANDLES) until it fits.
 */
export function buildPrompt(cfg: PromptBotConfig, snapshot: Snapshot): RenderedPrompt {
  const system = buildSystem(cfg);
  let candles = snapshot.candles1h.slice(-24);
  let user = renderUser(snapshot, candles);
  let estTokens = estimateTokens(system) + estimateTokens(user);

  while (estTokens > PROMPT_TOKEN_TARGET && candles.length > MIN_CANDLES) {
    candles = candles.slice(Math.min(4, candles.length - MIN_CANDLES));
    user = renderUser(snapshot, candles);
    estTokens = estimateTokens(system) + estimateTokens(user);
  }

  return { system, user, estTokens };
}
