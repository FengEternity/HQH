'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  getAdminState,
  requireStaff,
  requireAdminRole,
  bootstrapAdmin,
  listStaff,
  updateStaff,
  createInvite,
  claimInvite,
} = require('./adminStaff');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createMemoryDb(seed = {}) {
  const collections = new Map();
  let transactionTail = Promise.resolve();

  for (const [name, documents] of Object.entries(seed)) {
    collections.set(
      name,
      new Map(Object.entries(documents).map(([id, data]) => [id, clone(data)])),
    );
  }

  function documentsFor(name) {
    if (!collections.has(name)) {
      collections.set(name, new Map());
    }
    return collections.get(name);
  }

  function collection(name) {
    const documents = documentsFor(name);

    return {
      doc(id) {
        if (typeof id !== 'string' || !id.trim()) {
          throw new TypeError(`invalid document id: ${String(id)}`);
        }
        return {
          async get() {
            return { data: clone(documents.get(id) || null) };
          },
          async set({ data }) {
            documents.set(id, clone(data));
            return { stats: { created: 1 } };
          },
          async update({ data }) {
            if (!documents.has(id)) {
              throw new Error(`missing document: ${name}/${id}`);
            }
            documents.set(id, { ...documents.get(id), ...clone(data) });
            return { stats: { updated: 1 } };
          },
        };
      },
      where(criteria) {
        function matches(data) {
          return Object.entries(criteria).every(([key, value]) => data[key] === value);
        }

        return {
          async get() {
            return {
              data: [...documents.values()].filter(matches).map(clone),
            };
          },
          async count() {
            return {
              total: [...documents.values()].filter(matches).length,
            };
          },
          async update({ data }) {
            let updated = 0;
            for (const [id, document] of documents.entries()) {
              if (matches(document)) {
                documents.set(id, { ...document, ...clone(data) });
                updated += 1;
              }
            }
            return { stats: { updated } };
          },
        };
      },
      async get() {
        return { data: [...documents.values()].map(clone) };
      },
    };
  }

  function transactionCollection(name) {
    const documents = documentsFor(name);

    return {
      doc(id) {
        if (typeof id !== 'string' || !id.trim()) {
          throw new TypeError(`invalid document id: ${String(id)}`);
        }
        return {
          async get() {
            return { data: clone(documents.get(id) || null) };
          },
          async set({ data }) {
            documents.set(id, clone(data));
            return { stats: { created: 1 } };
          },
          async update({ data }) {
            if (!documents.has(id)) {
              throw new Error(`missing document: ${name}/${id}`);
            }
            documents.set(id, { ...documents.get(id), ...clone(data) });
            return { stats: { updated: 1 } };
          },
        };
      },
    };
  }

  return {
    collection,
    async runTransaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      const snapshot = clone(
        Object.fromEntries(
          [...collections.entries()].map(([name, documents]) => [
            name,
            Object.fromEntries(documents),
          ]),
        ),
      );
      try {
        return await callback({ collection: transactionCollection });
      } catch (error) {
        collections.clear();
        for (const [name, documents] of Object.entries(snapshot)) {
          collections.set(name, new Map(Object.entries(documents)));
        }
        throw error;
      } finally {
        release();
      }
    },
    dump(name, id) {
      return clone(documentsFor(name).get(id));
    },
  };
}

