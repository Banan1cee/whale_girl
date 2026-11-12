#!/usr/bin/env node
'use strict';

/**
 * 市场签名工具（零依赖）。
 *
 *   node scripts/plugin-market-sign.js catalog index.json --key private.pem
 *   node scripts/plugin-market-sign.js package dist/foo.zip --key private.pem
 *   node scripts/plugin-market-sign.js verify index.json --signature-file index.json.sig --public-key public.pem
 *
 * catalog 会生成 index.json.sig；package 只输出 Base64 签名，由维护者填进目录条目的 Signature 字段。
 * 私钥只能放在离线环境，不要提交到任何仓库。详细流程见 docs/插件市场签名.md。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const command = args.shift();

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' 缺少值');
  args.splice(index, 2);
  return value;
}

function usage() {
  console.error('用法：');
  console.error('  node scripts/plugin-market-sign.js catalog <catalog.json> --key <private.pem>');
  console.error('  node scripts/plugin-market-sign.js package <plugin.zip> --key <private.pem>');
  console.error('  node scripts/plugin-market-sign.js verify <file> --signature-file <file.sig> --public-key <public.pem>');
  process.exit(1);
}

function readKey(file, kind) {
  if (!file) usage();
  const text = fs.readFileSync(file, 'utf8').trim();
  if (kind === 'private') return crypto.createPrivateKey(text);
  // 公钥既支持 PEM，也支持 PluginTrust.cs 里那种 Base64 SPKI。
  return text.includes('BEGIN PUBLIC KEY')
    ? crypto.createPublicKey(text)
    : crypto.createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
}

try {
  if (command === 'catalog' || command === 'package') {
    const file = args.shift();
    if (!file) usage();
    const key = readKey(option('--key'), 'private');
    const signature = crypto.sign('sha256', fs.readFileSync(file), key).toString('base64');
    if (command === 'catalog') {
      fs.writeFileSync(file + '.sig', signature + '\n');
      console.log('已写入 ' + file + '.sig');
    } else {
      console.log(signature);
    }
  } else if (command === 'verify') {
    const file = args.shift();
    if (!file) usage();
    const signatureFile = option('--signature-file');
    const signatureArg = option('--signature');
    const key = readKey(option('--public-key'), 'public');
    const signature = signatureFile ? fs.readFileSync(signatureFile, 'utf8') : signatureArg;
    if (!signature) usage();
    const ok = crypto.verify('sha256', fs.readFileSync(file), key, Buffer.from(signature.trim(), 'base64'));
    console.log(ok ? '签名有效' : '签名无效');
    process.exit(ok ? 0 : 2);
  } else {
    usage();
  }
} catch (error) {
  console.error('签名失败：' + error.message);
  process.exit(1);
}
