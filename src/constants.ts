import legacyBlueprint from './vendor/agents-marketplace/tests/legacy-registry/fixtures/agent-registry.plutus.json';

// ─── Legacy registry (did:vector Part 1 §4) ─────────────────────────

// The JSON import is typed from the file itself (resolveJsonModule).
const legacyValidator = legacyBlueprint.validators.find((v) => v.title === 'registry.registry.mint');
if (legacyValidator === undefined) throw new Error('the vendored legacy registry blueprint has no registry.registry.mint');

/**
 * The deployed legacy registry script (Plutus V3): one script for the mint
 * policy and the spend. Source: the vendored deployed blueprint
 * (`tests/legacy-registry/fixtures/agent-registry.plutus.json` of
 * agents-marketplace, a byte copy of the deployed blueprint).
 */
export const REGISTRY_SCRIPT_CBOR: string = legacyValidator.compiledCode;

/** The policy ID (= script hash) of the legacy registry on Vector mainnet. */
export const REGISTRY_POLICY_ID = 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';

/** The address of the legacy registry: the script as payment credential and no stake credential. */
export const REGISTRY_ADDRESS = 'addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42';

/** The deposit of a legacy record, and the least AP3X that a legacy Deregister returns to the owner key. */
export const MIN_AP3X_DEPOSIT = 10_000_000n;

export const AGENT_MESSAGE_LABEL = 674;

// ─── Default URLs (Vector mainnet) ──────────────────────────────────

export const DEFAULT_OGMIOS_URL = 'https://ogmios.vector.mainnet.apexfusion.org';
export const DEFAULT_SUBMIT_URL = 'https://submit.vector.mainnet.apexfusion.org/api/submit/tx';
export const DEFAULT_KOIOS_URL = 'https://v2.koios.vector.mainnet.apexfusion.org/';
export const DEFAULT_EXPLORER_URL = 'https://vector.apexscan.org/en';
/** The public identity gateway (DID resolution, Part 1 §7.4). */
export const DEFAULT_IDENTITY_GATEWAY_URL = 'https://id.vector.apexfusion.org';

// ─── Default Limits ─────────────────────────────────────────────────

export const DEFAULT_PER_TX_LIMIT = 100_000_000; // 100 AP3X
export const DEFAULT_DAILY_LIMIT = 500_000_000;  // 500 AP3X
