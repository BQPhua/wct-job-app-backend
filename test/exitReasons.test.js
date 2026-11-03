'use strict';
// Exit reasons setup (migration 013): HR manages the list employees tick.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const HR = `Bearer ${fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land', roles: R({ bu_admin: true }) })}`;
const PAY = `Bearer ${fx.adminToken({ email: 'pay.land@wct.my', unit_scope: 'Land', roles: R({ payroll_pic: true }) })}`;
const api = (method, url, auth, body) => {
  const r = request()[method](`/api/admin/offboarding${url}`).set('Authorization', auth);
  return body ? r.send(body) : r;
};
const labels = (res) => res.body.reasons.map((r) => r.label);

before(async () => {
  await resetDb();
  await applyMigration('013'); // safe to run twice
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  await fx.admin({ email: 'pay.land@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
});
after(async () => { await db().pool.end(); });

describe('exit reasons setup', () => {
  test('seeded with the 12 original reasons; HR only', async () => {
    const res = await api('get', '/reasons', HR);
    assert.equal(res.status, 200);
    assert.equal(res.body.reasons.length, 12);
    assert.ok(labels(res).includes('Better Offer'));
    assert.equal((await api('get', '/reasons', PAY)).status, 403);
    assert.equal((await api('post', '/reasons', PAY, { label: 'X' })).status, 403);
  });

  test('add, duplicate, rename, move and delete', async () => {
    let res = await api('post', '/reasons', HR, { label: '  Relocation overseas ' });
    assert.equal(res.status, 201);
    assert.equal(labels(res).at(-1), 'Relocation overseas');
    assert.equal((await api('post', '/reasons', HR, { label: 'relocation OVERSEAS' })).status, 409);
    assert.equal((await api('post', '/reasons', HR, { label: '' })).status, 400);

    const added = res.body.reasons.at(-1);
    res = await api('patch', `/reasons/${added.id}`, HR, { label: 'Relocating overseas' });
    assert.equal(res.status, 200);
    assert.equal(labels(res).at(-1), 'Relocating overseas');

    res = await api('patch', `/reasons/${added.id}`, HR, { move: 'up' });
    assert.equal(labels(res).at(-2), 'Relocating overseas');

    res = await api('delete', `/reasons/${added.id}`, HR);
    assert.equal(res.status, 200);
    assert.ok(!labels(res).includes('Relocating overseas'));
    assert.equal((await api('delete', `/reasons/${added.id}`, HR)).status, 404);

    // The meta endpoint (used by the forms) follows the table.
    const meta = await api('get', '/meta', HR);
    assert.deepEqual(meta.body.reasons, labels(res));
  });

  test('the last reason cannot be deleted', async () => {
    let res = await api('get', '/reasons', HR);
    for (const r of res.body.reasons.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      res = await api('delete', `/reasons/${r.id}`, HR);
      assert.equal(res.status, 200);
    }
    assert.equal(res.body.reasons.length, 1);
    assert.equal((await api('delete', `/reasons/${res.body.reasons[0].id}`, HR)).status, 409);
  });
});
