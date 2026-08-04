export class AdaptiveConcurrencyState {
  constructor({
    initial = 2,
    minimum = 1,
    maximum = 3,
    successesToIncrease = 6,
    recoveryCooldownMs = 30_000,
  } = {}) {
    this.minimum = Math.max(1, Math.floor(minimum));
    this.maximum = Math.max(this.minimum, Math.floor(maximum));
    this.current = Math.max(this.minimum, Math.min(this.maximum, Math.floor(initial)));
    this.successesToIncrease = Math.max(1, Math.floor(successesToIncrease));
    this.recoveryCooldownMs = Math.max(0, Number(recoveryCooldownMs) || 0);
    this.consecutiveSuccesses = 0;
    this.rateLimitCount = 0;
    this.lastRateLimitAt = 0;
  }

  recordSuccess(now = Date.now()) {
    this.consecutiveSuccesses += 1;
    const cooldownComplete = !this.lastRateLimitAt || now - this.lastRateLimitAt >= this.recoveryCooldownMs;
    if (this.current < this.maximum
      && this.consecutiveSuccesses >= this.successesToIncrease
      && cooldownComplete) {
      this.current += 1;
      this.consecutiveSuccesses = 0;
    }
    return this.current;
  }

  recordRateLimit(now = Date.now()) {
    this.current = this.minimum;
    this.consecutiveSuccesses = 0;
    this.rateLimitCount += 1;
    this.lastRateLimitAt = now;
    return this.current;
  }

  snapshot() {
    return {
      concurrency: this.current,
      minimum: this.minimum,
      maximum: this.maximum,
      consecutiveSuccesses: this.consecutiveSuccesses,
      rateLimitCount: this.rateLimitCount,
      lastRateLimitAt: this.lastRateLimitAt || null,
    };
  }
}

export class AdaptiveRequestPool {
  constructor({
    initial = 2,
    minimum = 1,
    maximum = 3,
    successesToIncrease = 6,
    recoveryCooldownMs = 30_000,
    minimumStartIntervalMs = 250,
  } = {}) {
    this.state = new AdaptiveConcurrencyState({
      initial,
      minimum,
      maximum,
      successesToIncrease,
      recoveryCooldownMs,
    });
    this.minimumStartIntervalMs = Math.max(0, Number(minimumStartIntervalMs) || 0);
    this.queue = [];
    this.active = 0;
    this.blockedUntil = 0;
    this.lastStartedAt = 0;
    this.timer = null;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  snapshot() {
    return {
      ...this.state.snapshot(),
      active: this.active,
      queued: this.queue.length,
      blockedUntil: this.blockedUntil || null,
    };
  }

  #schedule(delayMs) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain();
    }, Math.max(1, delayMs));
  }

  #drain() {
    if (!this.queue.length || this.active >= this.state.current) return;
    const now = Date.now();
    if (this.blockedUntil && this.blockedUntil <= now) this.blockedUntil = 0;
    const startAt = Math.max(
      this.blockedUntil,
      this.lastStartedAt + this.minimumStartIntervalMs,
    );
    if (startAt > now) {
      this.#schedule(startAt - now);
      return;
    }

    const entry = this.queue.shift();
    this.active += 1;
    this.lastStartedAt = now;
    Promise.resolve()
      .then(entry.task)
      .then((value) => {
        this.state.recordSuccess();
        entry.resolve(value);
      })
      .catch((error) => {
        const status = Number(error?.status || error?.statusCode || error?.response?.status);
        if (status === 429) {
          this.state.recordRateLimit();
          const retryAfterMs = Math.max(1000, Number(error?.retryAfterMs) || 8000);
          this.blockedUntil = Math.max(this.blockedUntil, Date.now() + retryAfterMs);
        }
        entry.reject(error);
      })
      .finally(() => {
        this.active -= 1;
        this.#drain();
      });

    queueMicrotask(() => this.#drain());
  }
}
