import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { identityFrom, recordVisit } from '../server/identity.mjs';

describe('Identity from the front door', () => {
  test('reads the user from the forwarded headers, decoding the name', () => {
    const person = identityFrom({
      'x-conforza-user-id': 'u1',
      'x-conforza-user-email': encodeURIComponent('ada@example.com'),
      'x-conforza-user-name': encodeURIComponent('Adà Lovelace'),
      'x-conforza-user-role': 'member',
    }, undefined);
    assert.deepEqual(person, {
      id: 'u1', email: 'ada@example.com', display_name: 'Adà Lovelace', role_key: 'member',
    });
  });

  test('no headers and no development user means nobody', () => {
    assert.equal(identityFrom({}, undefined), null);
  });

  test('the development stand-in applies only when no headers are present', () => {
    assert.equal(identityFrom({}, 'dev@example.com').id, 'dev');
    assert.equal(identityFrom({ 'x-conforza-user-id': 'u1' }, 'dev@example.com').id, 'u1');
  });

  test('a malformed name does not throw', () => {
    assert.equal(identityFrom({ 'x-conforza-user-id': 'u1', 'x-conforza-user-name': '%E0%A4%A' }).display_name, '');
  });

  test('visits are recorded once per person and keep the latest name', () => {
    const db = openDatabase(':memory:');
    recordVisit(db, { id: 'u1', email: 'a@example.com', display_name: 'Ada' });
    recordVisit(db, { id: 'u1', email: 'a@example.com', display_name: 'Ada Lovelace' });
    const rows = db.prepare('SELECT * FROM people').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].display_name, 'Ada Lovelace');
  });
});
