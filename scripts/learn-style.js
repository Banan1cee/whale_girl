#!/usr/bin/env node
'use strict';

/**
 * 从已有聊天里学「使用者怎么说话」的命令行入口。
 *
 * 用法：
 *   node scripts/learn-style.js
 *   node scripts/learn-style.js --source export --file D:\wechat-export.json
 *   node scripts/learn-style.js --owner wxid_xxx --use-llm --out data/style-profile.json
 *
 * 只写统计和总结（data/style-profile.json），不打印、不落盘任何消息正文。
 */
const path = require('node:path');

const { ensureConfigFile, loadConfig, projectRoot } = require('../src/infra/config');
const styleProfile = require('../src/persona/styleProfile');

function usage() {
  return [
    '用法：node scripts/learn-style.js [选项]',
    '  --source memory|export   数据来源（默认 memory）',
    '  --file <path>            export 模式的微信导出 JSON',
    '  --owner <wxid/昵称>      只统计这个人说的话（默认取 persona.master）',
    '  --use-llm                允许把统计和少量抽样交给当前模型总结',
    '  --out <path>             输出文件（默认 data/style-profile.json）',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { source: 'memory', file: '', owner: '', useLlm: false, out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--use-llm') { options.useLlm = true; continue; }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const takeValue = () => {
      if (inline != null) return inline;
      i += 1;
      return i < argv.length ? argv[i] : '';
    };
    if (name === '--source') { options.source = String(takeValue() || '').trim(); continue; }
    if (name === '--file') { options.file = String(takeValue() || '').trim(); continue; }
    if (name === '--owner') { options.owner = String(takeValue() || '').trim(); continue; }
    if (name === '--out') { options.out = String(takeValue() || '').trim(); continue; }
    throw new Error(`不认识的参数：${arg}\n${usage()}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!['memory', 'export'].includes(options.source)) {
    throw new Error('--source 只能是 memory 或 export');
  }
  if (options.source === 'export' && !options.file) {
    throw new Error('--source export 需要配合 --file <导出 JSON 路径>');
  }

  const root = projectRoot();
  ensureConfigFile(root);
  const config = loadConfig({ root });

  let llm = null;
  if (options.useLlm) {
    // 只构造模型客户端，不启动 Bot / HTTP / 记忆等运行时。
    const { createLogger } = require('../src/infra/logger');
    const { DeepSeekClient } = require('../src/llm/client');
    llm = new DeepSeekClient({ config, logger: createLogger({ level: 'warn', tag: 'learn-style' }) });
  }

  const owner = options.owner || undefined;
  const profile = options.source === 'export'
    ? await styleProfile.analyzeExport(config, path.resolve(root, options.file), { owner, useLlm: options.useLlm, llm })
    : await styleProfile.analyzeMemory(config, { owner, useLlm: options.useLlm, llm });

  const target = options.out
    ? path.resolve(root, options.out)
    : styleProfile.profilePath(config);
  styleProfile.save(config, profile, target);

  console.log(`样本：${profile.sampleCount} 条`);
  console.log(`会话：${profile.chatCount} 个`);
  console.log(`输出：${target}`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      const line = String((err && err.message) || err).split(/[\r\n]/)[0];
      console.error('风格学习失败：' + line);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, main };
