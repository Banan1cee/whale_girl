"""桥接启动接线的回归测试（不导入 engine：它有启动副作用）。

现场问题：`main()` 里定义了一个无参的同名 `start_reminder_watch`（用闭包里的
bot_url/token/send_text 构造 ReminderRunner），但调用处仍按模块顶部从
`reminder_watch` 导入的那个签名传了 http/base/token/... 六个关键字参数。

拆分后：
- 启动器是 `loop_mixin.LoopMixin.start_reminder_watch(self)`；
- `app.py` 用 `self.start_reminder_watch()` 无参调用并写回 `G.REMINDER_RUNNER`。

保留签名和实例回收检查，并通过真实组合类与注入依赖验证实际发送接线。
"""
import ast
import pathlib
import unittest
import importlib.util
import inspect
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / 'bridge' / 'app.py'
LOOP = ROOT / 'bridge' / 'loop_mixin.py'


def find(node, name):
    for child in ast.walk(node):
        if isinstance(child, ast.FunctionDef) and child.name == name:
            return child
    return None


class ReminderWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ast.parse(APP.read_text(encoding='utf-8'))
        cls.loop = ast.parse(LOOP.read_text(encoding='utf-8'))
        cls.starter = find(cls.loop, 'start_reminder_watch')
        assert cls.starter is not None, 'loop_mixin.py 里找不到 start_reminder_watch()'

    def test_nested_starter_takes_only_self(self):
        self.assertEqual([a.arg for a in self.starter.args.args], ['self'])
        self.assertEqual(len(self.starter.args.kwonlyargs), 0)

    def test_call_matches_nested_signature(self):
        calls = [
            node for node in ast.walk(self.app)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'start_reminder_watch'
        ]
        self.assertTrue(calls, 'app.py 里没有启动提醒调度器')
        for call in calls:
            self.assertEqual(len(call.args), 0, f'调用传了位置参数（第 {call.lineno} 行）')
            self.assertEqual(len(call.keywords), 0,
                             f'调用传了关键字参数（第 {call.lineno} 行）：'
                             + ', '.join(k.arg or '**' for k in call.keywords))

    def test_runner_is_assigned_for_shutdown(self):
        """退出分支要能拿到 REMINDER_RUNNER，所以启动器必须给它赋值。"""
        assigns = [
            node for node in ast.walk(self.starter)
            if isinstance(node, ast.Attribute) and node.attr == 'REMINDER_RUNNER'
            and isinstance(node.ctx, ast.Store)
        ]
        self.assertTrue(assigns, '启动器没有给 REMINDER_RUNNER 赋值')


