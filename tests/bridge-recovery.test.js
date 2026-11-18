'use strict';

/**
 * 「挂一会儿就不理人，要重启桥接才行」的回归测试。
 *
 * 真实原因（2026-10-24 23:42 → 23:57 的日志）：
 *   1. 微信跑久了会把 Weixin.dll 里的 accessibility gate byte 归零，UIA 引擎变成「假死」：
 *      能读消息，但一条也发不出去；
 *   2. 桥接把 UIA 引擎缓存起来，只有缓存为空时才重新获取 —— 于是永远不去自愈，
 *      只能重启桥接（重启会重新热激活）；
 *   3. 附带：表情包转码写死了 imageio_ffmpeg（没装），每张表情都刷一条报错。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bridge = require('./helpers/bridge-source');

test('每次发送都会问一次 UIA 引擎，让它有机会自愈', () => {
  const fn = bridge.slice(bridge.indexOf('def uia_send'), bridge.indexOf('def recover_uia'));
  assert.match(fn, /gui\._get_uia\(\)/, 'uia_send 里要重新获取引擎，而不是只用缓存');
  assert.match(fn, /UIA_CACHE\[['"]u['"]\] = u/);
});

test('发送失败后会强制重新热激活并重试一次（不用重启桥接）', () => {
  assert.match(bridge, /def recover_uia/);
  assert.match(bridge, /gui\._get_uia\(refresh=True\)/, 'refresh=True 才会重写 gate byte');
  assert.match(bridge, /recover_uia\(['"]发送失败['"]\)/, '发送失败时要调用它');
  assert.match(bridge, /重新激活 UIA 后发送成功/);
});

test('收消息线程死了会被自动拉起并上报', () => {
  assert.match(bridge, /def listener_alive/);
  assert.match(bridge, /def listener_watch/);
  assert.match(bridge, /listener\.start\(\)/, '死了要重启监听');
  assert.match(bridge, /["']listener["']: listener_alive\(\)/, '心跳要上报收消息线程存活');
  assert.match(bridge, /Thread\(target=listener_watch/, '看门狗要真的启动');
});

test('表情包进识别链路：不装死、不送进图片下载', () => {
  // 2026-11-03 起产品口径变了：以前「表情包发了就装死」，现在要认出来再回话。
  // 老的三件套（截图/找缓存/取名）仍然不存在，但它们的能力已经搬进 emoji_vision。
  assert.doesNotMatch(bridge, /def describe_sticker/, '旧的表情包截图识别函数不要再回来');
  assert.doesNotMatch(bridge, /def screenshot_sticker/, '表情包截图兜底不要再回来');
  assert.doesNotMatch(bridge, /def _sticker_label/, '表情包取名不要再回来');
  assert.doesNotMatch(bridge, /收到表情包，装死/, '不能一边说装死一边识别');
  assert.match(bridge, /def describe_emoji\(msg\)/, '表情包要有识别入口');
  assert.match(bridge, /from emoji_vision import load_preview/, '走 emoji_vision 解本地缓存/回源');
  const fn = bridge.slice(bridge.indexOf('def on_message_inner'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  assert.match(body, /run_media_with_timeout\(lambda: describe_emoji\(msg\)/, '处理分支里要真的调用识别');
  assert.match(body, /对方发了一个表情包，画面是/, '识别结果要变成一句话交给对话');
});

test('被标成「图片」的表情包也要走表情包链路，不能当图片下载', () => {
  // 有的微信版本把表情包报成「图片」，正文里仍是 <emoji md5=...>。
  // 那种消息不能交给 describe_image：图片下载器找不到表情文件，只会白等 3.5 秒。
  const fn = bridge.slice(bridge.indexOf('def on_message_inner'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  assert.match(body, /mtype == ['"]图片['"] and ['"]<emoji['"] in content/, '要按正文里的 emoji XML 判定');
  assert.match(body, /is_emoji = /, '表情/动画表情/图片+emoji 要统一判定');
  assert.ok(body.indexOf('describe_emoji(msg)') < body.indexOf('describe_image(msg)'),
    '表情包分支必须排在图片识别之前');
  assert.doesNotMatch(body, /收到表情包（被标成图片），装死/, '不再装死');
});
test('识别失败要能定位到具体消息；图片取不到时让她回一句，表情/语音仍不回话', () => {
  // 以前失败只有一个 return，内部日志没有消息 id，用户问「这条为什么没回」只能猜。
  const fn = bridge.slice(bridge.indexOf('def on_message_inner'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  for (const kind of ['图片', '表情', '语音']) {
    assert.match(body, new RegExp(`media_failed\\(["']${kind}["']\\)`), `${kind}失败要先记日志`);
  }
  assert.match(body, /media-fail:%s:%s['"] % \(msg_id, kind\)/, '节流 key 要带消息 id，别把别的消息一起吞掉');
  assert.match(body, /emit=log_error/, '识别失败要写 error 级日志');
  assert.match(body, /会话=%s 发送者=%s 类型=%s 消息id=%s 原因=%s/, '一行里要能读全会话 / 发送者 / 类型 / id / 原因');
  // 图片取不到不再沉默：交给模型回一句，并禁止编造画面。
  assert.match(body, /media_placeholder = True/, '图片失败要标记为占位文本');
  assert.match(body, /不要编造图里的内容/, '占位文本要明确禁止编造');
  assert.match(body, /_guard_text = '%s#%s:%s'/, '占位文本按消息 id 查重，别把第二张图当重复消息');
});

/**
 * 2026-11-15 16:15 本机：发完一张图片 Bot 就不回话了，日志停在
 * 「图片缓存尚未就绪，等待重试（1/3）」，两分钟没动静，重启桥接才好。
 * 根因是 wechatauto 找不到图片 AES 密钥时会扫描微信内存并再挂 120 秒 monitor，
 * 而这段代码就在「同一会话串行」的消息 worker 里 —— 一张图能把整个会话卡死。
 * 现在密钥扫描有超时护栏，识别本身也在守护线程里等待，超时只放弃这一条。
 */
