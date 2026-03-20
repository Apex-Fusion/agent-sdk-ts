import { readFileSync, writeFileSync, existsSync } from 'fs';
import { SpendLimitExceededError } from '../errors.js';
import type { SpendLimits, SpendStatus, AuditEntry } from '../types.js';
import { DEFAULT_PER_TX_LIMIT, DEFAULT_DAILY_LIMIT } from '../constants.js';

export class SafetyLayer {
  private dailySpent: number = 0;
  private dailyResetTime: number;
  private auditLog: AuditEntry[] = [];
  private limits: SpendLimits;
  private auditLogPath: string | undefined;

  constructor(
    perTxLimit: number = DEFAULT_PER_TX_LIMIT,
    dailyLimit: number = DEFAULT_DAILY_LIMIT,
    auditLogPath?: string,
  ) {
    this.limits = {
      perTransaction: perTxLimit,
      daily: dailyLimit,
    };
    this.dailyResetTime = this.getNextMidnightUTC();
    this.auditLogPath = auditLogPath;

    if (this.auditLogPath) {
      this.loadAuditLog();
    }
  }

  private getNextMidnightUTC(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime();
  }

  private checkAndResetDaily(): void {
    if (Date.now() >= this.dailyResetTime) {
      this.dailySpent = 0;
      this.dailyResetTime = this.getNextMidnightUTC();
    }
  }

  private loadAuditLog(): void {
    if (!this.auditLogPath) return;
    try {
      if (existsSync(this.auditLogPath)) {
        const data = readFileSync(this.auditLogPath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.auditLog = parsed;
          this.recalculateDailySpent();
        }
      }
    } catch {
      this.auditLog = [];
    }
  }

  private recalculateDailySpent(): void {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();

    this.dailySpent = 0;
    for (const entry of this.auditLog) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime >= todayStartMs) {
        this.dailySpent += entry.amountLovelace;
      }
    }
  }

  private persistAuditLog(): void {
    if (!this.auditLogPath) return;
    try {
      writeFileSync(this.auditLogPath, JSON.stringify(this.auditLog, null, 2));
    } catch {
      // Non-fatal: audit persistence is best-effort
    }
  }

  checkTransaction(amountLovelace: number): { allowed: boolean; reason?: string } {
    this.checkAndResetDaily();

    if (amountLovelace > this.limits.perTransaction) {
      return {
        allowed: false,
        reason: `Transaction amount ${(amountLovelace / 1_000_000).toFixed(6)} ADA exceeds per-transaction limit of ${(this.limits.perTransaction / 1_000_000).toFixed(6)} ADA`,
      };
    }

    if (this.dailySpent + amountLovelace > this.limits.daily) {
      const remaining = this.limits.daily - this.dailySpent;
      return {
        allowed: false,
        reason: `Transaction would exceed daily spend limit. Daily limit: ${(this.limits.daily / 1_000_000).toFixed(6)} ADA, already spent: ${(this.dailySpent / 1_000_000).toFixed(6)} ADA, remaining: ${(remaining / 1_000_000).toFixed(6)} ADA`,
      };
    }

    return { allowed: true };
  }

  enforceTransaction(amountLovelace: number): void {
    const check = this.checkTransaction(amountLovelace);
    if (!check.allowed) {
      const limitType = check.reason!.includes('per-transaction') ? 'per_tx' : 'daily';
      const limit = limitType === 'per_tx' ? this.limits.perTransaction : this.limits.daily;
      throw new SpendLimitExceededError(check.reason!, limitType, limit, amountLovelace);
    }
  }

  recordTransaction(txHash: string, amountLovelace: number, recipient: string): void {
    this.checkAndResetDaily();
    this.dailySpent += amountLovelace;

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      txHash,
      amountLovelace,
      recipient,
      action: 'send',
    });

    this.persistAuditLog();
  }

  getSpendStatus(): SpendStatus {
    this.checkAndResetDaily();
    return {
      perTransactionLimit: this.limits.perTransaction,
      dailyLimit: this.limits.daily,
      dailySpent: this.dailySpent,
      dailyRemaining: Math.max(0, this.limits.daily - this.dailySpent),
      resetTime: new Date(this.dailyResetTime).toISOString(),
    };
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }
}
