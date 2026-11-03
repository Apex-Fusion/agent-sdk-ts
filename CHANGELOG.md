# Changelog

## 0.2.0 (unreleased)

This release adds the clients of the Vector identity registry (`did:vector`). It has breaking changes.

### Breaking changes

- **Mainnet is the default.** The default endpoints are now Vector mainnet: `DEFAULT_OGMIOS_URL` `https://ogmios.vector.mainnet.apexfusion.org`, `DEFAULT_SUBMIT_URL` `https://submit.vector.mainnet.apexfusion.org/api/submit/tx`, `DEFAULT_KOIOS_URL` `https://v2.koios.vector.mainnet.apexfusion.org/` and `DEFAULT_EXPLORER_URL` `https://vector.apexscan.org/en`. Set `VECTOR_OGMIOS_URL`, `VECTOR_SUBMIT_URL`, `VECTOR_KOIOS_URL` and `VECTOR_EXPLORER_URL` to use the testnet.
- **The legacy registry is the deployed registry.** `REGISTRY_POLICY_ID` is now `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` (did:vector Part 1 §4), and the legacy script comes from the deployed blueprint. Before, the SDK used the test registry `5dd51189…`, which is not supported: its DIDs resolve as `NOT_FOUND`.
- **New legacy registrations are deprecated.** `VectorAgent.registerAgent`, `AgentRegistry.register` and `AgentRegistrationResult` are marked `@deprecated`. Use `IdentityRegistry.register`. The legacy functions stay until the switch date; the legacy reads (`discoverAgents`, `getAgentProfile`) and the legacy Update, transfer and Deregister still work.
- **Node.js 20 or later.** Node.js 18 is end-of-life. The identity signing helpers use the Web Crypto API (`globalThis.crypto`).
- **`OgmiosProvider` implements `IdentityChain`.** It has new methods, and it reads Ogmios v6 reference scripts (`script.language`, `script.cbor`), which it dropped before.

### Added

- **Identity clients** over the transaction builders of agents-marketplace (vendored unchanged, see `VENDORED-FROM.md`):
  - `IdentityRegistry`: register (also subagents), adopt, update, change controller, suspend, unsuspend, revoke, retire, reclaim, set successor, start, cancel and complete recovery, end subagents; record reads, `resolve`, `currentRecord`, `nextIdentifier`.
  - `Attestations`: attest (with the COSE_Sign1 envelope of Part 2 §4.2), revoke, contest, withdraw.
  - `Delegations`: delegate, undelegate, the use checks; a delegate key that another live delegation uses is refused.
  - `Vaults`: open, pay (from a listed new advert; each escrow output holds exactly payment and both bonds), close.
  - `IdentityGateway`: DID resolution with `versionId` and `versionTime`, and the current record (`AgentView`).
- **Builders return unsigned transactions** with every key hash that must sign. `signTransaction`, `addVKeyWitnesses`, `missingSigners` and `VectorAgent.signTransaction` add witnesses without changing the body. The SDK never stores keys.
- **Chain reads** for every build: protocol parameters with the Plutus V3 cost model, the funding outputs, the tip and, for a Module-1 consent, the reward balance of Module-1 (the consent withdraws the whole balance). The reward balance comes from Ogmios. Ogmios gives no summary for a registered stake credential without delegation, and Module-1 has no delegation: the balance then comes from Koios `account_info`. Each transaction is evaluated with Ogmios and built again with the measured units.
- **Configuration** with the environment names of the Python SDK: `VECTOR_IDENTITY_NETWORK`, `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_POLICY_ID`, `VECTOR_IDENTITY_LEGACY_HASH`, `VECTOR_IDENTITY_REF_UTXO`, `VECTOR_ATTESTATION_REF_UTXO`, `VECTOR_DELEGATION_REF_UTXO`, `VECTOR_VAULT_REF_UTXO`, `VECTOR_LEGACY_REGISTRY_REF_UTXO`, `VECTOR_MODULE1_REF_UTXO`, `VECTOR_IDENTITY_CONFIG_UTXO`, `VECTOR_IDENTITY_GATEWAY_URL`, `VECTOR_KOIOS_TOKEN` and `VECTOR_MARKETPLACE_INDEXER_URL`.
- **Mainnet defaults.** `MAINNET_IDENTITY_DEPLOYMENT` holds the published values of the identity registry on Vector mainnet (live since 2026-11-03; agents-marketplace 4c95c3f, `contracts/identity-marketplace/deploy/mainnet/deployment.json`): the allowlist root `e4b6b17c…`, the configuration seed `6c9856c7…#0`, the identity policy ID `d958b823…`, the legacy hash `be1a0a29…` and the reference outputs of `identity`, `attestation`, `delegation`, `vault`, `escrow` and `advert`. On mainnet (`VECTOR_IDENTITY_NETWORK`, default `mainnet`), `identityConfig` uses them for unset values, so the clients work without settings. A value that you set always wins. The root and the seed apply only together. The published policy ID and reference outputs apply only when the legacy hash, the root and the seed are the published values. The SDK derives the policy ID and compares it with the published value before it uses a script. On the testnet (`VECTOR_IDENTITY_NETWORK=testnet`), no deployment value has a default. The Module-1 values (M1, its reference output and the configuration record) come with the seal.
- `scripts/sync-identity.mjs` copies the builders, codecs, blueprints and test harness from agents-marketplace and writes `VENDORED-FROM.md`.
- `VectorAgent.identity()`, `VectorAgent.signTransaction()` and `VectorAgent.submitTransaction()`.

### Fixed

- The legacy Update and transfer keep the AP3X of the record output, and the legacy Deregister pays 10 AP3X to the owner key, as the deployed legacy script requires.
- `explorerTxLink` no longer writes a double slash.

## 0.1.2 (unreleased)

- The amount parameters accept `apex` (whole AP3X) and `dfm` (smallest unit) as the preferred names; `ada` and `lovelace` stay as aliases.
- The README documents the `apex` alias of `sendTokens`.
