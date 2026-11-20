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
    const restarted = new SkillsKnowledgeService({ dataDir: f.dir });
    const reload = await restarted.reloadKnowledge();
    assert.equal(reload[0].status, 'loaded');
    const out = restarted.enrich({ purpose: 'chat', system: 'base', turns: [{ role: 'user', content: 'Windows 安装怎么做' }] });
    assert.match(out.system, /重启启动器/);
    assert.equal(f.service.listKnowledge()[0].status, 'loaded');
  } finally { f.close(); }
});

test('local knowledge rejects oversized files before loading their content', async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'too-large.txt');
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 0x61));
    await assert.rejects(
      f.service.testKnowledgeSource({ id: 'too-large', type: 'local', path: file }),
      /超过 1 MiB/
    );
  } finally { f.close(); }
});

test('remote knowledge rejects private addresses and unsupported protocols', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.validateSource({ id: 'internal', type: 'remote', path: 'http://127.0.0.1/private' }), /内网/);
    assert.throws(() => f.service.validateSource({ id: 'bad', type: 'remote', path: 'file:///etc/passwd' }), /HTTP/);
    assert.equal(isPrivateHost('192.168.1.2'), true);
    assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateHost('100.64.0.1'), true);
    assert.equal(isPrivateHost('example.com'), false);
  } finally { f.close(); }
});

test('remote knowledge follows bounded text response and rejects redirects', async () => {
  const f = fixture();
  try {
    const service = new SkillsKnowledgeService({ dataDir: f.dir, resolver: async () => [{ address: '93.184.216.34', family: 4 }], fetcher: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, headers: { get: () => 'text/plain; charset=utf-8' }, text: async () => '远程知识内容' };
    } });
    const result = await service.testKnowledgeSource({ id: 'remote-doc', type: 'remote', path: 'https://example.com/guide.txt' });
    assert.equal(result.status, 'loaded');
    assert.ok(result.bytes > 0);
  } finally { f.close(); }
});


test('skill edits and deletions persist by stable id', () => {
  const f = fixture();
  try {
    f.service.saveSkill({ id: 'notes', name: '笔记', keywords: ['记笔记'], content: '旧内容' });
    f.service.saveSkill({ id: 'notes', name: '笔记助手', keywords: ['笔记'], content: '新内容' });
    assert.equal(f.service.listSkills().length, 1);
    assert.equal(f.service.listSkills()[0].content, '新内容');
    f.service.deleteSkill('notes');
    assert.equal(f.service.listSkills().length, 0);
    assert.throws(() => f.service.deleteSkill('notes'), /不存在/);
  } finally { f.close(); }
});


test('remote knowledge rejects a public-looking hostname that resolves to loopback', async () => {
  const f = fixture();
  try {
    let requested = false;
    const service = new SkillsKnowledgeService({ dataDir: f.dir,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      fetcher: async () => { requested = true; throw new Error('fetch must not run'); }
    });
    await assert.rejects(
      service.testKnowledgeSource({ id: 'dns-rebind', type: 'remote', path: 'https://public.example/guide.md' }),
      /DNS|内网/
    );
    assert.equal(requested, false);
  } finally { f.close(); }
});


test('remote knowledge rejects canonicalized mapped IPv4 and non-global IPv6 addresses', async () => {
  const f = fixture();
  try {
    const mappedUrl = new URL('http://[::ffff:127.0.0.1]/private').hostname;
    assert.equal(isPrivateHost(mappedUrl), true);
    assert.throws(
      () => f.service.validateSource({ id: 'mapped-url', type: 'remote', path: 'http://[::ffff:127.0.0.1]/private' }),
      /内网/
    );
    assert.equal(isPrivateHost('fe90::1'), true);

    let requested = false;
    const service = new SkillsKnowledgeService({
      dataDir: f.dir,
      resolver: async () => [{ address: '::ffff:7f00:1', family: 6 }],
      fetcher: async () => { requested = true; throw new Error('fetch must not run'); }
    });
    await assert.rejects(
      service.testKnowledgeSource({ id: 'mapped-dns', type: 'remote', path: 'https://mapped.example/guide.md' }),
      /内网/
    );
    assert.equal(requested, false);
  } finally { f.close(); }
});

test('malformed persisted files do not break service startup', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, 'custom-skills.json'), JSON.stringify({ skills: [{ id: 'broken', keywords: [null], content: 7 }] }));
    fs.writeFileSync(path.join(f.dir, 'knowledge-sources.json'), 'null');
    const service = new SkillsKnowledgeService({ dataDir: f.dir });
    assert.deepEqual(service.listSkills(), []);
    assert.deepEqual(service.listKnowledge(), []);
  } finally { f.close(); }
});
