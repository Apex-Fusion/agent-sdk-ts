# @apexfusion/agent-sdk

TypeScript Agent SDK for **Vector**, the Apex Fusion eUTXO L2. Built on Lucid Evolution + Ogmios.

**Vector mainnet is live.** Full guides: [Vector AI documentation](https://apex-fusion.github.io/vector-ai-documentation/).

## Quick Start

```typescript
import { VectorAgent } from '@apexfusion/agent-sdk';

const agent = new VectorAgent({
  mnemonic: 'your fifteen word mnemonic phrase here ...',
});

const address = await agent.getAddress();
const balance = await agent.getBalance();
const tx = await agent.send({ to: 'addr1...', apex: 5 });

await agent.close();
```

## Installation

```bash
npm install @apexfusion/agent-sdk
```

## Networks

Vector runs a public testnet and mainnet. The SDK talks to whichever endpoints you configure:

| Variable | Testnet | Mainnet |
|---|---|---|
| `VECTOR_OGMIOS_URL` | `https://ogmios.vector.testnet.apexfusion.org` | `https://ogmios.vector.mainnet.apexfusion.org` |
| `VECTOR_SUBMIT_URL` | `https://submit.vector.testnet.apexfusion.org/api/submit/tx` | `https://submit.vector.mainnet.apexfusion.org/api/submit/tx` |
| `VECTOR_KOIOS_URL` | `https://v2.koios.vector.testnet.apexfusion.org/` | `https://v2.koios.vector.mainnet.apexfusion.org/` |
| `VECTOR_EXPLORER_URL` | `https://vector.testnet.apexscan.org` | `https://vector.apexscan.org/en/` |

Two things to know: Vector's testnet uses the **mainnet network ID**, so all addresses start with `addr1`. And the native coin is **AP3X** (smallest unit DFM, 1 AP3X = 1,000,000 DFM). Since 0.1.2 the amount parameters accept `apex` (whole AP3X) and `dfm` (smallest unit) as the preferred names; `ada`/`lovelace` remain as compatibility aliases from the underlying Cardano tooling, and response fields keep their tooling names.

## Features

- **Wallet management** - HD wallets (BIP39 mnemonic) and cardano-cli signing keys
- **Balance & UTxO queries** - AP3X and native token balances
- **Transactions** - send AP3X, send tokens, multi-output, dry-run
- **Smart contracts** - deploy and interact with Plutus/Aiken contracts
- **Agent registry** - on-chain agent registration, discovery, messaging
- **Safety controls** - per-transaction and daily spend limits, audit logging
- **Rate limiting** - sliding window rate limiter

## Configuration

Configuration is resolved from constructor params, then environment variables, then defaults:

```typescript
const agent = new VectorAgent({
  ogmiosUrl: 'https://ogmios.vector.testnet.apexfusion.org',
  submitUrl: 'https://submit.vector.testnet.apexfusion.org/api/submit/tx',
  koiosUrl: 'https://v2.koios.vector.testnet.apexfusion.org/',
  explorerUrl: 'https://vector.testnet.apexscan.org',
  mnemonic: process.env.VECTOR_MNEMONIC,
  accountIndex: 0,
  spendLimitPerTx: 100_000_000,  // 100 AP3X
  spendLimitDaily: 500_000_000,  // 500 AP3X
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
await agent.send({ to, apex?, dfm?, ada?, lovelace?, metadata? })
await agent.sendTokens({ to, policyId, assetName, quantity, apex?, ada? })
await agent.dryRun({ to, apex?, dfm?, ada?, lovelace? })
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
