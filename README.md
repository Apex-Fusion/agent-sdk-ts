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

Vector runs a public testnet and mainnet. Since 0.2.0 the defaults are the mainnet endpoints and the published mainnet identity deployment; set the variables below for the testnet:

| Variable | Testnet | Mainnet |
|---|---|---|
| `VECTOR_OGMIOS_URL` | `https://ogmios.vector.testnet.apexfusion.org` | `https://ogmios.vector.mainnet.apexfusion.org` |
| `VECTOR_SUBMIT_URL` | `https://submit.vector.testnet.apexfusion.org/api/submit/tx` | `https://submit.vector.mainnet.apexfusion.org/api/submit/tx` |
| `VECTOR_KOIOS_URL` | `https://v2.koios.vector.testnet.apexfusion.org/` | `https://v2.koios.vector.mainnet.apexfusion.org/` |
| `VECTOR_EXPLORER_URL` | `https://vector.testnet.apexscan.org` | `https://vector.apexscan.org/en/` |
| `VECTOR_IDENTITY_NETWORK` | `testnet` | `mainnet` |

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

Without a `VectorAgent`: `createIdentityClients()` (configuration from the environment and the mainnet defaults) or `createIdentityClients(new IdentityContext({ chain, config }))`.

| Client | Operations |
|---|---|
| `registry` | `register` (with `parent`: a subagent), `adopt`, `update`, `changeController`, `suspend`, `unsuspend`, `revoke`, `retire`, `reclaim`, `setSuccessor`, `startRecovery`, `cancelRecovery`, `completeRecovery`, `endSubagents`; reads `record`, `findRecord`, `resolve`, `currentRecord`, `nextIdentifier` |
| `attestations` | `attest` (optional `signEnvelope` for the COSE_Sign1 envelope), `revoke`, `contest`, `withdraw`, `get` |
| `delegations` | `delegate`, `undelegate`, `checkUse`, `get`, `list` (a delegate key in use by another live delegation is refused) |
| `vaults` | `open`, `pay` (escrows copied from listed new adverts), `close`, `get`, `list` |
| `gateway` | `resolve(did, { versionId?, versionTime?, expandRelativeUrls?, documentOnly? })`, `currentRecord(idOrDid)` |

Every build reads the chain: the protocol parameters (with the Plutus V3 cost model), the funding outputs, the tip and, when Module-1 consents, the whole reward balance of Module-1. Ogmios gives no reward summary for a registered stake credential without delegation, and Module-1 has no delegation: the balance then comes from Koios `account_info`. The validity range is `[tip − 60 s, tip + validForSeconds]` (default 900 s; at most one hour). Each transaction is evaluated with Ogmios and built again with the measured execution units (`evaluate: false` skips this; the fee is then about 2 AP3X). A builder that the contract would reject throws `IdentityRuleError` with a stable `reason`; a missing output throws `IdentityLookupError`; a missing setting throws `IdentityConfigError`.

Configuration (the same names as the Python SDK). On mainnet, the default network, an unset deployment value takes the published value of `MAINNET_IDENTITY_DEPLOYMENT`: the identity side of the release, live since 2026-11-03 (agents-marketplace [`contracts/identity-marketplace/deploy/mainnet/`](https://github.com/Apex-Fusion/agents-marketplace/tree/main/contracts/identity-marketplace/deploy/mainnet)). A value that you set always wins.

| Variable | Meaning | Mainnet default |
|---|---|---|
| `VECTOR_IDENTITY_NETWORK` | `mainnet` or `testnet`. It selects the published deployment values; it does not change the endpoints | `mainnet` |
| `VECTOR_IDENTITY_LEGACY_ROOT` | Allowlist Merkle root | `e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01` |
| `VECTOR_IDENTITY_CONFIG_SEED` | `<tx id>#<index>` of the `config_seal` seed | `6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0` |
| `VECTOR_IDENTITY_POLICY_ID` | Cross-check of the derived identity policy ID | `d958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762` |
| `VECTOR_IDENTITY_LEGACY_HASH` | Legacy registry hash (default on both networks) | `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` |
| `VECTOR_IDENTITY_REF_UTXO` | Reference script of `identity` | `3d4471222e524584180a4358e05517a243effc46d15ef62443a82aaed822de46#0` |
| `VECTOR_ATTESTATION_REF_UTXO` | Reference script of `attestation` | `55dfa9e05ff96844fd4313f1c7cb7f0c7f900f1cdf50099b0e2abb242da4128d#0` |
| `VECTOR_DELEGATION_REF_UTXO` | Reference script of `delegation` | `f6d47a62146b2bc4dabc12454c8a3dbbedf673d45a6edccd1c462d55c8ba8be7#0` |
| `VECTOR_VAULT_REF_UTXO` | Reference script of `vault` | `d0bf8f73c915fcbf57ddba714256e520a9a0820bc9e643218db8cf54762d215b#0` |
| `VECTOR_LEGACY_REGISTRY_REF_UTXO` | Reference script of the legacy registry | none |
| `VECTOR_MODULE1_REF_UTXO` | Reference script of Module-1, needed when Module-1 consents | none until the seal |
| `VECTOR_IDENTITY_CONFIG_UTXO` | The configuration record (default: found at the `config_holder` address) | none |
| `VECTOR_IDENTITY_GATEWAY_URL` | Identity gateway | `https://id.vector.apexfusion.org` |
| `VECTOR_KOIOS_TOKEN` | Optional Koios bearer token | none |
| `VECTOR_MARKETPLACE_INDEXER_URL` | Advert listing for `vaults.pay` (or pass `advertListed`) | none |

The root and the seed apply together: when you set only one of them, the other gets no default, and a transaction stops with `IdentityConfigError`. The published policy ID and reference outputs apply only when the legacy hash, the root and the seed are the published values. Without a reference output, a transaction carries the script itself. The SDK derives the identity policy ID from the root and the seed and compares it with `VECTOR_IDENTITY_POLICY_ID` (or the published value) before it uses a script. On the testnet, no deployment value has a default: set `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` for transactions. `MAINNET_IDENTITY_DEPLOYMENT` also holds the `escrow` and `advert` reference outputs, which the clients of this SDK do not use. In code, `identityConfig({ network: 'testnet' })` selects the testnet, and a `null` value sets no value and no default.

The builders, codecs and blueprints are vendored unchanged from agents-marketplace. A test copy of the published mainnet deployment record (`deployment.json`) checks the mainnet defaults. `VENDORED-FROM.md` names the commit and the SHA-256 of each file. Update them with `npm run sync:identity -- <agents-marketplace path>`.

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
