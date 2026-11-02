import * as ed from '@noble/ed25519';
import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_SET,
  decodeIdentityDatum,
  ed25519Key,
  IdentityConfigError,
  IdentityContext,
  identityConfig,
  IdentityRegistry,
  IdentityLookupError,
  IdentityRuleError,
  keyHashSigner,
  missingSigners,
  module1Signer,
  PartySpec,
  PURPOSE_AUTHENTICATION,
  PURPOSE_TRANSACTION,
  signTransaction,
  transactionId,
  vectorIdFromSeed,
  type Key,
  type UnsignedTx,
} from '../../src/index.js';
import { hexToBytes } from '../../src/identity/vendor.js';
import { AP3X, fund, readTx, refKey, testWallet, type TestWallet } from '../support/identity.js';
import { createWorld, type World } from '../support/world.js';

const controllerParty = new PartySpec({ role: 'Accountable', signer: CONTROLLER_SET });

async function registerRoot(world: World, label: string, extra: { keys?: Key[]; capabilities?: string[] } = {}): Promise<{ id: string; controller: TestWallet; tx: UnsignedTx }> {
  const controller = testWallet(`${label} controller`);
  world.chain.add(fund(`${label} funds`, controller, 100n * AP3X));
  const tx = await world.clients.registry.register({
    fundingAddress: controller.address,
    controller: controller.publicKey,
    name: label,
    parties: [controllerParty],
    keys: extra.keys ?? [],
    capabilities: extra.capabilities ?? [],
  });
  world.chain.apply(tx);
  return { id: tx.id, controller, tx };
}

describe('IdentityRegistry.register', () => {
  it('builds a root record from the funding seed, with measured units and every signer', async () => {
    const world = await createWorld();
    const controller = testWallet('register controller');
    const listed = testWallet('register listed key');
    const funds = fund('register funds', controller, 100n * AP3X);
    world.chain.add(funds);
    const tx = await world.clients.registry.register({
      fundingAddress: controller.address,
      controller: controller.publicKey,
      name: 'agent one',
      description: 'a test agent',
      capabilities: ['llm.text.generate.v1'],
      parties: [controllerParty],
      keys: [ed25519Key(listed.publicKey, PURPOSE_AUTHENTICATION + PURPOSE_TRANSACTION)],
    });
    expect(tx.id).toBe(vectorIdFromSeed(funds.ref.txHash, funds.ref.index));
    expect(tx.requiredSigners).toEqual([controller.keyHash, listed.keyHash].sort());
    const record = tx.outputs[tx.recordOutput]!;
    expect(record.address).toBe(world.deployment.identity.address);
    expect(record.assets[`${world.deployment.identity.hash}${tx.id}`]).toBe(1n);
    expect(record.lovelace).toBe(10n * AP3X);
    const datum = decodeIdentityDatum(record.datumHex!);
    expect(datum.createdAt).toBe(tx.window.hi);
    expect(datum.parties[0]).toMatchObject({ role: 'Accountable', signer: CONTROLLER_SET, notBefore: tx.window.lo, rights: 3 });
    expect(tx.window.hi - tx.window.lo).toBe(960_000);
    // The units come from the evaluation (+3 %), and the reference script comes from the configuration.
    expect(world.chain.calls).toContain('evaluate');
    expect(tx.redeemers).toEqual([{ tag: 'mint', index: 0, label: 'identity Register', exUnits: { mem: 1_030_000n, steps: 412_000_000n } }]);
    expect(tx.referenceInputs.map(refKey)).toEqual([refKey(world.refs.identity.ref)]);
  });

  it('signs with caller keys only, and the body (transaction ID) never changes', async () => {
    const world = await createWorld();
    const { tx, controller } = await registerRoot(world, 'signing');
    expect(missingSigners(tx)).toEqual([controller.keyHash]);
    const signed = await signTransaction(tx, controller.privateKey);
    expect(transactionId(signed)).toBe(tx.txHash);
    expect(missingSigners(tx, signed)).toEqual([]);
    const witnessKey = hexToBytes(controller.publicKey);
    expect(witnessKey.length).toBe(32);
    // The cardano-cli skey form gives the same witness.
    expect(await signTransaction(tx, `5820${controller.privateKey}`)).toBe(signed);
    const signature = await ed.signAsync(hexToBytes(tx.txHash), hexToBytes(controller.privateKey));
    expect(signed).toContain(Buffer.from(signature).toString('hex'));
  });

  it('builds a subagent with its parent as a reference input and the parent controller as signer', async () => {
    const world = await createWorld();
    const parent = await registerRoot(world, 'parent agent');
    const child = testWallet('child controller');
    world.chain.add(fund('child funds', child, 100n * AP3X));
    const tx = await world.clients.registry.register({
      fundingAddress: child.address,
      controller: child.publicKey,
      name: 'child agent',
      parties: [controllerParty],
      parent: `did:vector:${parent.id}`,
    });
    const datum = decodeIdentityDatum(tx.outputs[tx.recordOutput]!.datumHex!);
    expect(datum.lineage).toEqual({ type: 'Subagent', parent: parent.id, parentEpoch: 0, depth: 1 });
    expect(tx.requiredSigners).toContain(parent.controller.keyHash);
    expect(readTx(tx.txCborHex).referenceInputs.map(refKey)).toContain(refKey(parent.tx.outputs[0]!.ref));
  });
});

