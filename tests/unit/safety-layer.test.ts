import { describe, it, expect } from 'vitest';
import { SafetyLayer } from '../../src/safety/safety-layer.js';
import { SpendLimitExceededError } from '../../src/errors.js';

describe('SafetyLayer', () => {
  it('allows transactions within per-tx limit', () => {
    const safety = new SafetyLayer(100_000_000, 500_000_000);
    const result = safety.checkTransaction(50_000_000);
    expect(result.allowed).toBe(true);
  });

  it('blocks transactions exceeding per-tx limit', () => {
    const safety = new SafetyLayer(100_000_000, 500_000_000);
    const result = safety.checkTransaction(200_000_000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('per-transaction limit');
  });

  it('blocks transactions exceeding daily limit', () => {
    const safety = new SafetyLayer(100_000_000, 150_000_000);
    safety.recordTransaction('tx1', 100_000_000, 'addr1...');
    const result = safety.checkTransaction(60_000_000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily spend limit');
  });

  it('accumulates daily spend across transactions', () => {
    const safety = new SafetyLayer(100_000_000, 500_000_000);
    safety.recordTransaction('tx1', 50_000_000, 'addr1');
    safety.recordTransaction('tx2', 50_000_000, 'addr2');
    const status = safety.getSpendStatus();
    expect(status.dailySpent).toBe(100_000_000);
    expect(status.dailyRemaining).toBe(400_000_000);
  });

  it('enforceTransaction throws SpendLimitExceededError', () => {
    const safety = new SafetyLayer(10_000_000, 500_000_000);
    expect(() => safety.enforceTransaction(20_000_000)).toThrow(SpendLimitExceededError);
  });

  it('enforceTransaction does not throw within limits', () => {
    const safety = new SafetyLayer(100_000_000, 500_000_000);
    expect(() => safety.enforceTransaction(50_000_000)).not.toThrow();
  });

  it('getSpendStatus returns correct structure', () => {
    const safety = new SafetyLayer(100_000_000, 500_000_000);
    const status = safety.getSpendStatus();
    expect(status.perTransactionLimit).toBe(100_000_000);
    expect(status.dailyLimit).toBe(500_000_000);
    expect(status.dailySpent).toBe(0);
    expect(status.dailyRemaining).toBe(500_000_000);
    expect(typeof status.resetTime).toBe('string');
  });

  it('getAuditLog returns recorded transactions', () => {
    const safety = new SafetyLayer(100_000_000, 500_000_000);
    safety.recordTransaction('hash1', 5_000_000, 'addr1');
    const log = safety.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].txHash).toBe('hash1');
    expect(log[0].amountLovelace).toBe(5_000_000);
    expect(log[0].recipient).toBe('addr1');
    expect(log[0].action).toBe('send');
  });
});
