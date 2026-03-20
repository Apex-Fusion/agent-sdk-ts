import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/safety/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows calls within the limit', () => {
    const limiter = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      const result = limiter.check();
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks calls exceeding the limit', () => {
    const limiter = new RateLimiter(3);
    limiter.check();
    limiter.check();
    limiter.check();
    const result = limiter.check();
    expect(result.allowed).toBe(false);
    expect(typeof result.retryAfterMs).toBe('number');
    expect(result.retryAfterMs!).toBeGreaterThan(0);
  });
});
