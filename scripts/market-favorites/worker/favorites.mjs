const idPattern = /^[a-z][a-z0-9-]{0,47}$/;
const installationPattern = /^Bearer ([0-9a-f]{64})$/;
const catalogRoot = 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/';
const catalogs = ['index.json', 'index-v2.json', 'index-v3.json', 'index-v4.json', 'index-personas.json'];
let knownPlugins;
let refreshAfter = 0;

function reply(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function getPluginIds() {
  if (knownPlugins && Date.now() < refreshAfter) return knownPlugins;
  const results = await Promise.allSettled(catalogs.map(async file => {
    const response = await fetch(catalogRoot + file, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('catalog unavailable');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('invalid catalog');
    return rows.map(row => row.Id).filter(id => typeof id === 'string' && idPattern.test(id));
  }));
  const available = results.filter(result => result.status === 'fulfilled');
  const ids = available.flatMap(result => result.value);
  if (!ids.length && !knownPlugins) throw new Error('catalog unavailable');
  if (ids.length) {
    // A transient failure in one catalog must not drop its previously known IDs.
    knownPlugins = new Set(available.length === catalogs.length ? ids : [...(knownPlugins ?? []), ...ids]);
    refreshAfter = Date.now() + (available.length === catalogs.length ? 300_000 : 30_000);
  }
  return knownPlugins;
}

const selectCounts = (db, ids, installation) => db.prepare(`
  SELECT plugin_id AS id, COUNT(*) AS count,
         MAX(CASE WHEN installation_hash = ? THEN 1 ELSE 0 END) AS favorited
  FROM market_favorites WHERE plugin_id IN (${ids.map(() => '?').join(',')})
  GROUP BY plugin_id
`).bind(installation, ...ids);

function resultsFor(ids, rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => ({ id, count: byId.get(id)?.count ?? 0, favorited: byId.get(id)?.favorited === 1 }));
}

export async function favoriteRequest(request, db, pluginIds = getPluginIds) {
  if (!db) return reply({ error: 'storage_unavailable' }, 503);
  const auth = request.headers.get('authorization');
  const installationKey = auth?.match(installationPattern)?.[1];
  if ((auth && !installationKey) || (request.method === 'PUT' && !installationKey)) {
    return reply({ error: 'installation_required' }, 401);
  }
  const installation = installationKey ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(installationKey))), byte => byte.toString(16).padStart(2, '0')).join('') : '';

  try {
    if (request.method === 'GET') {
      const value = new URL(request.url).searchParams.get('ids') ?? '';
      if (value.length > 3136) return reply({ error: 'invalid_ids' }, 400);
      const ids = [...new Set(value.split(','))];
      if (ids.length > 64 || ids.some(id => !idPattern.test(id))) return reply({ error: 'invalid_ids' }, 400);
      const { results } = await selectCounts(db, ids, installation).all();
      return reply({ favorites: resultsFor(ids, results) });
    }
    if (request.method !== 'PUT') return reply({ error: 'method_not_allowed' }, 405);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: 'invalid_request' }, 400);
    const decoder = new TextDecoder();
    let json = '', length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        return reply({ error: 'invalid_request' }, 400);
      }
      json += decoder.decode(value, { stream: true });
    }
    let input;
    try { input = JSON.parse(json + decoder.decode()); }
    catch { return reply({ error: 'invalid_request' }, 400); }
    if (!input || typeof input.id !== 'string' || !idPattern.test(input.id) || typeof input.favorited !== 'boolean') {
      return reply({ error: 'invalid_request' }, 400);
    }
    const { id, favorited } = input;
    if (favorited && !(await pluginIds()).has(id)) return reply({ error: 'unknown_plugin' }, 404);
    const mutation = favorited
      ? db.prepare('INSERT INTO market_favorites (plugin_id, installation_hash) VALUES (?, ?) ON CONFLICT DO NOTHING')
      : db.prepare('DELETE FROM market_favorites WHERE plugin_id = ? AND installation_hash = ?');
    const [, { results }] = await db.batch([mutation.bind(id, installation), selectCounts(db, [id], installation)]);
    return reply({ favorites: resultsFor([id], results) });
  } catch {
    return reply({ error: 'favorites_unavailable' }, 503);
  }
}
