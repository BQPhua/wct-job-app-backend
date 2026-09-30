'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const fx = require('./helpers/fixtures');
const lifecycle = require('../src/lib/offboarding/lifecycle');
const access = require('../src/lib/offboarding/access');
const dates = require('../src/lib/offboarding/dates');
const { EXIT_REASONS, STATUSES } = require('../src/lib/offboarding/constants');

async function makeCase(overrides = {}) {
  return db().withTransaction(async (client) => {
    const ref = await lifecycle.nextRefNo(client);
    const { rows } = await client.query(
      `INSERT INTO offboarding_cases (ref_no, invite_token, employee_email, employee_name, business_unit, status,
         invited_by_email, immediate_superior_email)
       VALUES ($1, $2, $3, 'Leaver', $4, $5, 'hr@wct.my', $6) RETURNING *`,
      [ref, fx.randomToken(), overrides.email || `leaver${fx.uniq()}@wct.my`, overrides.bu || 'Land',
        overrides.status || 'clearance_in_progress', overrides.superior || null]
    );
    if (overrides.sections !== false) await lifecycle.createSections(client, rows[0]);
    return rows[0];
  });
}

const staff = (unitScope, roles, email = 'staff@wct.my') => ({ unitScope, email, roles, adminUserId: null });
const PIC_IT_LAND = staff('Land', { bu_admin: false, payroll_pic: false, clearance_department_ids: [2] }, 'it.pic@wct.my');
const HR_LAND = staff('Land', { bu_admin: true, payroll_pic: false, clearance_department_ids: [] }, 'hr@wct.my');
const PAYROLL_LAND = staff('Land', { bu_admin: false, payroll_pic: true, clearance_department_ids: [] }, 'pay@wct.my');
const SUPER = staff('ALL', access.rolesFromClaims({ unit_scope: 'ALL' }), 'boss@wct.my');
const SUPERIOR = staff('SUPERIOR', access.rolesFromClaims({ unit_scope: 'SUPERIOR' }), 'superior@wct.my');

before(async () => { await resetDb(); });
after(async () => { await db().pool.end(); });

describe('constants and dates', () => {
  test('12 exit reasons in the form order, 6 statuses', () => {
    assert.equal(EXIT_REASONS.length, 12);
    assert.equal(EXIT_REASONS[0], 'Compensation (Salary / Benefits)');
    assert.deepEqual(STATUSES, ['invited', 'clearance_in_progress', 'pending_acknowledgement', 'pending_payroll', 'completed', 'cancelled']);
  });
  test('date helpers', () => {
    assert.equal(dates.daysBetween('2026-10-01', '2026-10-08'), 7);
    assert.equal(dates.daysBetween('2026-10-08', '2026-10-06'), -2);
    assert.equal(dates.addDays('2026-12-30', 3), '2027-01-02');
    assert.match(dates.todayMYT(), /^\d{4}-\d{2}-\d{2}$/);
    process.env.OFFBOARDING_TODAY_OVERRIDE = '2026-10-05';
    assert.equal(dates.todayMYT(), '2026-10-05');
    delete process.env.OFFBOARDING_TODAY_OVERRIDE;
  });
});

describe('lifecycle', () => {
  test('ref numbers increment and pad', async () => {
    const a = await db().withTransaction((c) => lifecycle.nextRefNo(c));
    const b = await db().withTransaction((c) => lifecycle.nextRefNo(c));
    assert.match(a, /^OFF-\d{4}-\d{4}$/);
    assert.equal(Number(b.slice(-4)), Number(a.slice(-4)) + 1);
  });

  test('createSections makes 6 sections / 45 items, Reporting Unit assigned to the superior', async () => {
    const c = await makeCase({ superior: 'Superior@WCT.my' });
    const bundle = await lifecycle.loadBundle(db(), c.id);
    assert.equal(bundle.sections.length, 6);
    assert.equal(bundle.sections.reduce((n, s) => n + s.items.length, 0), 45);
    const ru = bundle.sections.find((s) => s.department_id === 1);
    assert.equal(ru.assignee_email, 'superior@wct.my');
    assert.equal(ru.department_name, 'Reporting Unit');
    assert.equal(bundle.sections.find((s) => s.department_id === 2).assignee_email, null);
  });

  test('recalculate flips to pending_acknowledgement only when all 6 are complete', async () => {
    const c = await makeCase();
    await db().query("UPDATE offboarding_clearance_sections SET status = 'complete' WHERE case_id = $1 AND department_id < 6", [c.id]);
    let r = await db().withTransaction((cl) => lifecycle.recalculate(cl, c.id));
    assert.deepEqual(r, { status: 'clearance_in_progress', changed: false });
    await db().query("UPDATE offboarding_clearance_sections SET status = 'complete' WHERE case_id = $1", [c.id]);
    r = await db().withTransaction((cl) => lifecycle.recalculate(cl, c.id));
    assert.deepEqual(r, { status: 'pending_acknowledgement', changed: true });
  });

  test('logEvent writes the timeline', async () => {
    const c = await makeCase({ sections: false });
    await db().withTransaction((cl) => lifecycle.logEvent(cl, c.id, HR_LAND, 'details_updated', { field: 'position' }));
    const b = await lifecycle.loadBundle(db(), c.id);
    const ev = b.events.find((e) => e.event_type === 'details_updated');
    assert.equal(ev.actor_email, 'hr@wct.my');
    assert.equal(ev.actor_role, 'hr');
    assert.equal(ev.detail.field, 'position');
  });
});

