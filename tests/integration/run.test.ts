import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { VectorAgent } from '../../src/index.js';
import { getMnemonic, wait, tryOrSkipIfUnfunded } from './setup.js';

// Always-succeeds PlutusV2 validator (accepts any datum/redeemer/context)
const ALWAYS_SUCCEEDS_V2 = '49480100002221200101';
const TX_HASH_RE = /^[a-f0-9]{64}$/;
const HEX56_RE = /^[a-f0-9]{56}$/;

let agent: VectorAgent;
let walletAddress: string;
let walletHasAda = false;
let walletBalanceAda = 0;
let agentDid: string | null = null;

beforeAll(() => {
  const mnemonic = getMnemonic();
  agent = new VectorAgent({ mnemonic });
});

afterAll(async () => {
  await agent.close();
});

// ─── Wallet & Query Tests ──────────────────────────────────────────────────

describe.sequential('Wallet & Query Tests', () => {
  test('getAddress', { timeout: 120_000 }, async () => {
    walletAddress = await agent.getAddress();
    expect(walletAddress).toMatch(/^addr1/);
    console.log(`Wallet address: ${walletAddress}`);
  });

  test('getBalance', { timeout: 120_000 }, async () => {
    const balance = await agent.getBalance();
    expect(balance.address).toBe(walletAddress);
    expect(typeof balance.ada).toBe('string');
    expect(typeof balance.lovelace).toBe('bigint');
    expect(Array.isArray(balance.tokens)).toBe(true);

    const ada = parseFloat(balance.ada);
    if (ada > 0) {
      walletHasAda = true;
      walletBalanceAda = ada;
      console.log(`Wallet funded: ${balance.ada} ADA`);
    } else {
      console.log('Wallet has 0 ADA -- transaction tests will verify error handling');
    }
  });

  test('getUtxos', { timeout: 120_000 }, async () => {
    const utxos = await agent.getUtxos();
    expect(Array.isArray(utxos)).toBe(true);
    if (walletHasAda) {
      expect(utxos.length).toBeGreaterThan(0);
    }
    console.log(`UTxO count: ${utxos.length}`);
  });

  test('getProtocolParameters', { timeout: 120_000 }, async () => {
    const pp = await agent.getProtocolParameters();
    expect(pp).toBeDefined();
    expect(typeof pp.minFeeA).toBe('number');
    expect(typeof pp.maxTxSize).toBe('number');
    expect(pp.maxTxSize).toBeGreaterThan(0);
  });

  test('getSpendLimits', { timeout: 120_000 }, async () => {
    const limits = await agent.getSpendLimits();
    expect(limits.perTransactionLimit).toBeGreaterThan(0);
    expect(limits.dailyLimit).toBeGreaterThan(0);
    expect(typeof limits.dailySpent).toBe('number');
    expect(typeof limits.dailyRemaining).toBe('number');
    expect(typeof limits.resetTime).toBe('string');
  });
});

// ─── Transaction History ───────────────────────────────────────────────────

describe.sequential('Transaction History', () => {
  test('getTransactionHistory', { timeout: 120_000 }, async () => {
    const history = await agent.getTransactionHistory({ limit: 5 });
    expect(Array.isArray(history)).toBe(true);
    if (history.length > 0) {
      expect(history[0]).toHaveProperty('txHash');
      expect(history[0]).toHaveProperty('blockHeight');
      expect(history[0]).toHaveProperty('blockTime');
      expect(history[0]).toHaveProperty('fee');
    }
    console.log(`Transaction history: ${history.length} entries`);
  });
});

// ─── UTxO Consolidation ───────────────────────────────────────────────────

