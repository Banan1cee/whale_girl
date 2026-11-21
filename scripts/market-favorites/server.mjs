import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { favoriteRequest } from './worker/favorites.mjs';

export function openFavoriteStore(filename) {
  const storage = new DatabaseSync(filename);
  storage.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  // The same first migration that is deployed to D1.
  const migration = readFileSync(new URL('./drizzle/0000_favorites.sql', import.meta.url), 'utf8');
  storage.exec(migration.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
  return {
    prepare(sql) {
      const statement = storage.prepare(sql);
      return { bind: (...params) => ({
        run: () => statement.run(...params),
        all: () => ({ results: statement.all(...params) }),
      }) };
    },
    batch([write, query]) {
      storage.exec('BEGIN IMMEDIATE');
      try {
        const result = [write.run(), query.all()];
        storage.exec('COMMIT');
        return result;
      } catch (error) {
        storage.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => storage.close(),
  };
}

export function createFavoritesServer(db, pluginIds) {
  return createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, 'http://localhost');
      let response;
      if (url.pathname === '/api/favorites') {
        const request = new Request(url, {
          method: incoming.method,
          headers: incoming.headers,
          ...(incoming.method === 'PUT' ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
        });
        response = await favoriteRequest(request, db, pluginIds);
      } else if (url.pathname === '/' && incoming.method === 'GET') {
        response = Response.json({ service: 'WhaleGirl plugin favorites', api: '/api/favorites' });
      } else {
        response = Response.json({ error: 'not_found' }, { status: 404 });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, { 'Content-Type': 'application/json' });
      outgoing.end('{"error":"favorites_unavailable"}');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WHALE_FAVORITES_PORT ?? '8789');
  const filename = path.resolve(process.env.WHALE_FAVORITES_DB ?? 'data/market-favorites.sqlite3');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WHALE_FAVORITES_PORT is invalid');
  mkdirSync(path.dirname(filename), { recursive: true });
  const database = openFavoriteStore(filename);
  const server = createFavoritesServer(database);
  server.listen(port, '127.0.0.1', () => console.log(`WhaleGirl favorites listens on 127.0.0.1:${port}`));
}
