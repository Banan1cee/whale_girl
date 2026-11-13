'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describeError } = require('../src/infra/errors');
const APP = 'Banan1cee/whale_girl';
const MARKET = 'Banan1cee/whale-girl-plugins';
const INDEXES = ['index.json', 'index-v2.json', 'index-v3.json', 'index-personas.json'];

async function collectPages(readPage) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const items = await readPage(page);
    if (!Array.isArray(items)) throw new Error('GitHub 分页数据无效');
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('GitHub 分页超过安全上限，拒绝发布截断的历史');
}

async function getJson(url, token) {
  const headers = { 'User-Agent': 'WhaleGirl-Website', Accept: 'application/vnd.github+json' };
  // Token 只用于 GitHub API，不转发给原始文件或重定向目标。
  if (token && new URL(url).hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch (error) {
    error.code = error.cause?.code || error.code;
    error.detail = `${new URL(url).hostname} ${error.cause?.message || error.message}`;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('官网数据请求失败');
    error.status = response.status;
    error.detail = new URL(url).pathname;
    throw error;
  }
  return response.json();
}

async function fetchData(token = process.env.GH_TOKEN) {
  const api = name => `https://api.github.com/repos/${name}`;
  const [latest, releases, head] = await Promise.all([
    getJson(`${api(APP)}/releases/latest`, token),
    collectPages(page => getJson(`${api(APP)}/releases?per_page=100&page=${page}`, token)),
    getJson(`${api(MARKET)}/commits/main`, token),
  ]);
  if (!/^[a-f0-9]{40}$/.test(head.sha)) throw new Error('插件市场源码 commit 无效');
  const catalogs = await Promise.all(INDEXES.map(async index => {
    const items = await getJson(`https://raw.githubusercontent.com/${MARKET}/${head.sha}/${index}`);
    if (!Array.isArray(items)) throw new Error(`插件目录格式无效：${index}`);
    return items.map(item => ({ ...item, SourceIndex: index }));
  }));
  return { latest, releases, plugins: catalogs.flat(), sourceCommit: head.sha, fetchedAt: new Date().toISOString() };
}

if (require.main === module) {
  const output = process.argv[2];
  if (!output) throw new Error('用法：node scripts/fetch-website-data.js <输出 JSON>');
  fetchData().then(data => {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(data, null, 2) + '\n');
    console.log(`官网数据：${data.releases.length} 个发行版本，${data.plugins.length} 个插件`);
  }).catch(error => { console.error(describeError(error)); process.exitCode = 1; });
}

module.exports = { collectPages, fetchData };
