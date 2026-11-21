import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { favoriteRequest } from './favorites.mjs';

function fixture() {
  const store = new DatabaseSync(':memory:');
  store.exec(readFileSync(new URL('../drizzle/0000_favorites.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      return { bind: (...params) => ({
        run: () => store.prepare(sql).run(...params),
        all: () => ({ results: store.prepare(sql).all(...params) }),
      }) };
    },
    batch([write, read]) {
      store.exec('BEGIN');
      try {
        const result = [write.run(), read.all()];
        store.exec('COMMIT');
        return result;
      } catch (error) {
        store.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  const send = (method, token, input, query = 'ids=one,two') => favoriteRequest(new Request(
    `https://example.invalid/api/favorites?${query}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: input == null ? undefined : JSON.stringify(input),
    }), db, async () => new Set(['one','two']));
  return { first, second, send, store };
}

test('two installations share counts and can only remove their own vote', async () => {
  const { first, second, send, store } = fixture();
  const vote = { id: 'one', favorited: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await (await send('PUT', first, vote)).json(), { favorites: [{ id: 'one', count: 1, favorited: true }] });
  }
  assert.deepEqual(await (await send('GET', second)).json(), { favorites: [
    { id: 'one', count: 1, favorited: false }, { id: 'two', count: 0, favorited: false },
  ] });
  await send('PUT', second, vote);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await (await send('PUT', first, { ...vote, favorited: false })).json(),
      { favorites: [{ id: 'one', count: 1, favorited: false }] });
  }
  const { installation_hash } = store.prepare('SELECT installation_hash FROM market_favorites').get();
  assert.notEqual(installation_hash, second);
  store.close();
});

test('invalid credentials, unknown plugins and malformed IDs are rejected', async () => {
  const { first, send, store } = fixture();
  assert.equal((await send('PUT', '', { id: 'one', favorited: true })).status, 401);
  assert.equal((await send('PUT', first, { id: 'other', favorited: true })).status, 404);
  assert.equal((await send('PUT', first, { id: 'one', favorited: 'true' })).status, 400);
  assert.equal((await send('GET', '', null, 'ids=%28test')).status, 400);
  assert.equal(store.prepare('SELECT count(*) AS count FROM market_favorites').get().count, 0);
  store.close();
});