describe('IdentityRegistry.update', () => {
  it('appoints Module-1 with a consent that withdraws the whole reward balance read from the chain', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'consent agent');
    world.chain.rewardBalances.set(world.module1, 1_234_567n);
    const record = await world.clients.registry.record(id);
    const tx = await world.clients.registry.update({
      fundingAddress: controller.address,
      agent: id,
      parties: [...record.datum.parties, new PartySpec({ role: 'Responsible', signer: module1Signer(world.module1) })],
    });
    expect(world.chain.calls).toContain(`reward:${world.module1}`);
    const body = readTx(tx.txCborHex);
    expect(body.withdrawals).toEqual([1_234_567n]);
    const configRecord = await world.ctx.configRecord();
    expect(tx.referenceInputs.map(refKey)).toEqual(expect.arrayContaining([refKey(configRecord!.utxo.ref), refKey(world.refs.module1.ref)]));
    expect(tx.redeemers.map((r) => r.label)).toEqual(['identity Update', 'Module-1 Consent']);
    const datum = decodeIdentityDatum(tx.outputs[0]!.datumHex!);
    expect(datum.parties[1]).toMatchObject({ role: 'Responsible', signer: { type: 'Script', hash: world.module1 }, rights: 1, notBefore: tx.window.lo });
    world.chain.apply(tx);

    // A later profile change keeps the Module-1 party: no consent, but the configuration record is read.
    const next = await world.clients.registry.update({ fundingAddress: controller.address, agent: id, profile: { description: 'new text' } });
    expect(readTx(next.txCborHex).withdrawals).toEqual([]);
    expect(next.referenceInputs.map(refKey)).toContain(refKey(configRecord!.utxo.ref));
  });

  it('refuses a consent when the Module-1 stake credential is not registered', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'unregistered module-1');
    world.chain.rewardBalances.delete(world.module1);
    const record = await world.clients.registry.record(id);
    await expect(world.clients.registry.update({
      fundingAddress: controller.address,
      agent: id,
      parties: [...record.datum.parties, new PartySpec({ role: 'Accountable', signer: module1Signer(world.module1) })],
    })).rejects.toBeInstanceOf(IdentityLookupError);
  });

  it('refuses an empty update and a key-hash party that does not sign is added to the signers', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'party agent');
    await expect(world.clients.registry.update({ fundingAddress: controller.address, agent: id })).rejects.toMatchObject({ reason: 'update_empty' });
    const guardian = testWallet('guardian');
    const record = await world.clients.registry.record(id);
    const tx = await world.clients.registry.update({
      fundingAddress: controller.address,
      agent: id,
      parties: [...record.datum.parties, new PartySpec({ role: 'Guardian', signer: keyHashSigner(guardian.keyHash) })],
      guardianThreshold: 1,
    });
    expect(tx.requiredSigners).toEqual([controller.keyHash, guardian.keyHash].sort());
  });
});