class ActualRuntimeReminderTests(unittest.TestCase):
    """Import the real composition class with inert dependencies, never engine.

    The app's exact reminder assembly statement is executed against its real
    inherited starter. Network, UI, thread creation and the other mixins are
    replaced at the module boundary, rather than rewriting self/G in source.
    """

    def setUp(self):
        self.http = SimpleNamespace(get=Mock(), post=Mock())
        self.http.get.return_value = self.response({'ok': True, 'items': [], 'nextDueAt': 0})
        self.http.post.return_value = self.response({'ok': True})
        self.engine = ModuleType('engine')
        self.engine.LOCAL_HTTP = self.http
        self.engine.log = Mock()
        self.engine.threading = SimpleNamespace(Thread=Mock())
        self.engine.REMINDER_RUNNER = None
        modules = {'engine': self.engine}
        for module_name, class_name in (
            ('account_mixin', 'AccountMixin'), ('window_mixin', 'WindowMixin'),
            ('sender_mixin', 'SenderMixin'), ('sticker_mixin', 'StickerMixin'),
            ('voice_mixin', 'VoiceMixin'), ('receiver_mixin', 'ReceiverMixin'),
        ):
            module = ModuleType(module_name)
            setattr(module, class_name, type(class_name, (), {}))
            modules[module_name] = module
        parent = ModuleType('parent_watch')
        parent.start_watchdog = Mock()
        modules['parent_watch'] = parent
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, modules).start()
        patch.object(sys, 'path', [str(ROOT / 'bridge')] + sys.path).start()
        self.reminders = self.load('reminder_watch', ROOT / 'bridge/reminder_watch.py')
        self.engine.start_reminder_watch = self.reminders.start_reminder_watch
        self.thread = patch.object(self.reminders.threading, 'Thread').start()
        self.load('loop_mixin', LOOP)
        self.app = self.load('app', APP)
        self.runtime = self.app.BridgeRuntime()
        self.runtime.bot_url = 'http://127.0.0.1:9191/webhook/wechat'
        self.runtime.token = 'fixture-token'
        self.runtime.display_name = Mock(return_value='fixture-chat')
        self.runtime.send_text = Mock(return_value=True)
        self.runtime.send_at = Mock(return_value=True)
        self.runtime.send_voice_reply = Mock(return_value=True)

    def load(self, name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        patch.dict(sys.modules, {name: module}).start()
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def response(body, status=200):
        result = SimpleNamespace(status_code=status, json=Mock(return_value=body))
        result.raise_for_status = Mock(side_effect=RuntimeError('fixture HTTP failure') if status >= 400 else None)
        return result

    @staticmethod
    def item(**overrides):
        return dict({'id': 'fixture-id', 'wxid': 'fixture-room', 'name': 'fixture-chat',
                     'text': 'fixture reminder', 'chatType': 'group', 'atName': 'fixture-member'}, **overrides)

    def assemble(self, *items):
        self.http.get.return_value = self.response({'ok': True, 'items': list(items), 'nextDueAt': 0})
        start = find(ast.parse(APP.read_text(encoding='utf-8')), 'start')
        node = next(n for n in start.body if isinstance(n, ast.Assign)
                    and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute)
                    and n.value.func.attr == 'start_reminder_watch')
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(APP), 'exec'),
             {'self': self.runtime, 'G': self.engine})
        runner = self.engine.REMINDER_RUNNER
        self.assertIsInstance(runner, self.reminders.ReminderRunner)
        return runner

    def test_starter_keeps_no_argument_signature(self):
        self.assertEqual(list(inspect.signature(self.app.BridgeRuntime.start_reminder_watch).parameters), ['self'])

    def test_real_app_assembly_preserves_group_mention_and_identity(self):
        runner = self.assemble(self.item())
        self.assertEqual(runner.step()[0], 1)
        self.runtime.send_at.assert_called_once_with('fixture-member', 'fixture reminder', 'fixture-chat', 'fixture-room')
        self.runtime.send_text.assert_not_called()
        call = self.http.get.call_args
        self.assertEqual(call.args[0], 'http://127.0.0.1:9191/api/reminders/due')
        self.assertEqual(call.kwargs['headers'], {'x-whale-bridge': '1', 'x-bot-token': 'fixture-token'})

    def test_blank_target_is_rejected_before_any_send(self):
        runner = self.assemble(self.item(wxid='   '))
        self.assertEqual(runner.step()[0], 0)
        self.runtime.send_text.assert_not_called()
        self.runtime.send_at.assert_not_called()
        self.assertFalse(self.http.post.call_args.kwargs['json']['ok'])

    def test_display_name_fallback_and_private_send_are_preserved(self):
        runner = self.assemble(self.item(name='', chatType='private'))
        runner.step()
        self.runtime.display_name.assert_called_once_with('fixture-room')
        self.runtime.send_text.assert_called_once_with('fixture reminder', 'fixture-chat', 'fixture-room')

    def test_due_http_failure_is_not_empty_work(self):
        runner = self.assemble()
        self.http.get.return_value = self.response({'ok': True}, 500)
        with self.assertRaises(RuntimeError):
            runner.fetch()
        self.runtime.send_text.assert_not_called()

    def test_due_business_failure_is_not_empty_work(self):
        runner = self.assemble()
        self.http.get.return_value = self.response({'ok': False})
        with self.assertRaises(RuntimeError):
            runner.fetch()

    def test_bad_due_json_is_an_error(self):
        runner = self.assemble()
        self.http.get.return_value.json.side_effect = ValueError('fixture JSON failure')
        with self.assertRaises((ValueError, RuntimeError)):
            runner.fetch()

    def test_ack_http_failure_is_visible_without_resending_or_losing_batch(self):
        runner = self.assemble(self.item(chatType='private'), self.item(id='fixture-second', chatType='private'))
        self.http.post.return_value = self.response({'ok': True}, 500)
        self.engine.log.reset_mock()
        self.assertEqual(runner.step()[0], 2)
        self.assertEqual(self.runtime.send_text.call_count, 2)
        self.assertEqual(self.http.post.call_count, 2)
        self.assertTrue(any('回执' in str(call.args) for call in self.engine.log.call_args_list))

    def test_plugin_text_permission_and_revocation_still_block_send(self):
        runner = self.assemble(self.item(kind='plugin', chatType='private'))
        self.http.post.side_effect = lambda url, **kw: self.response({'ok': not url.endswith('/permission')})
        self.assertEqual(runner.step()[0], 0)
        self.runtime.send_text.assert_not_called()
        self.runtime.send_at.assert_not_called()
        self.runtime.send_voice_reply.assert_not_called()

    def test_plugin_voice_keeps_permission_recheck_during_preparation(self):
        runner = self.assemble(self.item(kind='plugin', delivery='voice'))
        self.assertEqual(runner.step()[0], 1)
        self.runtime.send_voice_reply.assert_called_once()
        self.runtime.send_text.assert_not_called()
        cancelled = self.runtime.send_voice_reply.call_args.kwargs['cancelled']
        self.http.post.return_value = self.response({'ok': False})
        self.assertTrue(cancelled())

    def test_shutdown_uses_the_actual_retained_runner(self):
        runner = self.assemble()
        self.runtime.pipeline = SimpleNamespace(close=Mock())
        self.runtime.listener = SimpleNamespace(stop=Mock())
        start = find(ast.parse(APP.read_text(encoding='utf-8')), 'start')
        handler = next(n for n in ast.walk(start) if isinstance(n, ast.ExceptHandler)
                       and isinstance(n.type, ast.Name) and n.type.id == 'KeyboardInterrupt')
        exec(compile(ast.Module(body=handler.body, type_ignores=[]), str(APP), 'exec'),
             {'self': self.runtime, 'G': self.engine, 'moments_reader': None})
        self.assertTrue(runner.stopped)
        self.assertTrue(runner.wake.is_set())
        self.runtime.pipeline.close.assert_called_once_with(wait=False)
        self.runtime.listener.stop.assert_called_once()
        self.assertEqual(self.thread.return_value.start.call_count
                         + self.engine.threading.Thread.return_value.start.call_count, 1)


if __name__ == '__main__':
    unittest.main()
