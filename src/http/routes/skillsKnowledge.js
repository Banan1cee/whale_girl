'use strict';
const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
module.exports = function register(router) {
  router.pattern(/^\/api\/(?:skills|knowledge)(?:\/.*)?$/, async (runtime, req, res, info) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '技能和知识库管理仅允许本机访问' });
    const service = runtime.skillsKnowledge;
    if (!service) return json(res, 503, { ok: false, error: '技能与知识库服务尚未就绪' });
    const p = info.pathname;
    if (p === '/api/skills' && info.method === 'GET') return json(res, 200, { ok: true, items: service.listSkills() });
    if (p === '/api/skills' && info.method === 'POST') return json(res, 200, { ok: true, item: service.saveSkill(await readBody(req)) });
    const enabled = p.match(/^\/api\/skills\/([^/]+)\/enabled$/);
    if (enabled && info.method === 'POST') return json(res, 200, { ok: true, item: service.setSkillEnabled(decodeURIComponent(enabled[1]), (await readBody(req))?.enabled) });
    if (p === '/api/skills/delete' && info.method === 'POST') return json(res, 200, service.deleteSkill((await readBody(req))?.id));
    const skill = p.match(/^\/api\/skills\/([^/]+)$/);
    if (skill && info.method === 'DELETE') return json(res, 200, service.deleteSkill(decodeURIComponent(skill[1])));
    if (p === '/api/knowledge' && info.method === 'GET') return json(res, 200, { ok: true, items: service.listKnowledge() });
    if (p === '/api/knowledge/test' && info.method === 'POST') return json(res, 200, { ok: true, result: await service.testKnowledgeSource(await readBody(req)) });
    if (p === '/api/knowledge' && info.method === 'POST') return json(res, 200, { ok: true, item: await service.saveKnowledgeSource(await readBody(req)) });
    if (p === '/api/knowledge/delete' && info.method === 'POST') return json(res, 200, service.deleteKnowledgeSource((await readBody(req))?.id));
    const knowledge = p.match(/^\/api\/knowledge\/([^/]+)$/);
    if (knowledge && info.method === 'DELETE') return json(res, 200, service.deleteKnowledgeSource(decodeURIComponent(knowledge[1])));
    if (p === '/api/knowledge/reload' && info.method === 'POST') return json(res, 200, { ok: true, results: await service.reloadKnowledge() });
    return json(res, 404, { ok: false, error: 'unknown skills or knowledge operation' });
  });
};
