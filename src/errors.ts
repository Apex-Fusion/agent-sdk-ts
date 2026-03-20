export class VectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorError';
  }
}

export class ConnectionError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export class InsufficientFundsError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class SpendLimitExceededError extends VectorError {
  public readonly limitType: string;
  public readonly limit: number;
  public readonly attempted: number;

  constructor(message: string, limitType: string, limit: number, attempted: number) {
    super(message);
    this.name = 'SpendLimitExceededError';
    this.limitType = limitType;
    this.limit = limit;
    this.attempted = attempted;
  }
}

export class TransactionError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}

export class WalletError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export class InvalidAddressError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAddressError';
  }
}

export class RegistryError extends VectorError {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}