describe('IdentityRegistry spends', () => {
  it('suspends, unsuspends, ends subagents, revokes and reclaims', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'lifecycle agent');
    const registry = world.clients.registry;
    const suspend = await registry.suspend({ fundingAddress: controller.address, agent: id, reason: 6, durationMs: 86_400_000 });
    const held = decodeIdentityDatum(suspend.outputs[0]!.datumHex!);
    expect(held.status).toEqual({ type: 'Suspended', holds: [{ by: CONTROLLER_SET, reason: 6, since: suspend.window.lo, until: suspend.window.lo + 86_400_000 }] });
    world.chain.apply(suspend);
    world.chain.advance(120);
    const unsuspend = await registry.unsuspend({ fundingAddress: controller.address, agent: id, author: CONTROLLER_SET });
    expect(decodeIdentityDatum(unsuspend.outputs[0]!.datumHex!).status).toEqual({ type: 'Active' });
    world.chain.apply(unsuspend);
    const bump = await registry.endSubagents({ fundingAddress: controller.address, agent: id });
    expect(decodeIdentityDatum(bump.outputs[0]!.datumHex!).subagentEpoch).toBe(1);
    world.chain.apply(bump);
    const revoke = await registry.revoke({ fundingAddress: controller.address, agent: id, reason: 5 });
    const tomb = decodeIdentityDatum(revoke.outputs[0]!.datumHex!);
    expect(tomb.status).toMatchObject({ type: 'Revoked', by: CONTROLLER_SET, reason: 5, invalidFrom: null, successor: null });
    expect(tomb.keys).toEqual([]);
    world.chain.apply(revoke);
    const reclaim = await registry.reclaim({ fundingAddress: controller.address, agent: id });
    expect(reclaim.outputs[0]!.lovelace).toBeLessThan(10n * AP3X);
  });

  it('names a successor on a tombstone; the successor controller signs', async () => {
    const world = await createWorld();
    const old = await registerRoot(world, 'old agent');
    const successor = await registerRoot(world, 'successor agent');
    const retire = await world.clients.registry.retire({ fundingAddress: old.controller.address, agent: old.id });
    world.chain.apply(retire);
    const tx = await world.clients.registry.setSuccessor({ fundingAddress: old.controller.address, agent: old.id, successor: successor.id });
    expect(tx.requiredSigners).toContain(successor.controller.keyHash);
    expect(decodeIdentityDatum(tx.outputs[0]!.datumHex!).status).toMatchObject({ type: 'Retired', successor: successor.id });
  });

  it('starts and cancels a recovery with guardians', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'recovery agent');
    const guardian = testWallet('recovery guardian');
    const record = await world.clients.registry.record(id);
    const update = await world.clients.registry.update({
      fundingAddress: controller.address,
      agent: id,
      parties: [...record.datum.parties, new PartySpec({ role: 'Guardian', signer: keyHashSigner(guardian.keyHash) })],
      guardianThreshold: 1,
    });
    world.chain.apply(update);
    world.chain.advance(60);
    const newController = testWallet('recovered controller');
    world.chain.add(fund('guardian funds', guardian, 50n * AP3X));
    const init = await world.clients.registry.startRecovery({ fundingAddress: guardian.address, agent: id, guardians: [1], newController: newController.publicKey });
    expect(init.requiredSigners).toEqual([guardian.keyHash, newController.keyHash].sort());
    const pending = decodeIdentityDatum(init.outputs[0]!.datumHex!).pendingRecovery;
    expect(pending).toEqual({ newController: newController.publicKey, effectiveAfter: init.window.hi + 7 * 86_400_000 });
    world.chain.apply(init);
    const cancel = await world.clients.registry.cancelRecovery({ fundingAddress: guardian.address, agent: id, guardians: [1] });
    expect(decodeIdentityDatum(cancel.outputs[0]!.datumHex!).pendingRecovery).toBeNull();
    await expect(world.clients.registry.completeRecovery({ fundingAddress: guardian.address, agent: id })).rejects.toMatchObject({ reason: 'recovery_too_early' });
  });

  it('refuses a Module-1 suspension, which needs a verdict application', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'verdict agent');
    const record = await world.clients.registry.record(id);
    const consent = await world.clients.registry.update({
      fundingAddress: controller.address,
      agent: id,
      parties: [...record.datum.parties, new PartySpec({ role: 'Accountable', signer: module1Signer(world.module1) })],
    });
    world.chain.apply(consent);
    await expect(world.clients.registry.suspend({ fundingAddress: controller.address, agent: id, reason: 6, durationMs: 3_600_000, byParty: 1 }))
      .rejects.toBeInstanceOf(IdentityRuleError);
  });
});

describe('IdentityRegistry reads and configuration', () => {
  it('finds records by identifier or DID and reports missing records', async () => {
    const world = await createWorld();
    const { id } = await registerRoot(world, 'read agent');
    expect((await world.clients.registry.record(id)).id).toBe(id);
    expect((await world.clients.registry.record(`did:vector:${id}`)).id).toBe(id);
    await expect(world.clients.registry.record('00'.repeat(32))).rejects.toBeInstanceOf(IdentityLookupError);
    expect(await world.clients.registry.findRecord('00'.repeat(32))).toBeNull();
  });

  it('gives the next identifier of a funding address', async () => {
    const world = await createWorld();
    const wallet = testWallet('next id');
    const a = fund('next id a', wallet, 20n * AP3X);
    const b = fund('next id b', wallet, 20n * AP3X);
    world.chain.add(a, b);
    const lowest = [a, b].sort((x, y) => (x.ref.txHash < y.ref.txHash ? -1 : 1))[0]!;
    expect(await world.clients.registry.nextIdentifier(wallet.address)).toEqual({ seed: lowest.ref, vectorId: vectorIdFromSeed(lowest.ref.txHash, lowest.ref.index) });
  });

  it('needs VECTOR_MODULE1_REF_UTXO for a consent', async () => {
    const world = await createWorld();
    const { id, controller } = await registerRoot(world, 'no module-1 ref');
    const record = await world.clients.registry.record(id);
    const config = identityConfig({ ...world.ctx.config, module1Ref: null }, {});
    const registry = new IdentityRegistry(new IdentityContext({ chain: world.chain, config }));
    await expect(registry.update({
      fundingAddress: controller.address,
      agent: id,
      parties: [...record.datum.parties, new PartySpec({ role: 'Accountable', signer: module1Signer(world.module1) })],
    })).rejects.toBeInstanceOf(IdentityConfigError);
  });
});
