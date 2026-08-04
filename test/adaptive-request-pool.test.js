import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveConcurrencyState, AdaptiveRequestPool } from '../src/lib/adaptive-request-pool.js';

test('adaptive concurrency drops to one on 429 and recovers after stable successes', () => {
  const state = new AdaptiveConcurrencyState({
    initial: 2,
    maximum: 3,
    successesToIncrease: 2,
    recoveryCooldownMs: 1000,
  });
  state.recordSuccess();
  state.recordSuccess();
  assert.equal(state.snapshot().concurrency, 3);
  state.recordRateLimit(1000);
  assert.equal(state.snapshot().concurrency, 1);
  state.recordSuccess(1500);
  state.recordSuccess(1500);
  assert.equal(state.snapshot().concurrency, 1);
  state.recordSuccess(2000);
  assert.equal(state.snapshot().concurrency, 2);
});

test('request pool never exceeds its active concurrency', async () => {
  const pool = new AdaptiveRequestPool({
    initial: 2,
    maximum: 2,
    minimumStartIntervalMs: 0,
  });
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => pool.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});