describe('access', () => {
  const sectionOf = (bundle, dept) => bundle.sections.find((s) => s.department_id === dept);

  test('canEditSection matrix', async () => {
    const land = await lifecycle.loadBundle(db(), (await makeCase({ superior: 'superior@wct.my' })).id);
    const ec = await lifecycle.loadBundle(db(), (await makeCase({ bu: 'E&C' })).id);
    const own = await lifecycle.loadBundle(db(), (await makeCase({ email: 'it.pic@wct.my' })).id);
    const locked = await lifecycle.loadBundle(db(), (await makeCase({ status: 'pending_payroll' })).id);

    assert.equal(access.canEditSection(PIC_IT_LAND, land.case, sectionOf(land, 2)).ok, true);
    assert.equal(access.canEditSection(PIC_IT_LAND, land.case, sectionOf(land, 4)).reason, 'not_owner');
    assert.equal(access.canEditSection(PIC_IT_LAND, ec.case, sectionOf(ec, 2)).reason, 'not_owner');
    assert.equal(access.canEditSection(PIC_IT_LAND, own.case, sectionOf(own, 2)).reason, 'own_case');
    assert.equal(access.canEditSection(PIC_IT_LAND, locked.case, sectionOf(locked, 2)).reason, 'status');

    assert.equal(access.canEditSection(HR_LAND, land.case, sectionOf(land, 4)).reason, 'not_owner');
    assert.deepEqual(access.canEditSection(HR_LAND, land.case, sectionOf(land, 4), { onBehalf: true }), { ok: true, onBehalf: true });
    assert.equal(access.canEditSection(HR_LAND, ec.case, sectionOf(ec, 4), { onBehalf: true }).ok, false);
    assert.equal(access.canEditSection(SUPER, ec.case, sectionOf(ec, 4), { onBehalf: true }).ok, true);

    assert.deepEqual(access.canEditSection(SUPERIOR, land.case, sectionOf(land, 1)), { ok: true, onBehalf: false });
    assert.equal(access.canEditSection(SUPERIOR, land.case, sectionOf(land, 2)).ok, false);
    assert.equal(access.canEditSection(PAYROLL_LAND, land.case, sectionOf(land, 2)).ok, false);
  });

  test('Reporting Unit PICs sign only when no superior is assigned', async () => {
    const RU_PIC = staff('Land', { bu_admin: false, payroll_pic: false, clearance_department_ids: [1] }, 'ru@wct.my');
    const withSup = await lifecycle.loadBundle(db(), (await makeCase({ superior: 'superior@wct.my' })).id);
    const noSup = await lifecycle.loadBundle(db(), (await makeCase()).id);
    assert.equal(access.canEditSection(RU_PIC, withSup.case, sectionOf(withSup, 1)).ok, false);
    assert.equal(access.canEditSection(RU_PIC, noSup.case, sectionOf(noSup, 1)).ok, true);
  });

  test('caseScopeSql limits rows by BU and role', async () => {
    await makeCase({ bu: 'Mall' });
    const count = async (admin) => {
      const { sql, values } = access.caseScopeSql(admin, 'c', 1);
      const { rows } = await db().query(`SELECT count(*)::int n, array_agg(DISTINCT c.business_unit) bus FROM offboarding_cases c WHERE ${sql}`, values);
      return rows[0];
    };
    const hr = await count(HR_LAND);
    assert.deepEqual(hr.bus, ['Land']);
    const pay = await count(PAYROLL_LAND);
    assert.equal(pay.n, hr.n);
    const all = await count(SUPER);
    assert.ok(all.bus.includes('Mall') && all.bus.includes('E&C'));
    const invited = await makeCase({ status: 'invited', sections: false });
    const { sql, values } = access.caseScopeSql(PIC_IT_LAND, 'c', 1);
    const pic = await db().query(`SELECT c.id FROM offboarding_cases c WHERE ${sql}`, values);
    assert.ok(!pic.rows.some((r) => r.id === invited.id), 'PIC must not see cases without sections');
    const sup = await count(SUPERIOR);
    assert.ok(sup.n >= 1);
    assert.deepEqual(sup.bus, ['Land']);
  });

  test('canViewCase mirrors caseScopeSql', async () => {
    const mall = await lifecycle.loadBundle(db(), (await makeCase({ bu: 'Mall' })).id);
    assert.equal(access.canViewCase(HR_LAND, mall.case, mall.sections), false);
    assert.equal(access.canViewCase(SUPER, mall.case, mall.sections), true);
    const land = await lifecycle.loadBundle(db(), (await makeCase()).id);
    assert.equal(access.canViewCase(PIC_IT_LAND, land.case, land.sections), true);
    assert.equal(access.isPayrollFor(PAYROLL_LAND, 'Land'), true);
    assert.equal(access.isPayrollFor(PAYROLL_LAND, 'Mall'), false);
    assert.equal(access.isHrFor(HR_LAND, 'Land'), true);
    assert.equal(access.isHrFor(PIC_IT_LAND, 'Land'), false);
  });
});
