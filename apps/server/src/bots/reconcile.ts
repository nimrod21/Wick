/**
 * Boot-time crash recovery (IMPL-4 §7.2).
 *
 * `bot-runner` writes the decision row FIRST and then asks the paper engine to
 * fill it, so the fill can carry `decision_id`. Those two writes are separate
 * transactions: a kill -9 in between leaves a buy/sell decision marked
 * `executed` that never moved any money — a phantom trade in the audit trail
 * and in the learning stats.
 *
 * Rather than widen the transaction across an event-publishing engine call,
 * Wick repairs on restart (crash-only design): any buy/sell decision that says
 * `executed` but has no `fills` row is rewritten to `vetoed` with reason
 * `crash_no_fill`. It is idempotent and only ever touches rows written before
 * this boot — a decision being written right now belongs to a live process.
 *
 * `wait` decisions are untouched (they have no fill by definition) and so are
 * protector rows (the protector writes its decision then fills; the same
 * repair applies to it, and it is a 'sell', so it is covered).
 */

import { db } from '../db/client.js';
import { logger } from '../util/logger.js';

export const CRASH_VETO_REASON = 'crash_no_fill';

/** Returns the number of phantom decisions repaired. */
export function reconcileCrashedDecisions(): number {
  const info = db
    .prepare(
      `UPDATE decisions
          SET status = 'vetoed', veto_reason = ?
        WHERE status = 'executed'
          AND action IN ('buy', 'sell')
          AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.decision_id = decisions.id)`,
    )
    .run(CRASH_VETO_REASON);
  if (info.changes > 0) {
    logger.warn(
      { repaired: info.changes },
      'crash recovery: decisions marked executed with no fill rewritten to vetoed',
    );
  }
  return info.changes;
}
