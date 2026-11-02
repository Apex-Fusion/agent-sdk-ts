# Vendored files

Do not edit these files by hand. `scripts/sync-identity.mjs` copies them unchanged from
agents-marketplace and writes this table. `tests/unit/vendored.test.ts` checks the table
against the files in both directions.

| Field | Value |
|---|---|
| Source | https://github.com/Apex-Fusion/agents-marketplace |
| Commit | `d786fff5589bbef19943a90613531d2eb0111626` |
| Commit date | 2026-11-02T19:03:39+01:00 |
| Local changes in the copied files | none |
| Command | `node scripts/sync-identity.mjs <agents-marketplace path>` |

Runtime copies live below `src/vendor/agents-marketplace/`; test copies live below `tests/vendor/agents-marketplace/`.
Each copy keeps its source path below its vendor root.

| File | Source path | SHA-256 |
|---|---|---|
| `src/vendor/agents-marketplace/contracts/identity-marketplace/plutus.json` | `contracts/identity-marketplace/plutus.json` | `0d4e3ec1ba3982c4e4e60c29045cd9a0fd554ec3ee598ca77fbabeb85723f7c3` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/AdvertDatum.ts` | `packages/shared/src/cbor/AdvertDatum.ts` | `0bdbde4a816a62e453b4053e07fec72a480e1af08c58e0de890562c39fa9f134` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/Attestation.ts` | `packages/shared/src/cbor/Attestation.ts` | `61834ba3b5710a103d0d50e1a143bae55256399d63551bf50e37cca5543b70fc` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/Delegation.ts` | `packages/shared/src/cbor/Delegation.ts` | `41f776d1910a55972fa218208c25abd9873cfb26958074fc824c449a371be86e` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/EscrowDatum.ts` | `packages/shared/src/cbor/EscrowDatum.ts` | `bb79b5a8eacc9d8462cdb0b30f10acb8bbb7a801c27bfc503710f37b1697a74e` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/IdentityAdvertDatum.ts` | `packages/shared/src/cbor/IdentityAdvertDatum.ts` | `dae22833abbcaaace71eb49ff23cb9b912ff07b4bd5940c2c9e8a7bcd8a7c8ec` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/IdentityDatum.ts` | `packages/shared/src/cbor/IdentityDatum.ts` | `146b6d92782f1163ae20a27de51d287465049222227f7e8fc5eae5a4d4ccc9b3` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/IdentityEscrowDatum.ts` | `packages/shared/src/cbor/IdentityEscrowDatum.ts` | `4320da8ddc63a5773b7be91b0a84c62f998ee7597757ed59565d2bedab9c4bd8` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/IdentityRedeemer.ts` | `packages/shared/src/cbor/IdentityRedeemer.ts` | `71853a8846e7f6ca56c79be34b1873036384e2a4ff4f89fb007b2a5a1bb05bc5` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/address.ts` | `packages/shared/src/cbor/address.ts` | `e1c526bb9bc19f38302901fce49c3128106d1b09e85f4b9146567626e6d0d7af` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/canonical.ts` | `packages/shared/src/cbor/canonical.ts` | `d6fffed13a7b26b9c73cfb1dca152f1afa98b5c0d9655f0ce3d6dd7242ffe258` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/plutus-data.ts` | `packages/shared/src/cbor/plutus-data.ts` | `b9e9e1ffcba946ceeddf711547c0a7d57c4e0a316119eb0bf523a3f441844d4e` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/plutus-encoder.ts` | `packages/shared/src/cbor/plutus-encoder.ts` | `cb9257c14b0edb6729ef5b988e77c47f1b0169361337aeffc64000c10a168482` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/plutus-schema.ts` | `packages/shared/src/cbor/plutus-schema.ts` | `e02ee3bdbaa5e6e73a31b05e642083a65fdc85453040db7783eef3bf6902ed55` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/plutus-tag.ts` | `packages/shared/src/cbor/plutus-tag.ts` | `8ae078761ecf3c0ed744612ed22b7f1d603267c72efb61cd4612e40fc6672faa` |
| `src/vendor/agents-marketplace/packages/shared/src/cbor/types.ts` | `packages/shared/src/cbor/types.ts` | `d5df3c3bc3f66df3a6888d60896f2f9b0fa79f8c0de28d8fafb588f29521449e` |
| `src/vendor/agents-marketplace/packages/shared/src/chain/ChainProvider.ts` | `packages/shared/src/chain/ChainProvider.ts` | `f4c0c20c023fc8caad4bcba681fa82577d173c30eeec360836f2ab843b836d03` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/allowlist.ts` | `packages/shared/src/identity/allowlist.ts` | `21dfb1fc2373503db99140c81560d2143a55fc7cc05caa51b095ab85b4671667` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/constants.ts` | `packages/shared/src/identity/constants.ts` | `2774f2b816a3e84aaa9a99424a0872f1d819f2c5a28cdb53fec30743b87e7172` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/id.ts` | `packages/shared/src/identity/id.ts` | `4cb0dfb0da048bd77f1c508b1e4a42027a072e6e9676f7da2741592e680b09be` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/index.ts` | `packages/shared/src/identity/index.ts` | `59b32a7bc2ab9922d13933aa24eeb0d50139003bcef27b97433eb72f0d59b1ce` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/attestation.ts` | `packages/shared/src/identity/tx/attestation.ts` | `75cdcacf4047321bf23b313123920f469c7b285f5fed4081ad9f1a51e4865459` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/cbor.ts` | `packages/shared/src/identity/tx/cbor.ts` | `35465852520373da2806a9c3c7c894560feb808233ae8aee9fd6a45be392d99c` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/complete.ts` | `packages/shared/src/identity/tx/complete.ts` | `e136607e1ee00ec0bcb1719d2954a4ae33d96179d2b65979918043f36c866ebb` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/config.ts` | `packages/shared/src/identity/tx/config.ts` | `f14be4012210b2843d34139117ad9abd9909d610a4c40ab7aa89f19521110594` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/delegation.ts` | `packages/shared/src/identity/tx/delegation.ts` | `3479467174be4f4ea8fe4e459ad4893d4024e7a32074fcf77fa7cce363e8518e` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/identity.ts` | `packages/shared/src/identity/tx/identity.ts` | `49e97a33fdf53130dcc1b1fb8a6c53890c7e55b4e6a6db59f0dc9bbf3696f43f` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/index.ts` | `packages/shared/src/identity/tx/index.ts` | `a081fb2759d409b8229588b1dc632abfd3e1d9303c417bada4316982dca04d25` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/ledger.ts` | `packages/shared/src/identity/tx/ledger.ts` | `c8f12af21380d365ec3fc6ed1ccc9044db96f1f01cc0d7696ab461b0548abb01` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/pop.ts` | `packages/shared/src/identity/tx/pop.ts` | `1587cda2002e9271bd48f25466645c0740552a5ac554b97af23cbdf059e7d2ed` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/records.ts` | `packages/shared/src/identity/tx/records.ts` | `328badbeb6230d9101f009646ef94cfdde8ffd94f353fb66ff4a0c2bc12f3215` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/types.ts` | `packages/shared/src/identity/tx/types.ts` | `205aa69dfda0a88eb6e88d9663a46b28258f7ee015d7258041dd20274337c215` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/vault.ts` | `packages/shared/src/identity/tx/vault.ts` | `ef87f2ecba4c69063b1f3f45b350a0e36b767b226b2405e00ba3be517897250f` |
| `src/vendor/agents-marketplace/packages/shared/src/identity/tx/witness.ts` | `packages/shared/src/identity/tx/witness.ts` | `83992f65311805a906d70ad59e7d76972c65be8c4c7b08add7cbfcbc3e56aad2` |
| `src/vendor/agents-marketplace/packages/shared/src/network.ts` | `packages/shared/src/network.ts` | `be2e1af7105372c672473ddc4db0fe89a18c7b7a3ade5a6070966d562fa6fe7e` |
| `src/vendor/agents-marketplace/packages/shared/src/tx/types.ts` | `packages/shared/src/tx/types.ts` | `7dfe647312c71996c01fa0b3f3641f6133d58477aca772cf63f597e50d16db87` |
| `src/vendor/agents-marketplace/tests/legacy-registry/fixtures/agent-registry.plutus.json` | `tests/legacy-registry/fixtures/agent-registry.plutus.json` | `00eb21bf150b9f4ee4ded0b7a7c4779d91284cf795bde653d5702355520ad215` |
| `tests/vendor/agents-marketplace/tests/legacy-registry/harness/blueprint.ts` | `tests/legacy-registry/harness/blueprint.ts` | `8084d6c90fed68753c791a2ab84a3a62d6b86f0c2154819c72ac93ea76470de7` |
| `tests/vendor/agents-marketplace/tests/legacy-registry/harness/cbor.ts` | `tests/legacy-registry/harness/cbor.ts` | `9ae35219769a115fa43f71cf82d159f3964380975db3408c9b881abaca018e46` |
| `tests/vendor/agents-marketplace/tests/legacy-registry/harness/data.ts` | `tests/legacy-registry/harness/data.ts` | `6858cd26fc33ed70860763e682ac122fdff383118ead6adaa8967fff4d8d4d24` |
| `tests/vendor/agents-marketplace/tests/legacy-registry/harness/ledger.ts` | `tests/legacy-registry/harness/ledger.ts` | `1ecd4b6601d3dcf429777d63643a37cf44ce2103b460373229900d066830ac0c` |
| `tests/vendor/agents-marketplace/tests/legacy-registry/harness/simulate.ts` | `tests/legacy-registry/harness/simulate.ts` | `6d607c4c3ea1c58b56643c2752301246c123bbf781db1cdb17fc1e62ab7e011e` |