describe.sequential('UTxO Consolidation', () => {
  test('consolidate wallet UTxOs', { timeout: 120_000 }, async () => {
    if (!walletHasAda) return;
    const utxos = await agent.getUtxos();
    if (utxos.length <= 3) {
      console.log(`Only ${utxos.length} UTxO(s) -- no consolidation needed`);
      return;
    }
    // Cap at 95 ADA to stay within default 100 ADA per-tx spend limit
    const consolidateAmount = Math.min(Math.floor(walletBalanceAda) - 2, 95);
    if (consolidateAmount < 2) {
      console.log(`Balance too low (${walletBalanceAda} ADA) to consolidate`);
      return;
    }
    console.log(`${utxos.length} UTxOs -- consolidating ${consolidateAmount} ADA to self...`);
    const result = await tryOrSkipIfUnfunded('consolidate', () =>
      agent.send({ to: walletAddress, ada: consolidateAmount })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      console.log('Waiting 10s for consolidation tx...');
      await wait(10);
    }
  });
});

// ─── Transaction Tests ────────────────────────────────────────────────────

describe.sequential('Transaction Tests', () => {
  test('dryRun', { timeout: 120_000 }, async () => {
    const result = await agent.dryRun({ to: walletAddress, lovelace: 2_000_000 });
    if (walletHasAda) {
      expect(result.valid).toBe(true);
      expect(result.feeLovelace).toBeGreaterThan(0);
    } else {
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  test('buildTransaction (unsigned)', { timeout: 120_000 }, async () => {
    const result = await tryOrSkipIfUnfunded('buildTx unsigned', () =>
      agent.buildTransaction({
        outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
        submit: false,
      })
    );
    if (result) {
      expect(result.txCbor.length).toBeGreaterThan(0);
      expect(result.submitted).toBe(false);
      expect(result.outputCount).toBe(1);
      expect(result.feeLovelace).toBeGreaterThan(0);
    }
  });

  test('buildTransaction (submit)', { timeout: 120_000 }, async () => {
    const result = await tryOrSkipIfUnfunded('buildTx submit', () =>
      agent.buildTransaction({
        outputs: [{ address: walletAddress, lovelace: 2_000_000 }],
        submit: true,
      })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.submitted).toBe(true);
      expect(result.explorerUrl).toContain(result.txHash);
      console.log('Waiting 10s for UTxOs to settle...');
      await wait(10);
    }
  });

  test('send', { timeout: 120_000 }, async () => {
    const result = await tryOrSkipIfUnfunded('send', () =>
      agent.send({ to: walletAddress, ada: 2 })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.sender).toMatch(/^addr1/);
      expect(result.recipient).toBe(walletAddress);
      expect(result.amountLovelace).toBe(2_000_000);
      console.log('Waiting 10s for UTxOs to settle...');
      await wait(10);
    }
  });

  test('sendTokens', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle...');
      await wait(10);
    }
    // Uses a fake policy ID -- will fail with known error (token not in wallet)
    const result = await tryOrSkipIfUnfunded('sendTokens', () =>
      agent.sendTokens({
        to: walletAddress,
        policyId: 'a'.repeat(56),
        assetName: 'test',
        quantity: 1,
      })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.policyId).toBe('a'.repeat(56));
    }
  });
});

// ─── Smart Contract Tests ─────────────────────────────────────────────────

describe.sequential('Smart Contract Tests', () => {
  test('deployContract', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before deploy...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('deployContract', () =>
      agent.deployContract({
        scriptCbor: ALWAYS_SUCCEEDS_V2,
        scriptType: 'PlutusV2',
      })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.scriptAddress).toMatch(/^addr1/);
      expect(result.scriptHash).toMatch(HEX56_RE);
      expect(result.scriptType).toBe('PlutusV2');
    }
  });

  test('interactContract (lock)', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for deploy tx to confirm...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('interactContract lock', () =>
      agent.interactContract({
        scriptCbor: ALWAYS_SUCCEEDS_V2,
        scriptType: 'PlutusV2',
        action: 'lock',
        datum: 'd87980',
        lovelace: 2_000_000,
      })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.action).toBe('lock');
      expect(result.scriptAddress).toMatch(/^addr1/);
    }
  });

  test('interactContract (spend)', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for lock tx to confirm...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('interactContract spend', () =>
      agent.interactContract({
        scriptCbor: ALWAYS_SUCCEEDS_V2,
        scriptType: 'PlutusV2',
        action: 'spend',
        redeemer: 'd87980',
      })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.action).toBe('spend');
    }
  });
});