test('图片识别不会把整个会话卡死：密钥扫描和识别都有时间上限', () => {
  assert.match(bridge, /def install_key_scan_guard/, '要有图片密钥扫描护栏');
  assert.match(bridge, /monitor=False, monitor_timeout=monitor_timeout/, '必须强制单次扫描，不再等 120 秒 monitor');
  assert.match(bridge, /_scan_aes_key = scan/, '护栏要真的替换实例方法');
  assert.match(bridge, /install_key_scan_guard\(dl, log=log\)/, '创建媒体下载器时要装上护栏');
  assert.match(bridge, /def run_media_with_timeout/, '识别要有超时包一层');
  const fn = bridge.slice(bridge.indexOf('def on_message_inner'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  for (const kind of ['图片', '表情', '语音']) {
    assert.match(body, new RegExp(`run_media_with_timeout\\(lambda: \\w+\\(msg\\), ['"]${kind}['"]`),
      `${kind}识别必须走超时包装，不能直接同步调用`);
  }
});

/**
 * 图片密钥（AES）只能从 Weixin.exe 进程内存里反推，取不到时磁盘上的 .dat 解不开。
 * 这时不能只留一条“这条不回话”：先记清能不能离线派生、图来自哪个账号目录，
 * 再退到限时的微信预览取图。
 */
test('密钥取不到时有诊断日志和界面兜底，不是静默不理人', () => {
  assert.match(bridge, /def image_key_note/, '要记录 cfgDword 能不能离线派生');
  assert.match(bridge, /def image_dir_note/, '要记录图来自当前账号目录还是别处');
  assert.match(bridge, /图片密钥状态：%s；消息id=/, '失败日志要带密钥状态和消息 id');
  assert.match(bridge, /def image_ui_fallback/, '磁盘解不开时要有界面兜底');
  assert.match(bridge, /from image_ui_fallback import [^\n]*read_image_via_ui/, '兜底要接到界面子进程');
  assert.match(bridge, /def read_image_via_ui/, '预览操作要在限时子进程执行');
  assert.match(bridge, /def capture_preview_image/, '要有截预览窗的实现');
  assert.match(bridge, /def skipped\(reason\)/, '没处理的消息也要留痕');
  assert.match(bridge, /消息未处理：%s；会话=%s 消息id=/, '跳过日志要带原因和消息 id');
  assert.match(bridge, /图片预览兜底未取到图 reason=/, '兜底失败要写清卡在哪一步');
  const fn = bridge.slice(bridge.indexOf('def describe_image'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  assert.match(body, /image_ui_fallback/, '本地取不到图时必须尝试界面兜底');
  assert.ok(body.indexOf('image_dir_note') > 0, '取到图时要记录来源目录');
});

test('UIA 彻底不行时有键盘兜底通道（Ctrl+F 搜索会话 → 粘贴 → 回车，并回读确认）', () => {
  assert.match(bridge, /def keyboard_send/);
  assert.match(bridge, /VK_CONTROL/, '要用 Ctrl+F 搜索会话');
  assert.match(bridge, /CF_UNICODETEXT/, '文字走剪贴板，避免输入法/编码问题');
  assert.match(bridge, /db\.get_messages/, '发完要回读数据库确认，防止发错会话');
  assert.match(bridge, /键盘通道：抢不到前台/, '抢不到前台要明确放弃');
  assert.match(bridge, /KEYBOARD_FALLBACK/, '要有开关');
  assert.match(bridge, /keyboardFallback/, '开关读的是配置项');
});

/**
 * 「这玩意一直要放到前台，电脑只能干这个活」——实测推翻了这个前提。
 * 2026-10-25 02:10~02:20 实测（都在文件传输助手上，数据库回读确认）：
 *   正常窗口 6/6、最小化 6/6、最小化+前台被别的窗口占用 1/1、
 *   最小化+前台被最大化窗口占用 1/1、最小化连续 3/3 = 18/18 全成功。
 * 所以「必须占前台」是我们自己的 with_window_on_top 造成的，不是 UIA 的要求。
 */
test('默认后台发送，发完把窗口状态还原（电脑可以正常用）', () => {
  const bundled = path.join(root, 'runtime/python/python.exe');
  const python = process.env.WHALE_TEST_PYTHON || (fs.existsSync(bundled) ? bundled : 'python');
  const behavior = spawnSync(python, ['-B', path.join(root, 'tests/test_refactor_t13_runtime.py'),
    'DefaultSafetyTests.test_background_default_configured_and_restore',
    'DefaultSafetyTests.test_background_restore_on_error_and_identity_failure'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ifError(behavior.error);
  assert.equal(behavior.status, 0, behavior.stdout + behavior.stderr);
  assert.match(behavior.stderr, /Ran 2 tests/, '必须实际执行默认值、显式开关和还原行为回归');
  assert.match(behavior.stderr, /(?:^|\r?\n)OK(?:\r?\n|$)/);
  assert.match(bridge, /def force_send_foreground/, '抢前台要单独抽出来，只在兜底时用');
  assert.match(bridge, /def snapshot_win_state/, '发送前要记下窗口状态');
  assert.match(bridge, /def restore_win_state/, '发完要还原');
  const attempts = spawnSync(python, ['-B', path.join(root, 'tests/test_refactor_t14_attempts.py'),
    'AttemptTests.test_window_never_replays_callback_and_always_restores',
    'AttemptTests.test_known_preparation_failure_can_recover_before_one_effect',
    'AttemptTests.test_identity_and_draft_guards_stop_before_opaque_effect',
    'AttemptTests.test_opaque_false_is_handled_uncertain_once_not_twelve_sends'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ifError(attempts.error);
  assert.equal(attempts.status, 0, attempts.stdout + attempts.stderr);
  assert.match(attempts.stderr, /Ran 4 tests/);
  assert.match(attempts.stderr, /(?:^|\r?\n)OK(?:\r?\n|$)/);
  assert.match(bridge, /def install_quiet_uia/, '要让引擎别自己恢复窗口抢前台');
  // 顺序：先记状态 → 单次业务回调 → finally 还原；准备恢复由共享预算决定。
  const win = bridge.slice(bridge.indexOf('def with_window_on_top')).replace(/\r\n/g, '\n');
  const body = win.slice(0, win.indexOf('\n    def ') > 0 ? win.indexOf('\n    def ') : win.length);
  assert.match(body, /if restore_after:/, '表情包关闭且配置允许时走后台分支');
  assert.ok(body.indexOf('snapshot_win_state()') < body.indexOf('force_send_foreground(fn)'),
    '必须先记状态，再尝试发送');
  assert.match(body, /finally:\s*\n(\s+.*\n)*?\s+restore_win_state\(snap\)/, '还原要放在 finally，失败也要还回去');
});

/**
 * 「边打游戏边用」相关的第二个坑：最大化窗口被误判成全屏。
 * 3.3.1 实测：2560x1440 屏幕上最大化浏览器的 GetWindowRect 是 (-8,-8,2568,1448)，
 * 旧判定 `r[2] >= sw-2 and r[3] >= sh-2` 直接把它当全屏 → 桥接一直排队不回复
 * （实测 A/B：修前浏览器最大化时 care 一条都不发，修后正常发）。
 * 真全屏要保住安静：无边框盖满显示器的窗口（模拟游戏）实测 130 秒内 care 一条没发。
 */
test('全屏判定不能把「最大化窗口」误判成全屏', () => {
  const fn = bridge.slice(bridge.indexOf('def foreground_is_fullscreen'));
  const body = fn.slice(0, fn.indexOf('\n    def '));
  assert.match(body, /MonitorFromWindow/, '要按显示器矩形判断，不是屏幕尺寸');
  assert.match(body, /rcMonitor/, '真全屏仍要认出来（这时候保持安静）');
  assert.match(body, /WS_THICKFRAME/, '最大化窗口有可调边框，要据此排除');
  assert.match(body, /WS_CAPTION/, '有标题栏就不算全屏');
  assert.doesNotMatch(body, /GetSystemMetrics/, '不能再拿屏幕尺寸和 rect 直接比');
});
/**
 * 桥接启动时微信恰好在托盘里（主窗隐藏）→ gui 一直定位不到主窗，
 * 之后把微信拉出来也不会自愈，心跳永远 uia:false（3.3.2 实测：预热报
 * 「未找到微信主窗口」，60 秒后心跳仍是 false）。
 * 4.1.8 起后台巡检只读 UIA 缓存：连续 3 次拿不到就暂停自动探测，等实际发送
 * 或重连桥接再恢复；巡检本身不再重建窗口驱动，避免把最小化的微信拉起来卡死。
 */
test('心跳只读 UIA 缓存，连续失败只暂停后台探测而不重建驱动', () => {
  const hb = bridge.slice(bridge.indexOf('def bridge_heartbeat'));
  const body = hb.slice(0, hb.indexOf('\n    def ', 10));
  assert.match(body, /getattr\(gui, '_uia', None\)/, '心跳要读窗口驱动上的 UIA 缓存');
  assert.doesNotMatch(body, /_get_uia\(\)/, '不能调用 _get_uia()，它会热激活微信并重建控件树');
  assert.doesNotMatch(body, /new_window_driver\(\)/, '后台巡检不再强制重建窗口驱动');
  assert.match(body, /misses/, '要有连续失败计数');
  assert.match(body, /暂停后台预热和重建/, '要给出日志，别静默');
  // 心跳只检查能力，不替用户把微信弹出来：wake=False 安静待命。
  // 真发送时 _ensure_tree 才会按 Ctrl+Alt+W 唤醒；叫不醒再走「连续 3 次」兜底。
  assert.match(body, /ensure_uia_ready\(force=True, wake=False\)/, '心跳不能弹微信窗口');
  assert.ok(body.indexOf('ensure_uia_ready(force=True, wake=False)') < body.indexOf('misses >= 3'),
    '先检查，再攒失败次数兜底');
  assert.match(body, /misses >= 3/, '暂停后台探测的兜底不能丢');
});
/**
 * 键盘兜底是「Ctrl+F 搜索 → 回车 → 粘贴正文 → 回车」，中间不确认打开的是谁。
 * 2026-10-25 12:21 的生产日志里出现过「按键发了，但数据库里没确认到（可能发到了别的会话）」——
 * 私聊内容一旦发错人，收不回来。现在必须在粘贴正文之前核对当前会话名，
 * 核对不了就宁可这条失败。
 */
test('键盘兜底必须先核对会话，防发错人', () => {
  const fn = bridge.slice(bridge.indexOf('def keyboard_send'));
  const body = fn.slice(0, fn.indexOf('\n    def send_text', 10));
  assert.match(body, /def confirmed_target/, '要有核对函数');
  assert.match(body, /current_chat\(\)/, '用 UIA 的只读能力读当前会话名');
  assert.match(body, /为防发错人/, '不匹配要明确拒绝并写日志');
  // 顺序：先核对，再粘贴正文
  const iCheck = body.indexOf('confirmed_target()');
  const iPasteBody = body.indexOf('set_clip(text)');
  assert.ok(iCheck > 0 && iPasteBody > 0 && iCheck < iPasteBody,
    '必须先核对目标会话，再粘贴正文');
  assert.match(body, /读不到当前会话名/, '读不到会话名时也要放弃，不能盲发');
});
