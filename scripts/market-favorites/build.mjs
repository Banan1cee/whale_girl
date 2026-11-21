import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dist = new URL('./dist/server/', import.meta.url);
mkdirSync(dist, { recursive: true });
const api = readFileSync(new URL('./worker/favorites.mjs', import.meta.url), 'utf8');
writeFileSync(new URL('index.mjs', dist), api + `
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/') {
      return reply({ service: 'WhaleGirl plugin favorites', api: '/api/favorites' });
    }
    if (path !== '/api/favorites') return reply({ error: 'not_found' }, 404);
    return favoriteRequest(request, env.DB);
  }
};
`);
