'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');

const MAX_SKILLS = 100;
const MAX_TEXT = 12000;
const MAX_KB_BYTES = 1024 * 1024;
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv']);

function fail(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw fail('技能 ID 只能包含字母、数字、点、下划线和短横线');
  return id;
}
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const family = net.isIP(host);
  if (family === 4) {
    const p = host.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254)
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
  }
  if (family === 6) return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  return false;
}

class SkillsKnowledgeService {
  constructor({ dataDir, fetcher = fetch, resolver = dns.lookup, logger = null } = {}) {
    this.dataDir = path.resolve(dataDir || 'data');
    this.skillsFile = path.join(this.dataDir, 'custom-skills.json');
    this.knowledgeFile = path.join(this.dataDir, 'knowledge-sources.json');
    this.fetcher = fetcher;
    this.logger = logger;
    this.knowledge = new Map();
    this.skills = this.readJson(this.skillsFile, { skills: [] }).skills || [];
    this.sources = this.readJson(this.knowledgeFile, { sources: [] }).sources || [];
    this.skills = this.skills.filter(s => s && typeof s === 'object' && typeof s.id === 'string');
  }

  readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  writeJson(file, value) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  }
  listSkills() { return this.skills.map(s => ({ ...s })); }
  saveSkill(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('技能配置必须是对象');
    const id = safeId(input.id);
    const name = String(input.name || '').trim();
    const description = String(input.description || '').trim();
    const content = String(input.content || '').trim();
    const keywords = Array.isArray(input.keywords) ? input.keywords.map(x => String(x).trim()).filter(Boolean) : [];
    if (!name || name.length > 80) throw fail('技能名称不能为空且不能超过 80 字');
    if (description.length > 500 || content.length > MAX_TEXT) throw fail('技能描述或内容超出长度限制');
    if (!content) throw fail('技能执行内容不能为空');
    if (!keywords.length || keywords.length > 30 || keywords.some(x => x.length > 40)) throw fail('请配置 1 至 30 个有效触发关键词');
    const old = this.skills.find(s => s.id === id);
    const skill = { id, name, description, keywords: [...new Set(keywords)], content,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (old ? old.enabled : true),
      priority: Number.isInteger(input.priority) ? Math.max(0, Math.min(1000, input.priority)) : 100 };
    const next = [...this.skills.filter(s => s.id !== id), skill];
    if (next.length > MAX_SKILLS) throw fail('自定义技能最多 100 个');
    this.writeJson(this.skillsFile, { version: 1, skills: next });
    this.skills = next;
    return { ...skill };
  }
  deleteSkill(id) {
    const key = safeId(id);
    const next = this.skills.filter(s => s.id !== key);
    if (next.length === this.skills.length) throw fail('技能不存在', 404);
    this.writeJson(this.skillsFile, { version: 1, skills: next });
    this.skills = next;
    return { ok: true, id: key };
  }
  setSkillEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw fail('enabled 必须是布尔值');
    const key = safeId(id);
    const skill = this.skills.find(s => s.id === key);
    if (!skill) throw fail('技能不存在', 404);
    return this.saveSkill({ ...skill, enabled });
  }
  listKnowledge() {
    return this.sources.map(s => ({ ...s, status: this.knowledge.get(s.id)?.status || 'not_loaded',
      error: this.knowledge.get(s.id)?.error || '' }));
  }
  validateSource(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('知识库来源必须是对象');
    const id = safeId(input.id);
    const type = String(input.type || '');
    const value = String(input.path || '').trim();
    if (!value || value.length > 2048) throw fail('知识库路径不能为空且不能超过 2048 字');
    if (!['local', 'remote'].includes(type)) throw fail('知识库类型只能是 local 或 remote');
    if (type === 'local') {
      const resolved = path.resolve(value);
      let stat;
      try { stat = fs.statSync(resolved); } catch { throw fail('本地路径不存在或不可访问'); }
      if (!stat.isDirectory() && !stat.isFile()) throw fail('本地路径必须是文件或目录');
      if (stat.isFile() && !TEXT_EXT.has(path.extname(resolved).toLowerCase())) throw fail('本地知识库仅支持 txt、md、json、csv 文件');
      return { id, type, path: resolved, enabled: input.enabled !== false };
    }
    let url;
    try { url = new URL(value); } catch { throw fail('网络路径不是有效 URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw fail('网络知识库仅支持不含账号密码和片段的 HTTP/HTTPS URL');
    if (isPrivateHost(url.hostname)) throw fail('为避免 SSRF，不允许访问本机或内网地址');
    return { id, type, path: url.toString(), enabled: input.enabled !== false };
  }
  async loadSource(input) {
    const source = this.validateSource(input);
    if (!source.enabled) return { source, text: '', status: 'disabled' };
    let text = '';
    if (source.type === 'local') {
      const stat = fs.statSync(source.path);
      const files = stat.isDirectory()
        ? fs.readdirSync(source.path, { withFileTypes: true }).filter(x => x.isFile() && TEXT_EXT.has(path.extname(x.name).toLowerCase()))
          .slice(0, 100).map(x => path.join(source.path, x.name))
        : [source.path];
      const parts = [];
      let bytes = 0;
      for (const file of files) {
        const data = fs.readFileSync(file);
        bytes += data.length;
        if (bytes > MAX_KB_BYTES) throw fail('知识库内容超过 1 MiB 限制');
        parts.push('\n## ' + path.basename(file) + '\n' + data.toString('utf8'));
      }
      text = parts.join('\n').slice(0, MAX_KB_BYTES);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await this.fetcher(source.path, { redirect: 'error', signal: controller.signal,
          headers: { accept: 'text/plain, text/markdown, application/json' } });
        if (!response.ok) throw fail('网络知识库加载失败：HTTP ' + response.status, 502);
        const type = String(response.headers.get('content-type') || '');
        if (type && !/(text\/|application\/json)/i.test(type)) throw fail('网络知识库返回了不支持的内容类型', 502);
        const data = await response.text();
        if (Buffer.byteLength(data, 'utf8') > MAX_KB_BYTES) throw fail('网络知识库内容超过 1 MiB 限制');
        text = data;
      } catch (err) {
        if (err.name === 'AbortError') throw fail('网络知识库加载超时', 504);
        throw err;
      } finally { clearTimeout(timer); }
    }
    if (!text.trim()) throw fail('知识库内容为空');
    return { source, text: text.slice(0, MAX_KB_BYTES), status: 'loaded' };
  }
  async saveKnowledgeSource(input) {
    const source = this.validateSource(input);
    const loaded = await this.loadSource(source);
    const next = [...this.sources.filter(s => s.id !== source.id), source];
    this.writeJson(this.knowledgeFile, { version: 1, sources: next });
    this.sources = next;
    this.knowledge.set(source.id, { text: loaded.text, status: loaded.status, error: '' });
    return { ...source, status: loaded.status };
  }
  async testKnowledgeSource(input) {
    const loaded = await this.loadSource(input);
    this.knowledge.set(loaded.source.id, { text: loaded.text, status: loaded.status, error: '' });
    return { id: loaded.source.id, status: loaded.status, bytes: Buffer.byteLength(loaded.text, 'utf8') };
  }
  async reloadKnowledge() {
    const results = [];
    for (const source of this.sources) {
      try {
        const loaded = await this.loadSource(source);
        this.knowledge.set(source.id, { text: loaded.text, status: loaded.status, error: '' });
        results.push({ id: source.id, status: loaded.status });
      } catch (err) {
        this.knowledge.set(source.id, { status: 'error', error: err.message });
        this.logger?.warn?.('知识库加载失败：source=' + source.id + ' reason=' + (err.code || err.message));
        results.push({ id: source.id, status: 'error', error: err.message });
      }
    }
    return results;
  }
  deleteKnowledgeSource(id) {
    const key = safeId(id);
    const next = this.sources.filter(s => s.id !== key);
    if (next.length === this.sources.length) throw fail('知识库来源不存在', 404);
    this.writeJson(this.knowledgeFile, { version: 1, sources: next });
    this.sources = next;
    this.knowledge.delete(key);
    return { ok: true, id: key };
  }
  enrich(options) {
    if (!options || options.purpose !== 'chat' || !Array.isArray(options.turns)) return options;
    const user = String([...options.turns].reverse().find(t => t?.role === 'user')?.content || '').slice(0, 4000);
    if (!user) return options;
    const skillBlocks = this.skills.filter(s => s.enabled && s.keywords.some(k => user.toLowerCase().includes(k.toLowerCase())))
      .sort((a, b) => a.priority - b.priority).slice(0, 3)
      .map(s => '【技能：' + s.name + '】\n' + s.content);
    const knowledgeBlocks = [];
    for (const [id, entry] of this.knowledge) {
      if (entry.status !== 'loaded' || !entry.text) continue;
      const terms = [...new Set(user.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 12);
      const lines = entry.text.split(/\r?\n/).filter(line => line.trim() && terms.some(term => line.toLowerCase().includes(term))).slice(0, 8);
      if (lines.length) knowledgeBlocks.push('【知识库 ' + id + '】\n' + lines.join('\n'));
    }
    const additions = [...skillBlocks, ...knowledgeBlocks].join('\n\n').slice(0, 16000);
    if (!additions) return options;
    return { ...options, system: String(options.system || '') + '\n\n【本轮匹配的自定义技能与知识库资料】\n' + additions };
  }
}

module.exports = { SkillsKnowledgeService, isPrivateHost };
