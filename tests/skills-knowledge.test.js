'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsKnowledgeService, isPrivateHost } = require('../src/services/skillsKnowledge');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-skills-'));
  const service = new SkillsKnowledgeService({ dataDir: dir });
  return { dir, service, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('custom skills persist and enrich matching chat prompts', () => {
  const f = fixture();
  try {
    f.service.saveSkill({ id: 'weather-help', name: '天气助手', keywords: ['天气'], content: '回答天气问题时先询问城市。' });
    const reloaded = new SkillsKnowledgeService({ dataDir: f.dir });
    const out = reloaded.enrich({ purpose: 'chat', system: 'base', turns: [{ role: 'user', content: '今天天气如何' }] });
    assert.match(out.system, /天气助手/);
    assert.match(out.system, /先询问城市/);
    assert.equal(reloaded.listSkills()[0].enabled, true);
  } finally { f.close(); }
});

test('disabled skills do not affect prompts and can be re-enabled', () => {
  const f = fixture();
  try {
    f.service.saveSkill({ id: 'brief', name: '简短回答', keywords: ['简短'], content: '保持简短。' });
    f.service.setSkillEnabled('brief', false);
    assert.equal(f.service.enrich({ purpose: 'chat', system: 'base', turns: [{ role: 'user', content: '请简短' }] }).system, 'base');
    f.service.setSkillEnabled('brief', true);
    assert.match(f.service.enrich({ purpose: 'chat', system: 'base', turns: [{ role: 'user', content: '请简短' }] }).system, /保持简短/);
  } finally { f.close(); }
});

test('invalid skill input is rejected without corrupting persisted skills', () => {
  const f = fixture();
  try {
    f.service.saveSkill({ id: 'valid', name: '有效技能', keywords: ['有效'], content: '内容' });
    assert.throws(() => f.service.saveSkill({ id: '../bad', name: '坏', keywords: ['坏'], content: '内容' }));
    assert.throws(() => f.service.saveSkill({ id: 'empty', name: '空', keywords: [], content: '内容' }));
    assert.equal(f.service.listSkills().length, 1);
  } finally { f.close(); }
});

test('local knowledge sources load and contribute matching lines', async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'guide.md');
    fs.writeFileSync(file, '# 安装指南\nWindows 安装需要重启启动器。\n无关内容。', 'utf8');
    await f.service.saveKnowledgeSource({ id: 'guide', type: 'local', path: file });
    const out = f.service.enrich({ purpose: 'chat', system: 'base', turns: [{ role: 'user', content: 'Windows 安装怎么做' }] });
    assert.match(out.system, /重启启动器/);
    assert.equal(f.service.listKnowledge()[0].status, 'loaded');
  } finally { f.close(); }
});

test('remote knowledge rejects private addresses and unsupported protocols', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.validateSource({ id: 'internal', type: 'remote', path: 'http://127.0.0.1/private' }), /内网/);
    assert.throws(() => f.service.validateSource({ id: 'bad', type: 'remote', path: 'file:///etc/passwd' }), /HTTP/);
    assert.equal(isPrivateHost('192.168.1.2'), true);
    assert.equal(isPrivateHost('example.com'), false);
  } finally { f.close(); }
});

test('remote knowledge follows bounded text response and rejects redirects', async () => {
  const f = fixture();
  try {
    const service = new SkillsKnowledgeService({ dataDir: f.dir, fetcher: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, headers: { get: () => 'text/plain; charset=utf-8' }, text: async () => '远程知识内容' };
    } });
    const result = await service.testKnowledgeSource({ id: 'remote-doc', type: 'remote', path: 'https://example.com/guide.txt' });
    assert.equal(result.status, 'loaded');
    assert.ok(result.bytes > 0);
  } finally { f.close(); }
});
