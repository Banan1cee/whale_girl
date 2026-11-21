#!/usr/bin/env node
'use strict';

/**
 * 假的 dsh headless CLI，只用于 relay/tests/dsh.test.js。
 *
 * 为什么存在：真 CLI 需要 API Key、联网、几秒起步；驱动层的判定分支（新 session、续接、
 * 失败、超时杀树、脏 stdout）必须能在秒级、离线、可重复地覆盖。
 *
 * 场景由 FAKE_DSH_SCENARIO 选择：
 *   ok        正常完成（新 session）
 *   resume    正常完成，session 事件回显传入的 --session-id
 *   fail      final.reason.kind = 'error'，exit 1（与真实 dsh 一致）
 *   exit3     无 final，stderr 有噪音，exit 3
 *   nofinal   exit 0 但不输出 final
 *   dirty     先吐非法 JSON 行 + stderr 噪音，再正常完成
 *   errorline 以 json 模式输出 {type:'error'} 并 exit 1（模拟未知 session）
 *   hang      输出 session 后挂起，并起一个孙进程；用于验证整棵进程树被杀
 *
 * 观测点：FAKE_DSH_CAPTURE 指向的文件写入 JSON：
 *   { argv, stdin, cwd, tag }，用于断言 prompt 走 stdin、--session-id/--add-dir 等参数确实传了。
 * FAKE_DSH_CHILD_PID 记录 hang 场景孙进程的 pid。
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const scenario = process.env.FAKE_DSH_SCENARIO || 'ok';
const capturePath = process.env.FAKE_DSH_CAPTURE;
const childPidPath = process.env.FAKE_DSH_CHILD_PID;

function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

const sessionArg = argValue('--session-id');
const sessionId = sessionArg || process.env.FAKE_DSH_NEW_SESSION_ID || 'session-fake-new';

let stdinText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinText += chunk;
});
process.stdin.on('end', () => {
  run().catch((error) => {
    process.stderr.write('fake-dsh: ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
});

function writeCapture(extra) {
  if (!capturePath) return;
  const record = Object.assign(
    {
      argv: args,
      stdin: stdinText,
      cwd: process.cwd(),
      tag: process.env.FAKE_DSH_TAG || null,
    },
    extra || {}
  );
  fs.writeFileSync(capturePath, JSON.stringify(record));
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

function emitSession() {
  emit({ type: 'session', sessionId, cwd: process.cwd() });
  emit({ type: 'status', phase: 'turn_start', turn: 1 });
  emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
}

function emitFinal(text, reason, code) {
  emit({ type: 'final', sessionId, reason, text });
  process.exitCode = code;
}

async function run() {
  writeCapture({ scenario });

  switch (scenario) {
    case 'ok':
    case 'resume': {
      emitSession();
      emit({ type: 'thinking', text: '（假 CLI 的思考）' });
      emit({ type: 'text', text: '（假 CLI 的中间文本）' });
      emit({ type: 'tool_call', callId: 'call-1', tool: 'read', input: { path: 'x' } });
      emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'ok' });
      emit({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
      emitFinal(process.env.FAKE_DSH_TEXT || '收到，这是假 CLI 的回复。', { kind: 'completed' }, 0);
      return;
    }
    case 'fail': {
      emitSession();
      process.stderr.write('fake-dsh: 模拟模型调用失败\n');
      const reason = { kind: 'error', error: { code: 'fake/llm-error', message: '模拟失败' } };
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason });
      emitFinal('', reason, 1);
      return;
    }
    case 'exit3': {
      emitSession();
      process.stderr.write('fake-dsh: 模拟崩溃（无 final）\n');
      process.exitCode = 3;
      return;
    }
    case 'nofinal': {
      emitSession();
      emit({ type: 'text', text: '只说不收尾' });
      process.exitCode = 0;
      return;
    }
    case 'dirty': {
      process.stdout.write('this is not json\n');
      process.stdout.write('{"type": "session", "broken": \n');
      process.stderr.write('fake-dsh: harmless stderr noise\n');
      emitSession();
      emit({ type: 'text', text: '脏输出之后仍然成功' });
      emitFinal('脏输出之后仍然成功', { kind: 'completed' }, 0);
      return;
    }
    case 'errorline': {
      emit({ type: 'error', message: 'session "session-missing" does not exist' });
      process.stderr.write('dsh: fake unknown session\n');
      process.exitCode = 1;
      return;
    }
    case 'hang': {
      emitSession();
      emit({ type: 'text', text: '开始挂起' });
      if (childPidPath) {
        const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        fs.writeFileSync(childPidPath, String(grandchild.pid));
      }
      // 保持事件循环活着，直到被 taskkill /T 杀掉。
      setInterval(() => {}, 1000);
      return;
    }
    default: {
      process.stderr.write('fake-dsh: 未知场景 ' + scenario + '\n');
      process.exitCode = 2;
    }
  }
}
