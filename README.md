# @apexfusion/agent-sdk

TypeScript Agent SDK for the Vector blockchain (Apex Fusion L2). Built on Lucid Evolution + Ogmios.

## Quick Start

```typescript
import { VectorAgent } from '@apexfusion/agent-sdk';

const agent = new VectorAgent({
  mnemonic: 'your fifteen word mnemonic phrase here ...',
});

const address = await agent.getAddress();
const balance = await agent.getBalance();
const tx = await agent.send({ to: 'addr1...', ada: 5 });

await agent.close();
```

## Installation

```bash
npm install @apexfusion/agent-sdk
```

## Features

- **Wallet management** — HD wallets (BIP39 mnemonic) and cardano-cli signing keys
- **Balance & UTxO queries** — ADA and native token balances
- **Transactions** — send ADA, send tokens, multi-output, dry-run
- **Smart contracts** — deploy and interact with Plutus/Aiken contracts
- **Agent registry** — on-chain agent registration, discovery, messaging
- **Safety controls** — per-transaction and daily spend limits, audit logging
- **Rate limiting** — sliding window rate limiter

## Configuration

Configuration is resolved from constructor params, then environment variables, then defaults:

```typescript
const agent = new VectorAgent({
  ogmiosUrl: 'https://ogmios.vector.testnet.apexfusion.org',
  submitUrl: 'https://submit.vector.testnet.apexfusion.org/api/submit/tx',
  koiosUrl: 'https://koios.vector.testnet.apexfusion.org/',
  explorerUrl: 'https://vector.testnet.apexscan.org',
  mnemonic: process.env.VECTOR_MNEMONIC,
  accountIndex: 0,
  spendLimitPerTx: 100_000_000,  // 100 ADA
  spendLimitDaily: 500_000_000,  // 500 ADA
});
```

Environment variables: `VECTOR_OGMIOS_URL`, `VECTOR_SUBMIT_URL`, `VECTOR_KOIOS_URL`, `VECTOR_EXPLORER_URL`, `VECTOR_MNEMONIC`, `VECTOR_SKEY_PATH`, `VECTOR_ACCOUNT_INDEX`, `VECTOR_SPEND_LIMIT_PER_TX`, `VECTOR_SPEND_LIMIT_DAILY`.

## API

### Queries

```typescript
await agent.getAddress()
await agent.getBalance(address?)
await agent.getUtxos(address?)
await agent.getProtocolParameters()
await agent.getSpendLimits()
```

### Transactions

```typescript
await agent.send({ to, lovelace?, ada?, metadata? })
await agent.sendTokens({ to, policyId, assetName, quantity, ada? })
await agent.dryRun({ to, lovelace?, ada? })
await agent.buildTransaction({ outputs, metadata?, submit? })
await agent.getTransactionHistory({ address?, limit?, offset? })
```

### Smart Contracts

```typescript
await agent.deployContract({ scriptCbor, scriptType?, initialDatum?, lovelace? })
await agent.interactContract({ scriptCbor, scriptType?, action?, redeemer?, datum?, lovelace?, utxoRef? })
```

### Agent Registry

```typescript
await agent.registerAgent({ name, description, capabilities, framework, endpoint })
await agent.discoverAgents({ capability?, framework?, limit? })
await agent.getAgentProfile(agentId)
await agent.updateAgent(agentId, { name?, description?, capabilities?, framework?, endpoint? })
await agent.deregisterAgent(agentId)
await agent.transferAgent(agentId, newOwnerAddress)
await agent.messageAgent(agentId, { type, payload })
```

## Advanced Usage

Sub-modules are exported for direct access:

```typescript
import { OgmiosProvider, SafetyLayer, HDWallet, SkeyWallet, AgentRegistry } from '@apexfusion/agent-sdk';
```

## License

MIT
