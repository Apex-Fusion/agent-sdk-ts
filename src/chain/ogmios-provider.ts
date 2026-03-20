/**
 * Custom Lucid Provider backed by Ogmios HTTP JSON-RPC + Vector submit-api.
 *
 * Implements the @lucid-evolution/lucid Provider interface so we can use Lucid's
 * transaction building/signing without depending on Blockfrost.
 */
import fetch from 'cross-fetch';
import type {
  Provider,
  ProtocolParameters,
  UTxO,
  OutRef,
  Credential,
  Delegation,
  EvalRedeemer,
} from '@lucid-evolution/lucid';
import { ConnectionError } from '../errors.js';

export interface OgmiosProviderConfig {
  ogmiosUrl: string;
  submitUrl: string;
  koiosUrl?: string;
}

export class OgmiosProvider implements Provider {
  private ogmiosUrl: string;
  private submitUrl: string;
  private koiosUrl: string | undefined;

  constructor(config: OgmiosProviderConfig) {
    this.ogmiosUrl = config.ogmiosUrl.replace(/\/+$/, '');
    this.submitUrl = config.submitUrl.replace(/\/+$/, '');
    this.koiosUrl = config.koiosUrl?.replace(/\/+$/, '');
  }

  private async rpc(method: string, params?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.ogmiosUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          params: params || {},
          id: null,
        }),
      });
    } catch (err) {
      throw new ConnectionError(`Cannot reach Ogmios at ${this.ogmiosUrl}: ${err}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ConnectionError(`Ogmios RPC error (${response.status}): ${text}`);
    }

    const json = await response.json();
    if (json.error) {
      throw new ConnectionError(`Ogmios RPC error: ${JSON.stringify(json.error)}`);
    }

    return json.result;
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const result = await this.rpc('queryLedgerState/protocolParameters');

    return {
      minFeeA: result.minFeeCoefficient,
      minFeeB: result.minFeeConstant?.ada?.lovelace ?? result.minFeeConstant,
      maxTxSize: result.maxTransactionSize?.bytes ?? result.maxTransactionSize,
      maxValSize: result.maxValueSize?.bytes ?? result.maxValueSize,
      keyDeposit: BigInt(result.stakeCredentialDeposit?.ada?.lovelace ?? result.stakeCredentialDeposit ?? 2000000),
      poolDeposit: BigInt(result.stakePoolDeposit?.ada?.lovelace ?? result.stakePoolDeposit ?? 500000000),
      priceMem: result.scriptExecutionPrices?.memory
        ? this.parseFraction(result.scriptExecutionPrices.memory)
        : (result.prices?.memory ?? 0.0577),
      priceStep: result.scriptExecutionPrices?.cpu
        ? this.parseFraction(result.scriptExecutionPrices.cpu)
        : (result.prices?.steps ?? 0.0000721),
      maxTxExMem: BigInt(result.maxExecutionUnitsPerTransaction?.memory ?? 14000000),
      maxTxExSteps: BigInt(result.maxExecutionUnitsPerTransaction?.cpu ?? 10000000000),
      coinsPerUtxoByte: BigInt(result.minUtxoDepositCoefficient ?? result.coinsPerUtxoByte ?? 4310),
      collateralPercentage: result.collateralPercentage ?? 150,
      maxCollateralInputs: result.maxCollateralInputs ?? 3,
      costModels: this.parseCostModels(result.plutusCostModels ?? result.costModels ?? {}),
      minFeeRefScriptCostPerByte: result.minFeeReferenceScripts?.base ?? 15,
      drepDeposit: BigInt(result.delegateRepresentativeDeposit?.ada?.lovelace ?? 500000000),
      govActionDeposit: BigInt(result.governanceActionDeposit?.ada?.lovelace ?? 100000000000),
    } as ProtocolParameters;
  }

  private parseFraction(value: string | number): number {
    if (typeof value === 'number') return value;
    const parts = value.split('/');
    if (parts.length === 2) {
      return Number(parts[0]) / Number(parts[1]);
    }
    return parseFloat(value);
  }

  private parseCostModels(raw: any): any {
    const costModels: any = {};
    if (raw['plutus:v1']) costModels.PlutusV1 = raw['plutus:v1'];
    if (raw['plutus:v2']) costModels.PlutusV2 = raw['plutus:v2'];
    if (raw['plutus:v3']) costModels.PlutusV3 = raw['plutus:v3'];
    if (raw.PlutusV1) costModels.PlutusV1 = raw.PlutusV1;
    if (raw.PlutusV2) costModels.PlutusV2 = raw.PlutusV2;
    if (raw.PlutusV3) costModels.PlutusV3 = raw.PlutusV3;
    return costModels;
  }

  async getUtxos(addressOrCredential: string | Credential): Promise<UTxO[]> {
    if (typeof addressOrCredential !== 'string') {
      throw new Error(
        'Credential-based UTxO lookup is not supported by Ogmios. ' +
        'Please provide a bech32 address string.'
      );
    }

    const result = await this.rpc('queryLedgerState/utxo', { addresses: [addressOrCredential] });
    return this.ogmiosUtxosToLucid(result);
  }

  async getUtxosWithUnit(addressOrCredential: string | Credential, unit: string): Promise<UTxO[]> {
    const utxos = await this.getUtxos(addressOrCredential);
    return utxos.filter((utxo) => utxo.assets[unit]);
  }

  async getUtxoByUnit(unit: string): Promise<UTxO> {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);

    if (this.koiosUrl) {
      try {
        const response = await fetch(`${this.koiosUrl}/api/v1/asset_utxos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _asset_list: [[policyId, assetName]] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.length > 0) {
            return this.koiosUtxoToLucid(data[0]);
          }
        }
      } catch {
        // Koios unreachable — fall through
      }
    }

    throw new Error(
      `Asset ${policyId.slice(0, 8)}...${assetName ? assetName.slice(0, 8) + '...' : '(empty)'} not found. ` +
      `${this.koiosUrl ? 'Koios returned no results.' : 'No Koios indexer configured.'} ` +
      `The asset may not exist on-chain yet (wait for TX confirmation) or may have been burned.`
    );
  }

  async getUtxosByOutRef(outRefs: OutRef[]): Promise<UTxO[]> {
    const outputReferences = outRefs.map((ref) => ({
      transaction: { id: ref.txHash },
      index: ref.outputIndex,
    }));

    const result = await this.rpc('queryLedgerState/utxo', { outputReferences });
    return this.ogmiosUtxosToLucid(result);
  }

  async getDelegation(rewardAddress: string): Promise<Delegation> {
    if (this.koiosUrl) {
      try {
        const response = await fetch(`${this.koiosUrl}/api/v1/account_info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _stake_addresses: [rewardAddress] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.length > 0) {
            return {
              poolId: data[0].delegated_pool || null,
              rewards: BigInt(data[0].rewards_available || 0),
            };
          }
        }
      } catch {
        // Fall through to default
      }
    }
    return { poolId: null, rewards: 0n };
  }

  async getDatum(datumHash: string): Promise<string> {
    if (this.koiosUrl) {
      try {
        const response = await fetch(`${this.koiosUrl}/api/v1/datum_info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _datum_hashes: [datumHash] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.length > 0 && data[0].bytes) {
            return data[0].bytes;
          }
        }
      } catch {
        // Fall through
      }
    }
    throw new Error(`Datum not found for hash: ${datumHash}. Datum lookups require Koios indexer.`);
  }

  async awaitTx(txHash: string, checkInterval: number = 3000): Promise<boolean> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      if (this.koiosUrl) {
        try {
          const response = await fetch(`${this.koiosUrl}/api/v1/tx_status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _tx_hashes: [txHash] }),
          });
          if (response.ok) {
            const data = await response.json();
            if (data.length > 0 && data[0].num_confirmations > 0) {
              return true;
            }
          }
        } catch {
          // Continue polling
        }
      } else {
        try {
          const utxos = await this.getUtxosByOutRef([{ txHash, outputIndex: 0 }]);
          if (utxos.length > 0) return true;
        } catch {
          // Not yet confirmed
        }
      }
    }
    return false;
  }

  async evaluateTx(tx: string, _additionalUTxOs?: UTxO[]): Promise<EvalRedeemer[]> {
    const result = await this.rpc('evaluateTransaction', {
      transaction: { cbor: tx },
    });
    if (Array.isArray(result)) {
      return result.map((item: any) => ({
        ex_units: {
          mem: item.budget?.memory ?? 0,
          steps: item.budget?.cpu ?? 0,
        },
        redeemer_index: item.validator?.index ?? 0,
        redeemer_tag: item.validator?.purpose ?? 'spend',
      }));
    }
    return [];
  }

  async evaluateTransaction(txCborHex: string): Promise<any> {
    return this.rpc('evaluateTransaction', {
      transaction: { cbor: txCborHex },
    });
  }

  async getTransactionHistory(
    address: string,
    offset: number = 0,
    limit: number = 20,
  ): Promise<any[]> {
    if (!this.koiosUrl) {
      throw new ConnectionError(
        'Koios URL is not configured. Transaction history requires Koios indexer.'
      );
    }

    const txListResponse = await fetch(`${this.koiosUrl}/api/v1/address_txs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _addresses: [address], _after_block_height: 0 }),
    });

    if (!txListResponse.ok) {
      const text = await txListResponse.text();
      throw new ConnectionError(`Koios address_txs query failed (${txListResponse.status}): ${text}`);
    }

    const txList: any[] = await txListResponse.json();
    const paginatedTxs = txList.slice(offset, offset + limit);

    if (paginatedTxs.length === 0) return [];

    const txHashes = paginatedTxs.map((tx: any) => tx.tx_hash);
    const txInfoResponse = await fetch(`${this.koiosUrl}/api/v1/tx_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _tx_hashes: txHashes }),
    });

    if (!txInfoResponse.ok) {
      return paginatedTxs.map((tx: any) => ({
        txHash: tx.tx_hash,
        blockHeight: tx.block_height || 0,
        blockTime: tx.block_time
          ? new Date(tx.block_time * 1000).toISOString()
          : '',
        fee: '0',
      }));
    }

    const txInfos: any[] = await txInfoResponse.json();

    return txInfos.map((info: any) => ({
      txHash: info.tx_hash,
      blockHeight: info.block_height || 0,
      blockTime: info.tx_timestamp
        ? new Date(info.tx_timestamp * 1000).toISOString()
        : info.block_time
          ? new Date(info.block_time * 1000).toISOString()
          : '',
      fee: info.fee || '0',
    }));
  }

  async submitTx(tx: string): Promise<string> {
    const bytes = Buffer.from(tx, 'hex');

    let response: Response;
    try {
      response = await fetch(this.submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/cbor' },
        body: bytes,
      });
    } catch (err) {
      throw new ConnectionError(`Cannot reach submit API at ${this.submitUrl}: ${err}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Transaction submission failed (${response.status}): ${errorText}`);
    }

    const result = await response.text();
    try {
      const parsed = JSON.parse(result);
      return typeof parsed === 'string' ? parsed : parsed.txId || parsed.txHash || tx.slice(0, 64);
    } catch {
      return result.replace(/"/g, '').trim();
    }
  }

  private ogmiosUtxosToLucid(ogmiosUtxos: any[]): UTxO[] {
    if (!Array.isArray(ogmiosUtxos)) return [];

    return ogmiosUtxos.map((utxo) => {
      const txHash = utxo.transaction?.id ?? utxo.txId;
      const outputIndex = utxo.index ?? utxo.outputIndex;
      const output = utxo.output ?? utxo;

      const assets: Record<string, bigint> = {};
      const value = output.value ?? output.amount;

      if (typeof value === 'object' && value !== null) {
        if (value.ada?.lovelace !== undefined) {
          assets['lovelace'] = BigInt(value.ada.lovelace);
        } else if (value.coins !== undefined) {
          assets['lovelace'] = BigInt(value.coins);
        } else if (typeof value === 'bigint' || typeof value === 'number') {
          assets['lovelace'] = BigInt(value);
        }

        for (const [key, val] of Object.entries(value)) {
          if (key === 'ada' || key === 'coins' || key === 'lovelace') continue;
          if (typeof val === 'object' && val !== null) {
            for (const [assetName, quantity] of Object.entries(val as Record<string, any>)) {
              const unit = `${key}${assetName === '' ? '' : assetName}`;
              assets[unit] = BigInt(quantity);
            }
          }
        }
      } else if (typeof value === 'number' || typeof value === 'string') {
        assets['lovelace'] = BigInt(value);
      }

      const address = output.address ?? '';

      let datumHash: string | null = null;
      let datum: string | null = null;

      if (output.datumHash) {
        datumHash = output.datumHash;
      }
      if (output.datum) {
        if (typeof output.datum === 'string') {
          datum = output.datum;
        } else if (output.datum.hash) {
          datumHash = output.datum.hash;
        } else if (output.datum.value || output.datum.bytes) {
          datum = output.datum.value || output.datum.bytes;
        }
      }

      let scriptRef: any = null;
      if (output.script) {
        const script = output.script;
        if (script['plutus:v2']) {
          scriptRef = { type: 'PlutusV2', script: script['plutus:v2'] };
        } else if (script['plutus:v1']) {
          scriptRef = { type: 'PlutusV1', script: script['plutus:v1'] };
        } else if (script['plutus:v3']) {
          scriptRef = { type: 'PlutusV3', script: script['plutus:v3'] };
        } else if (script.native) {
          scriptRef = { type: 'Native', script: JSON.stringify(script.native) };
        }
      }

      return {
        txHash,
        outputIndex,
        assets,
        address,
        datumHash,
        datum,
        scriptRef,
      } as UTxO;
    });
  }

  private koiosUtxoToLucid(koiosUtxo: any): UTxO {
    const assets: Record<string, bigint> = {};
    assets['lovelace'] = BigInt(koiosUtxo.value || 0);

    if (koiosUtxo.asset_list) {
      for (const asset of koiosUtxo.asset_list) {
        const unit = `${asset.policy_id}${asset.asset_name || ''}`;
        assets[unit] = BigInt(asset.quantity || 0);
      }
    }

    return {
      txHash: koiosUtxo.tx_hash,
      outputIndex: koiosUtxo.tx_index,
      assets,
      address: koiosUtxo.address,
      datumHash: koiosUtxo.datum_hash || null,
      datum: koiosUtxo.inline_datum?.bytes || null,
      scriptRef: null,
    } as UTxO;
  }
}
