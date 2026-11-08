'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchParentPipe } = require('../src/infra/parentGuard');

test('启动器管道关闭时通知内核退出，end 和 close 只触发一次', () => {
  const stream = new EventEmitter();
  let closed = 0;
  watchParentPipe(stream, () => { closed += 1; });

  stream.emit('end');
  stream.emit('close');
  assert.equal(closed, 1);
});

test('只收到 close 也算父进程退出', () => {
  const stream = new EventEmitter();
  let closed = 0;
  watchParentPipe(stream, () => { closed += 1; });

  stream.emit('close');
  assert.equal(closed, 1);
});

test('取消监听后不再触发', () => {
  const stream = new EventEmitter();
  let closed = 0;
  const stop = watchParentPipe(stream, () => { closed += 1; });

  stop();
  stream.emit('end');
  stream.emit('close');
  assert.equal(closed, 0);
});

test('拿不到 stdin 时安全退化', () => {
  assert.doesNotThrow(() => watchParentPipe(null, () => { throw new Error('不该触发'); })());
});