// ─── Agent Registry Tests ─────────────────────────────────────────────────

describe.sequential('Agent Registry Tests', () => {
  test('registerAgent', { timeout: 120_000 }, async () => {
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before register...');
      await wait(10);
    }
    const timestamp = Date.now();
    const result = await tryOrSkipIfUnfunded('registerAgent', () =>
      agent.registerAgent({
        name: `TestAgent-${timestamp}`,
        description: 'Integration test agent',
        capabilities: ['testing'],
        framework: 'custom',
        endpoint: '',
      })
    );
    if (result) {
      expect(result.agentId).toMatch(/^did:vector:agent:/);
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.nftAssetName).toBeDefined();
      agentDid = result.agentId;
      console.log(`Registered agent DID: ${agentDid}`);
    }
  });

  test('discoverAgents', { timeout: 120_000 }, async () => {
    if (walletHasAda && agentDid) {
      console.log('Waiting 10s for agent registration to confirm...');
      await wait(10);
    }
    const agents = await agent.discoverAgents();
    expect(Array.isArray(agents)).toBe(true);
    if (agents.length > 0) {
      expect(agents[0]).toHaveProperty('agentId');
      expect(agents[0]).toHaveProperty('name');
      expect(agents[0]).toHaveProperty('capabilities');
    }
    console.log(`Discovered ${agents.length} agent(s)`);
  });

  test('getAgentProfile', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping getAgentProfile -- no agent registered');
      return;
    }
    const profile = await agent.getAgentProfile(agentDid);
    expect(profile.agentId).toBe(agentDid);
    expect(profile.name).toMatch(/^TestAgent-/);
    expect(profile.description).toBe('Integration test agent');
  });

  test('updateAgent', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping updateAgent -- no agent registered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before update...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('updateAgent', () =>
      agent.updateAgent(agentDid!, { description: 'Updated integration test agent' })
    );
    if (result) {
      expect(result.agentId).toBe(agentDid);
      expect(result.updatedFields).toContain('description');
      expect(result.txHash).toMatch(TX_HASH_RE);
    }
  });

  test('transferAgent (to self)', { timeout: 120_000 }, async () => {
    if (!agentDid || !walletAddress) {
      console.log('Skipping transferAgent -- no agent registered or no wallet address');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before transfer...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('transferAgent', () =>
      agent.transferAgent(agentDid!, walletAddress)
    );
    if (result) {
      expect(result.agentId).toBe(agentDid);
      expect(result.newOwnerAddress).toBe(walletAddress);
      expect(result.txHash).toMatch(TX_HASH_RE);
    }
  });

  test('messageAgent', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping messageAgent -- no agent registered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before message...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('messageAgent', () =>
      agent.messageAgent(agentDid!, { type: 'inquiry', payload: 'integration test ping' })
    );
    if (result) {
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.messageType).toBe('inquiry');
      expect(result.recipientAddress).toMatch(/^addr1/);
    }
  });

  test('deregisterAgent', { timeout: 120_000 }, async () => {
    if (!agentDid) {
      console.log('Skipping deregisterAgent -- no agent registered');
      return;
    }
    if (walletHasAda) {
      console.log('Waiting 10s for UTxOs to settle before deregister...');
      await wait(10);
    }
    const result = await tryOrSkipIfUnfunded('deregisterAgent', () =>
      agent.deregisterAgent(agentDid!)
    );
    if (result) {
      expect(result.agentId).toBe(agentDid);
      expect(result.txHash).toMatch(TX_HASH_RE);
      expect(result.depositReturned).toMatch(/^\d+\.\d+$/);
    }
  });
});
