'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const privacy = require('../src/infra/privacy');
const { createLogger } = require('../src/infra/logger');
const { Gateway } = require('../src/adapters/gateway');
const { validate, formatErrors } = require('../src/infra/configSchema');

test('隐私工具：wxid / 群号 / 手机号 / 邮箱 / 本机用户路径都打码', () => {
  const phone = '138' + '12345678';
  const raw = [
    'sender=wxid_test_secret123456',
    'chat=111111111@chatroom',
    'phone=' + phone,
    'mail=someone@example.com',
    'path=C:\\Users\\placeholder_user\\whale\\data',
    'token=Bearer abcdefghijklmnop',
    'url=https://example.com/hook?token=verysecretvalue&x=1',
  ].join(' ');
  const out = privacy.scrubSensitive(raw);
  assert.doesNotMatch(out, /wxid_test_secret/);
  assert.doesNotMatch(out, /111111111@chatroom/);
  assert.doesNotMatch(out, new RegExp(phone));
  assert.doesNotMatch(out, /someone@example\.com/);
  assert.doesNotMatch(out, /placeholder_user/);
  assert.doesNotMatch(out, /abcdefghijklmnop/);
  assert.doesNotMatch(out, /verysecretvalue/);
});

test('隐私工具：id/昵称只给稳定短哈希，正文只给长度', () => {
  assert.match(privacy.tagId('wxid_secret'), /^#[0-9a-f]{8}$/);
  assert.equal(privacy.tagId('wxid_secret'), privacy.tagId('wxid_secret'));
  // 敏感值不能用弱摘要：短哈希必须是 SHA-256 的前 8 位（CodeQL 会拦 SHA-1）。
  const expected = crypto.createHash('sha256').update('wxid_secret').digest('hex').slice(0, 8);
  assert.equal(privacy.shortHash('wxid_secret'), expected);
  assert.match(privacy.tagName('张三'), /^#[0-9a-f]{8}\(2字\)$/);
  assert.equal(privacy.textMeta('银行卡密码'), 'len=5');
  assert.equal(privacy.urlHost('https://example.com/secret?token=abc'), 'example.com');
});

test('logger 落盘兜底：新调用点忘了脱敏也不会把 wxid/群号写进文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-log-privacy-'));
  const file = path.join(dir, 'run.log');
  const logger = createLogger({ level: 'silent', fileLevel: 'debug', file });
  try {
    logger.info('debug sender=wxid_test_secret123456 chat=111111111@chatroom phone=' + ('138' + '12345678'));
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    logger.close();
  }
  const line = fs.readFileSync(file, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(line, /wxid_\*\*\*/);
  assert.match(line, /\*\*\*@chatroom/);
  assert.match(line, /phone=1\*{10}/);
  assert.doesNotMatch(line, /test_secret123456/);
});

test('网关入站日志不写发送者昵称和正文', async () => {
  const logs = [];
  const logger = {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
    debug: (m) => logs.push(String(m)),
  };
  const gateway = new Gateway({
    platform: 'wechat',
    logger,
    bot: {
      config: {},
      handle: async () => ({ action: 'ignore', reason: 'test' }),
    },
    options: { enabled: true, inboundToken: '', outboundUrl: '' },
  });
  const name = '真实昵称张三';
  const text = '我的银行卡密码是 123456，别告诉别人';
  await gateway.handleInbound({
    chat_id: 'wxid_test_secret123456',
    sender_id: 'wxid_test_secret123456',
    sender_name: name,
    chat_type: 'private',
    text,
  });
  const joined = logs.join('\n');
  assert.ok(joined.length > 0, '应该留下一条入站日志');
  assert.ok(!joined.includes(name), '不能写昵称：' + joined);
  assert.ok(!joined.includes(text), '不能写正文：' + joined);
  assert.match(joined, /sender=#/);
  assert.match(joined, /len=/);
});

test('配置校验日志不把 env.location 的实际值写出去', () => {
  const errors = validate({ env: { location: 123456789 } });
  assert.ok(errors.length > 0);
  const text = formatErrors(errors);
  assert.match(text, /env\.location/);
  assert.ok(!text.includes('123456789'), '地点值不能进日志：' + text);
  assert.match(text, /已隐藏/);
});

test('Node 已知日志调用点不再直接拼接正文/昵称/会话 id', () => {
  const root = path.join(__dirname, '..');
  const checks = [
    ['src/pipeline/chat.js', /提醒已登记：\$\{item\.text\}/],
    ['src/pipeline/chat.js', /判定在跟别人说话，不接：\$\{said\.slice/],
    ['src/pipeline/chat.js', /私聊 \$\{msg\.senderName\}/],
    ['src/adapters/gateway.js', /消息 \$\{msg\.senderName\}/],
    ['src/http/routes/reminders.js', /提醒已取消：' \+ out\.item\.text/],
    ['src/services/settings.js', /称呼已改为「\$\{name\}/],
  ];
  for (const [file, pattern] of checks) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, pattern, file + ' 又把隐私写回日志了');
  }
});
