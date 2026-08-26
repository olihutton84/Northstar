/**
 * Closing a health incident.
 *
 * An unresolved incident is a claim that something was wrong at a moment in the
 * past. Whether it is STILL wrong is a different question, and the only safe
 * way to answer it is to recompute the condition from live state rather than
 * trust the operator's recollection or the incident's own wording.
 *
 * The refusal is the feature here. An incident closed over a live problem does
 * not remove the problem; it removes the only sign of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from '../fixtures/harness.js';
import { EPOCH_PAPER_50 } from '../../src/config/executionEpochs.js';
import type { HealthIncident } from '../../src/domain/types.js';

function incident(over: Partial<HealthIncident> = {}): HealthIncident {
  return {
    incidentId: 'inc-1',
    strategyId: 'x-signal-v1',
    fault: 'LEDGER_MISMATCH',
    at: '2026-02-01T10:00:00.000Z',
    detail: 'Ledger cash 4166 does not match the sum of entries 4100 (difference 66)',
    paused: true,
    resolvedAt: null,
    resolutionNote: '',
    ...over,
  };
}

/* ============================================ 1. a stale historical one === */

describe('an incident whose cause is gone', () => {
  it('is diagnosed as no longer present', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident());

    const [d] = h.app.forensics.diagnoseOpen();
    assert.ok(d);
    assert.equal(d.stillPresent, false);
    assert.equal(d.resolvable, true);
    assert.match(d.verdict, /reconciles in every epoch/);
    h.close();
  });

  it('can be closed, with the reason recorded', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident());

    const result = h.app.forensics.resolve('inc-1', 'Historical: belongs to the $50 run, every epoch reconciles now.');
    assert.equal(result.resolved, true);

    const stored = h.app.store.incidents.byId('inc-1');
    assert.ok(stored?.resolvedAt, 'it must be marked resolved');
    assert.match(stored.resolutionNote, /Historical/, 'and say why');
    assert.equal(h.app.store.incidents.open(h.app.spec.strategyId).length, 0);
    h.close();
  });

  it('is never deleted — the record survives resolution', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident());
    h.app.forensics.resolve('inc-1', 'historical');

    const stored = h.app.store.incidents.byId('inc-1');
    assert.ok(stored, 'the incident row must still exist');
    assert.equal(stored.fault, 'LEDGER_MISMATCH');
    assert.equal(stored.detail, incident().detail, 'the original condition is preserved verbatim');
    h.close();
  });

  it('writes the resolution into the append-only decision log', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident());
    h.app.forensics.resolve('inc-1', 'historical, ledger clean');

    const logged = h.app.store.log.recent(50).find((e) => e.subjectId === 'inc-1');
    assert.ok(logged, 'resolving must be auditable alongside everything else the bot did');
    assert.equal(logged.stage, 'HEALTH');
    const payload = logged.payload as { note?: string; raisedDetail?: string };
    assert.equal(payload.note, 'historical, ledger clean');
    assert.equal(payload.raisedDetail, incident().detail);
    h.close();
  });

  it('refuses to close without a reason', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident());

    const result = h.app.forensics.resolve('inc-1', '   ');
    assert.equal(result.resolved, false);
    assert.match(result.detail, /note is required/i);
    assert.equal(h.app.store.incidents.open(h.app.spec.strategyId).length, 1);
    h.close();
  });

  it('refuses to close the same incident twice', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident());
    h.app.forensics.resolve('inc-1', 'historical');

    const again = h.app.forensics.resolve('inc-1', 'again');
    assert.equal(again.resolved, false);
    assert.match(again.detail, /already resolved/);
    h.close();
  });
});

/* ============================================== 2. a live one stays open == */

describe('an incident whose cause is still present', () => {
  /** Break the ledger so cash no longer matches its entries. */
  function withLiveMismatch() {
    const h = createHarness();
    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, cashCents: ledger.cashCents - 5000 });
    h.app.store.incidents.save(incident({ incidentId: 'inc-live', at: '2026-03-10T15:00:00.000Z' }));
    return h;
  }

  it('is diagnosed as still present', () => {
    const h = withLiveMismatch();
    const [d] = h.app.forensics.diagnoseOpen();
    assert.ok(d);
    assert.equal(d.stillPresent, true);
    assert.equal(d.resolvable, false);
    assert.match(d.verdict, /STILL PRESENT/);
    assert.match(d.verdict, /do not resume the strategy/i);
    h.close();
  });

  it('REFUSES to be closed, however confident the note', () => {
    const h = withLiveMismatch();
    const result = h.app.forensics.resolve('inc-live', 'I am certain this is historical');
    assert.equal(result.resolved, false);
    assert.match(result.detail, /REFUSED/);
    assert.equal(h.app.store.incidents.open(h.app.spec.strategyId).length, 1, 'it must stay open');
    assert.equal(h.app.store.incidents.byId('inc-live')?.resolvedAt, null);
    h.close();
  });

  it('reports the actual arithmetic, not a vague failure', () => {
    const h = withLiveMismatch();
    const [d] = h.app.forensics.diagnoseOpen();
    const broken = d!.epochs.filter((e) => !e.ok);
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.differenceCents, -5000);
    assert.match(broken[0]!.detail, /does not match/);
    h.close();
  });

  it('becomes closable once the underlying mismatch is genuinely repaired', () => {
    const h = withLiveMismatch();
    assert.equal(h.app.forensics.resolve('inc-live', 'note').resolved, false);

    // Put the cash back. This is what a real repair looks like to the checker.
    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, cashCents: ledger.cashCents + 5000 });

    const result = h.app.forensics.resolve('inc-live', 'cash restored after investigation');
    assert.equal(result.resolved, true);
    h.close();
  });
});

/* ================================================== 3. attribution ======== */

describe('which run an incident belongs to', () => {
  it('attributes an incident raised before any epoch to the earliest one', () => {
    const h = createHarness({ epoch: EPOCH_PAPER_50 });
    h.app.store.incidents.save(incident({ at: '2020-01-01T00:00:00.000Z' }));

    const [d] = h.app.forensics.diagnoseOpen();
    assert.equal(d!.attributedEpochId, EPOCH_PAPER_50.epochId);
    assert.match(d!.attributionDetail, /before any epoch was recorded/);
    h.close();
  });

  it('reports integrity for every epoch, not only the active one', () => {
    const h = createHarness();
    const epochs = h.app.forensics.allEpochIntegrity();
    assert.ok(epochs.length >= 1);
    for (const e of epochs) {
      assert.equal(typeof e.ok, 'boolean');
      assert.equal(typeof e.entryCount, 'number');
    }
    h.close();
  });
});

/* ============================================ 4. other fault kinds ======== */

describe('faults whose condition cannot be recomputed', () => {
  it('does not claim a provider fault is still present, and says so', () => {
    const h = createHarness();
    h.app.store.incidents.save(incident({
      incidentId: 'inc-provider',
      fault: 'SOCIAL_PROVIDER_FAILURE',
      detail: 'X timed out three times',
    }));

    const [d] = h.app.forensics.diagnoseOpen();
    assert.equal(d!.stillPresent, false);
    assert.match(d!.verdict, /not recomputable/);
    assert.match(d!.verdict, /independently confirmed/);
    h.close();
  });
});