function staff(openid, role, enabled, createdAt = 1) {
  return {
    openid,
    role,
    enabled,
    createdAt,
    updatedAt: createdAt,
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

describe('adminStaff', () => {
  it('binds the first openid as admin with the correct pin', async () => {
    const db = createMemoryDb();

    const result = await bootstrapAdmin(db, {
      openid: 'first',
      pin: 'correct',
      expectedPin: 'correct',
      now: 100,
    });

    assert.deepEqual(result, staff('first', 'admin', true, 100));
    assert.deepEqual(db.dump('admin_users', 'first'), result);
    assert.deepEqual(db.dump('admin_config', 'staff'), {
      initialized: true,
      initializedAt: 100,
      initializedBy: 'first',
      enabledAdminOpenids: ['first'],
      updatedAt: 100,
    });
  });

  it('rejects bootstrap after initialization', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: { initialized: true },
      },
    });

    await assert.rejects(
      bootstrapAdmin(db, {
        openid: 'second',
        pin: 'correct',
        expectedPin: 'correct',
        now: 100,
      }),
      assertCode('ALREADY_INITIALIZED'),
    );
    assert.equal(db.dump('admin_users', 'second'), undefined);
  });

  it('rejects a bad bootstrap pin', async () => {
    const db = createMemoryDb();

    await assert.rejects(
      bootstrapAdmin(db, {
        openid: 'first',
        pin: 'wrong',
        expectedPin: 'correct',
        now: 100,
      }),
      assertCode('INVALID_PIN'),
    );
    assert.equal(db.dump('admin_config', 'staff'), undefined);
  });

  it('serializes simultaneous bootstrap attempts', async () => {
    const db = createMemoryDb();
    const attempts = ['first', 'second'].map((openid) =>
      bootstrapAdmin(db, {
        openid,
        pin: 'correct',
        expectedPin: 'correct',
        now: 100,
      }),
    );

    const results = await Promise.allSettled(attempts);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'ALREADY_INITIALIZED');
  });

  it('allows enabled admin and operator through requireStaff', async () => {
    const db = createMemoryDb({
      admin_users: {
        admin: staff('admin', 'admin', true),
        operator: staff('operator', 'operator', true),
      },
    });

    assert.equal((await requireStaff(db, 'admin')).role, 'admin');
    assert.equal((await requireStaff(db, 'operator')).role, 'operator');
  });

  it('rejects missing and disabled staff', async () => {
    const db = createMemoryDb({
      admin_users: {
        disabled: staff('disabled', 'operator', false),
      },
    });

    await assert.rejects(requireStaff(db, 'missing'), assertCode('UNAUTHORIZED'));
    await assert.rejects(requireStaff(db, 'disabled'), assertCode('UNAUTHORIZED'));
    await assert.rejects(requireStaff(db, ''), assertCode('UNAUTHORIZED'));
  });

  it('rejects operator from requireAdminRole', async () => {
    const db = createMemoryDb({
      admin_users: {
        operator: staff('operator', 'operator', true),
      },
    });

    await assert.rejects(requireAdminRole(db, 'operator'), assertCode('FORBIDDEN'));
  });

  it('does not allow editing self', async () => {
    const db = createMemoryDb({
      admin_users: {
        admin: staff('admin', 'admin', true),
      },
    });

    await assert.rejects(
      updateStaff(db, {
        openid: 'admin',
        targetOpenid: 'admin',
        role: 'operator',
        enabled: true,
        now: 10,
      }),
      assertCode('CANNOT_EDIT_SELF'),
    );
  });

  it('does not allow removing the last enabled admin', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: {
          initialized: true,
          enabledAdminOpenids: ['first'],
        },
      },
      admin_users: {
        owner: staff('owner', 'admin', true),
        first: staff('first', 'admin', true),
      },
    });

    await assert.rejects(
      updateStaff(db, {
        openid: 'owner',
        targetOpenid: 'first',
        role: 'operator',
        enabled: true,
        now: 10,
      }),
      assertCode('LAST_ADMIN'),
    );
    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['first'],
    );
  });

  it('serializes mutual demotion and preserves one enabled admin', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: {
          initialized: true,
          enabledAdminOpenids: ['first', 'second'],
        },
      },
      admin_users: {
        first: staff('first', 'admin', true),
        second: staff('second', 'admin', true),
      },
    });

    const results = await Promise.allSettled([
      updateStaff(db, {
        openid: 'first',
        targetOpenid: 'second',
        role: 'operator',
        enabled: true,
        now: 10,
      }),
      updateStaff(db, {
        openid: 'second',
        targetOpenid: 'first',
        role: 'operator',
        enabled: true,
        now: 10,
      }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'FORBIDDEN');
    assert.equal(
      [...['first', 'second']].filter(
        (id) => db.dump('admin_users', id).role === 'admin',
      ).length,
      1,
    );
    assert.equal(db.dump('admin_config', 'staff').enabledAdminOpenids.length, 1);
    assert.equal(db.dump('admin_config', 'staff').updatedAt, 10);
  });

  it('stops a concurrently demoted or disabled caller from editing a third user', async () => {
    for (const callerChange of [
      { role: 'operator', enabled: true },
      { role: 'admin', enabled: false },
    ]) {
      const db = createMemoryDb({
        admin_config: {
          staff: {
            initialized: true,
            enabledAdminOpenids: ['owner', 'caller'],
          },
        },
        admin_users: {
          owner: staff('owner', 'admin', true),
          caller: staff('caller', 'admin', true),
          third: staff('third', 'operator', true),
        },
      });

      const results = await Promise.allSettled([
        updateStaff(db, {
          openid: 'owner',
          targetOpenid: 'caller',
          ...callerChange,
          now: 10,
        }),
        updateStaff(db, {
          openid: 'caller',
          targetOpenid: 'third',
          role: 'admin',
          enabled: true,
          now: 11,
        }),
      ]);

      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      assert.ok(['FORBIDDEN', 'UNAUTHORIZED'].includes(results[1].reason.code));
      assert.equal(db.dump('admin_users', 'third').role, 'operator');
    }
  });

  it('rolls back all transaction writes when its callback throws', async () => {
    const db = createMemoryDb({
      admin_users: {
        existing: staff('existing', 'operator', true),
      },
    });

    await assert.rejects(
      db.runTransaction(async (transaction) => {
        await transaction.collection('admin_users').doc('existing').update({
          data: { enabled: false },
        });
        await transaction.collection('admin_users').doc('new').set({
          data: staff('new', 'operator', true),
        });
        throw new Error('rollback');
      }),
      /rollback/,
    );

    assert.equal(db.dump('admin_users', 'existing').enabled, true);
    assert.equal(db.dump('admin_users', 'new'), undefined);
  });

  it('lists enabled admins, enabled operators, then disabled staff', async () => {
    const db = createMemoryDb({
      admin_users: {
        caller: staff('caller', 'admin', true, 5),
        admin: staff('admin', 'admin', true, 4),
        operator: staff('operator', 'operator', true, 2),
        disabled: staff('disabled', 'admin', false, 1),
      },
    });

    const result = await listStaff(db, { openid: 'caller' });

    assert.deepEqual(
      result.map((record) => record.openid),
      ['admin', 'caller', 'operator', 'disabled'],
    );
  });

  it('creates a 24 hour one-use invite', async () => {
    const db = createMemoryDb({
      admin_users: {
        admin: staff('admin', 'admin', true),
      },
    });

    const result = await createInvite(db, {
      openid: 'admin',
      role: 'operator',
      code: 'invite-code',
      now: 1_000,
    });

    assert.deepEqual(result, {
      code: 'invite-code',
      role: 'operator',
      createdBy: 'admin',
      createdAt: 1_000,
      expiresAt: 1_000 + 24 * 60 * 60 * 1000,
      usedBy: '',
    });
    assert.deepEqual(db.dump('admin_invites', 'invite-code'), result);
  });

  it('rejects an empty invite code before calling the database SDK', async () => {
    const db = createMemoryDb({
      admin_users: {
        admin: staff('admin', 'admin', true),
      },
    });

    await assert.rejects(
      createInvite(db, {
        openid: 'admin',
        role: 'operator',
        code: '',
        now: 1_000,
      }),
      assertCode('INVALID_INVITE'),
    );
  });

  it('claims an invite with its selected role', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: {
          initialized: true,
          enabledAdminOpenids: ['creator', 'creator'],
        },
      },
      admin_invites: {
        code: {
          code: 'code',
          role: 'admin',
          createdBy: 'creator',
          createdAt: 1,
          expiresAt: 1_000,
          usedBy: '',
        },
      },
    });

    const result = await claimInvite(db, {
      openid: 'new-admin',
      code: 'code',
      now: 100,
    });

    assert.deepEqual(result, staff('new-admin', 'admin', true, 100));
    assert.deepEqual(db.dump('admin_users', 'new-admin'), result);
    assert.equal(db.dump('admin_invites', 'code').usedBy, 'new-admin');
    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['creator', 'new-admin'],
    );
    assert.equal(db.dump('admin_config', 'staff').updatedAt, 100);
  });

  it('keeps enabledAdminOpenids correct across role and status changes', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: {
          initialized: true,
          enabledAdminOpenids: ['owner', 'owner'],
        },
      },
      admin_users: {
        owner: staff('owner', 'admin', true),
        target: staff('target', 'operator', true),
      },
    });

    await updateStaff(db, {
      openid: 'owner',
      targetOpenid: 'target',
      role: 'admin',
      enabled: true,
      now: 10,
    });
    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['owner', 'target'],
    );

    await updateStaff(db, {
      openid: 'owner',
      targetOpenid: 'target',
      role: 'operator',
      enabled: true,
      now: 11,
    });
    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['owner'],
    );

    await updateStaff(db, {
      openid: 'owner',
      targetOpenid: 'target',
      role: 'admin',
      enabled: true,
      now: 12,
    });
    await updateStaff(db, {
      openid: 'owner',
      targetOpenid: 'target',
      role: 'admin',
      enabled: false,
      now: 13,
    });
    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['owner'],
    );

    await updateStaff(db, {
      openid: 'owner',
      targetOpenid: 'target',
      role: 'admin',
      enabled: true,
      now: 14,
    });
    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['owner', 'target'],
    );
    assert.equal(db.dump('admin_config', 'staff').updatedAt, 14);
  });

  it('leaves enabledAdminOpenids unchanged for operator-only updates', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: {
          initialized: true,
          enabledAdminOpenids: ['owner'],
        },
      },
      admin_users: {
        owner: staff('owner', 'admin', true),
        target: staff('target', 'operator', true),
      },
    });

    await updateStaff(db, {
      openid: 'owner',
      targetOpenid: 'target',
      role: 'operator',
      enabled: false,
      now: 10,
    });

    assert.deepEqual(
      db.dump('admin_config', 'staff').enabledAdminOpenids,
      ['owner'],
    );
    assert.equal(db.dump('admin_config', 'staff').updatedAt, 10);
  });

  it('rejects expired and already used invites', async () => {
    const db = createMemoryDb({
      admin_invites: {
        expired: {
          code: 'expired',
          role: 'operator',
          expiresAt: 99,
          usedBy: '',
        },
        used: {
          code: 'used',
          role: 'operator',
          expiresAt: 1_000,
          usedBy: 'someone',
        },
      },
    });

    await assert.rejects(
      claimInvite(db, { openid: 'new', code: 'missing', now: 100 }),
      assertCode('INVALID_INVITE'),
    );
    await assert.rejects(
      claimInvite(db, { openid: 'new', code: 'expired', now: 100 }),
      assertCode('INVALID_INVITE'),
    );
    await assert.rejects(
      claimInvite(db, { openid: 'new', code: 'used', now: 100 }),
      assertCode('INVALID_INVITE'),
    );
    await assert.rejects(
      claimInvite(db, { openid: 'new', code: '', now: 100 }),
      assertCode('INVALID_INVITE'),
    );
  });

  it('rejects enabled staff without consuming the invite', async () => {
    const db = createMemoryDb({
      admin_users: {
        existing: staff('existing', 'operator', true),
      },
      admin_invites: {
        code: {
          code: 'code',
          role: 'admin',
          expiresAt: 1_000,
          usedBy: '',
        },
      },
    });

    await assert.rejects(
      claimInvite(db, { openid: 'existing', code: 'code', now: 100 }),
      assertCode('ALREADY_STAFF'),
    );
    assert.equal(db.dump('admin_invites', 'code').usedBy, '');
  });

  it('does not reactivate disabled staff through an invite', async () => {
    const db = createMemoryDb({
      admin_users: {
        disabled: staff('disabled', 'operator', false),
      },
      admin_invites: {
        code: {
          code: 'code',
          role: 'admin',
          expiresAt: 1_000,
          usedBy: '',
        },
      },
    });

    await assert.rejects(
      claimInvite(db, { openid: 'disabled', code: 'code', now: 100 }),
      assertCode('STAFF_DISABLED'),
    );
    assert.equal(db.dump('admin_users', 'disabled').enabled, false);
    assert.equal(db.dump('admin_invites', 'code').usedBy, '');
  });

  it('returns initialization and membership state', async () => {
    const db = createMemoryDb({
      admin_config: {
        staff: { initialized: true },
      },
      admin_users: {
        operator: staff('operator', 'operator', true),
      },
    });

    assert.deepEqual(await getAdminState(db, 'operator'), {
      initialized: true,
      enabled: true,
      role: 'operator',
    });
    assert.deepEqual(await getAdminState(db, 'missing'), {
      initialized: true,
      enabled: false,
      role: '',
    });
  });

  it('normalizes array-shaped document responses', async () => {
    const db = {
      collection(name) {
        return {
          doc() {
            return {
              async get() {
                if (name === 'admin_config') {
                  return { data: [{ initialized: true }] };
                }
                return { data: [staff('operator', 'operator', true)] };
              },
            };
          },
        };
      },
    };

    assert.deepEqual(await getAdminState(db, 'operator'), {
      initialized: true,
      enabled: true,
      role: 'operator',
    });
  });

  it('rejects an invalid target openid with a stable domain code', async () => {
    const db = createMemoryDb({
      admin_users: {
        admin: staff('admin', 'admin', true),
      },
    });

    for (const targetOpenid of ['', null]) {
      await assert.rejects(
        updateStaff(db, {
          openid: 'admin',
          targetOpenid,
          role: 'operator',
          enabled: true,
          now: 10,
        }),
        assertCode('INVALID_STAFF'),
      );
    }
  });

  it('keeps all three cloudfunction copies byte-identical', () => {
    const catalog = fs.readFileSync(path.join(__dirname, 'adminStaff.js'));
    const shop = fs.readFileSync(
      path.join(__dirname, '..', '..', 'shop', 'lib', 'adminStaff.js'),
    );
    const ticketing = fs.readFileSync(
      path.join(__dirname, '..', '..', 'ticketing', 'lib', 'adminStaff.js'),
    );

    assert.deepEqual(shop, catalog);
    assert.deepEqual(ticketing, catalog);
  });
});
