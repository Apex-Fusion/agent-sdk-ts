import { describe, it, expect } from 'vitest';
import {
  VectorError, ConnectionError, InsufficientFundsError,
  SpendLimitExceededError, TransactionError, WalletError,
  InvalidAddressError, RegistryError,
} from '../../src/errors.js';

describe('Error classes', () => {
  it('VectorError is an Error', () => {
    const err = new VectorError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('VectorError');
    expect(err.message).toBe('test');
  });

  it('ConnectionError extends VectorError', () => {
    const err = new ConnectionError('conn fail');
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('ConnectionError');
  });

  it('InsufficientFundsError extends VectorError', () => {
    const err = new InsufficientFundsError('not enough');
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('InsufficientFundsError');
  });

  it('SpendLimitExceededError stores limit details', () => {
    const err = new SpendLimitExceededError('over limit', 'per_tx', 100_000_000, 200_000_000);
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('SpendLimitExceededError');
    expect(err.limitType).toBe('per_tx');
    expect(err.limit).toBe(100_000_000);
    expect(err.attempted).toBe(200_000_000);
  });

  it('TransactionError extends VectorError', () => {
    const err = new TransactionError('tx fail');
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('TransactionError');
  });

  it('WalletError extends VectorError', () => {
    const err = new WalletError('bad key');
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('WalletError');
  });

  it('InvalidAddressError extends VectorError', () => {
    const err = new InvalidAddressError('bad addr');
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('InvalidAddressError');
  });

  it('RegistryError extends VectorError', () => {
    const err = new RegistryError('reg fail');
    expect(err).toBeInstanceOf(VectorError);
    expect(err.name).toBe('RegistryError');
  });
});
