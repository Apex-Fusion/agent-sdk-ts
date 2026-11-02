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

Vector runs a public testnet and mainnet. Since 0.2.0 the defaults are the mainnet endpoints; set the variables below for the testnet:

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

### Identity registry (did:vector)

The identity registry holds one record per agent: a controller key, listed keys, parties, a profile and a status ([did:vector method](https://github.com/Apex-Fusion/agents-marketplace/blob/main/docs/did-vector-method.md)). The clients build **unsigned** transactions and return every key hash that must sign (`requiredSigners`). Each key holder signs in turn; the SDK never stores keys.

```typescript
import { VectorAgent, PartySpec, CONTROLLER_SET, ed25519Key, signTransaction } from '@apexfusion/agent-sdk';

const agent = new VectorAgent({ mnemonic });
const { registry, attestations, delegations, vaults, gateway, context } = agent.identity();
const fundingAddress = await agent.getAddress();

const tx = await registry.register({
  fundingAddress,                              // pays the 10 AP3X deposit and the fee
  controller: controllerPublicKeyHex,          // Ed25519, 32 bytes
  name: 'my agent',
  capabilities: ['llm.text.generate.v1'],
  parties: [new PartySpec({ role: 'Accountable', signer: CONTROLLER_SET })],
  keys: [ed25519Key(supplierPublicKeyHex, 1 + 8)], // authentication + transaction
});
let signed = await agent.signTransaction(tx);               // the wallet key (funding input)
signed = await signTransaction(signed, controllerPrivateKeyHex, supplierPrivateKeyHex);
await agent.submitTransaction(signed);
console.log(`did:vector:${tx.id}`);
```

Without a `VectorAgent`: `createIdentityClients()` (configuration from the environment) or `createIdentityClients(new IdentityContext({ chain, config }))`.

| Client | Operations |
|---|---|
| `registry` | `register` (with `parent`: a subagent), `adopt`, `update`, `changeController`, `suspend`, `unsuspend`, `revoke`, `retire`, `reclaim`, `setSuccessor`, `startRecovery`, `cancelRecovery`, `completeRecovery`, `endSubagents`; reads `record`, `findRecord`, `resolve`, `currentRecord`, `nextIdentifier` |
| `attestations` | `attest` (optional `signEnvelope` for the COSE_Sign1 envelope), `revoke`, `contest`, `withdraw`, `get` |
| `delegations` | `delegate`, `undelegate`, `checkUse`, `get`, `list` (a delegate key in use by another live delegation is refused) |
| `vaults` | `open`, `pay` (escrows copied from listed new adverts), `close`, `get`, `list` |
| `gateway` | `resolve(did, { versionId?, versionTime?, expandRelativeUrls?, documentOnly? })`, `currentRecord(idOrDid)` |

Every build reads the chain: the protocol parameters (with the Plutus V3 cost model), the funding outputs, the tip and, when Module-1 consents, the whole reward balance of Module-1. The validity range is `[tip − 60 s, tip + validForSeconds]` (default 900 s; at most one hour). Each transaction is evaluated with Ogmios and built again with the measured execution units (`evaluate: false` skips this; the fee is then about 2 AP3X). A builder that the contract would reject throws `IdentityRuleError` with a stable `reason`; a missing output throws `IdentityLookupError`; a missing setting throws `IdentityConfigError`.

Configuration (the same names as the Python SDK):

| Variable | Meaning |
|---|---|
| `VECTOR_IDENTITY_LEGACY_ROOT` | Allowlist Merkle root (required for transactions) |
| `VECTOR_IDENTITY_CONFIG_SEED` | `<tx id>#<index>` of the `config_seal` seed (required for transactions) |
| `VECTOR_IDENTITY_POLICY_ID` | Optional cross-check of the derived identity policy ID |
| `VECTOR_IDENTITY_LEGACY_HASH` | Default `be1a0a29…` |
| `VECTOR_IDENTITY_REF_UTXO`, `VECTOR_ATTESTATION_REF_UTXO`, `VECTOR_DELEGATION_REF_UTXO`, `VECTOR_VAULT_REF_UTXO`, `VECTOR_LEGACY_REGISTRY_REF_UTXO` | Reference-script outputs; without one, the transaction carries the script |
| `VECTOR_MODULE1_REF_UTXO` | Reference script of Module-1, needed when Module-1 consents |
| `VECTOR_IDENTITY_CONFIG_UTXO` | The configuration record (default: found at the `config_holder` address) |
| `VECTOR_IDENTITY_GATEWAY_URL` | Default `https://id.vector.apexfusion.org` |
| `VECTOR_KOIOS_TOKEN` | Optional Koios bearer token |
| `VECTOR_MARKETPLACE_INDEXER_URL` | Advert listing for `vaults.pay` (or pass `advertListed`) |

The builders, codecs and blueprints are vendored unchanged from agents-marketplace; `VENDORED-FROM.md` names the commit and the SHA-256 of each file. Update them with `npm run sync:identity -- <agents-marketplace path>`.

### Legacy agent registry

The legacy registry (`be1a0a29…`) stays readable. **New legacy registrations are deprecated**: legacy identifiers minted at or after the cutoff slot resolve as `NOT_FOUND`, and legacy records cannot take work through the new escrow. Adopt a legacy record with `registry.adopt(...)`.

```typescript
await agent.registerAgent({ name, description, capabilities, framework, endpoint }) // deprecated
await agent.discoverAgents({ capability?, framework?, limit? })
await agent.getAgentProfile(agentId)        // did:vector:agent:<policy>:<id> or did:vector:<id>
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
