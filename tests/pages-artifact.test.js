'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitForArtifact } = require('../scripts/wait-pages-artifact');

async function main() {
  let reads = 0;
  let waits = 0;
  const expected = 'github-pages-123-2';
  const artifact = await waitForArtifact(expected, async () => {
    reads += 1;
    return { artifacts: reads === 1 ? [] : [
      { id: 1, name: 'github-pages-123-1', expired: false },
      { id: 2, name: expected, expired: false },
    ] };
  }, async () => { waits += 1; });
  assert.equal(artifact.id, 2);
  assert.equal(reads, 2, '上传尚不可见时重新读取');
  assert.equal(waits, 1);
  await assert.rejects(waitForArtifact(expected, async () => ({ artifacts: [
    { id: 2, name: expected, expired: false }, { id: 3, name: expected, expired: false },
  ] }), async () => {}), /多个/);
  await assert.rejects(waitForArtifact(expected, async () => ({ artifacts: [
    { id: 2, name: expected, expired: true },
  ] }), async () => {}), /超时/);
  await assert.rejects(waitForArtifact(expected, async () => ({}), async () => {}), /格式/);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/pages.yml'), 'utf8');
  assert.match(workflow, /PAGES_ARTIFACT_NAME: github-pages-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /name: \$\{\{ env\.PAGES_ARTIFACT_NAME \}\}/);
  assert.match(workflow, /artifact_name: \$\{\{ env\.PAGES_ARTIFACT_NAME \}\}/);
  const upload = workflow.indexOf('uses: actions/upload-pages-artifact@');
  const wait = workflow.indexOf('run: node scripts/wait-pages-artifact.js');
  const deploy = workflow.indexOf('uses: actions/deploy-pages@');
  assert.ok(upload < wait && wait < deploy, '上传后确认可见，再部署');
  console.log('pages artifact: delayed visibility, attempt isolation, duplicates, expiry and workflow ordering passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
