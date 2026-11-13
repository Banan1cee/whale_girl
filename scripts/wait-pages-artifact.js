'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { describeError } = require('../src/infra/errors');

async function waitForArtifact(name, readArtifacts, sleep = delay) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await readArtifacts();
    if (!Array.isArray(result.artifacts)) throw new Error('Pages 产物元数据格式无效');
    const matches = result.artifacts.filter(item => item.name === name && !item.expired);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error('Pages 存在多个同名产物，拒绝部署');
    // 上传成功不等于元数据已可见，限制等待时间而不是盲目进入 deploy-pages。
    if (attempt < 11) await sleep(5000);
  }
  throw new Error('等待 Pages 产物可见超时');
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, PAGES_ARTIFACT_NAME: name, GH_TOKEN: token } = process.env;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^\d+$/.test(runId || '') || !name || !token) throw new Error('Pages 运行参数不完整');
  const url = `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&name=${encodeURIComponent(name)}`;
  const artifact = await waitForArtifact(name, async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'WhaleGirl-Pages' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Object.assign(new Error('读取 Pages 产物失败'), { status: response.status });
    return response.json();
  });
  console.log(`Pages 产物已可见：${name} (${artifact.id})`);
}

if (require.main === module) main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
module.exports = { waitForArtifact };
