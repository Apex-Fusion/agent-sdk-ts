import { VectorError } from '../errors.js';
import { TxConstructionError } from './vendor.js';

/**
 * A deployment value or an endpoint is missing or wrong. The message names
 * the environment variable when one applies.
 */
export class IdentityConfigError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}

/** An output that the operation needs (a record, a delegation, the configuration record) is not on the ledger. */
export class IdentityLookupError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityLookupError';
  }
}

/**
 * The contract would reject the transaction, so no transaction is built.
 * `reason` is a stable snake_case code. This is the error class of the
 * vendored builders (`TxConstructionError`); the clients use it for their own
 * checks too.
 */
export const IdentityRuleError = TxConstructionError;
export type IdentityRuleError = TxConstructionError;

/** Throws an `IdentityRuleError` with a stable reason code. */
export function ruleError(reason: string, message: string): never {
  throw new TxConstructionError(reason, message);
}
