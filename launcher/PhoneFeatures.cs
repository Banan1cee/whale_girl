using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;

namespace WhaleLauncher
{
    internal sealed class PhoneFeatures
    {
        private readonly string _root;
        private readonly RuntimeSupervisor _supervisor;
        private readonly PluginMarket _market;
        private CancellationTokenSource _voiceTestCancel;
        private Task<string> _voiceTest;
        public PhoneFeatures(RuntimeSupervisor supervisor, PluginMarket market)
        {
            _supervisor = supervisor;
            _root = supervisor.BaseDir;
            _market = market;
        }

        public static bool Handles(string action) => action is
            "voice-read" or "voice-toggle" or "voice-save" or "voice-check-key" or "voice-catalog" or
            "voice-test" or "voice-test-status" or "voice-install-driver" or "sticker-open" or "sticker-open-collected" or "moments-open-pictures" or
            "appearance-read" or "appearance-save" or
            "market-read" or "market-install" or "market-enabled" or "market-remove";

        public async Task<object> RunAsync(string action, JsonElement payload)
        {
            try
            {
                return action switch
                {
                    "voice-read" => ReadVoice(),
                    "voice-toggle" => ToggleVoice(payload),
                    "voice-save" => SaveVoice(payload),
                    "voice-check-key" => await CheckVoiceKeyAsync(payload),
                    "voice-catalog" => await VoiceCatalogAsync(payload),
                    "voice-test" => StartVoiceTest(payload),
                    "voice-test-status" => VoiceTestStatus(),
                    "voice-install-driver" => InstallVoiceDriver(payload),
                    "sticker-open-collected" => OpenCollectedStickers(),
                    "sticker-open" => await OpenStickerLibraryAsync(payload),
                    "moments-open-pictures" => await OpenMomentsPicturesAsync(payload),
                    "appearance-read" => new { ok = true, dark = Appearance.IsDark, monet = Appearance.MonetEnabled, halo = Appearance.TextHaloEnabled },
                    "appearance-save" => SaveAppearance(payload),
                    "market-read" => await ReadMarketAsync(),
                    "market-install" => await InstallAsync(payload),
                    "market-enabled" => ChangePlugin(payload, remove: false),
                    "market-remove" => ChangePlugin(payload, remove: true),
                    _ => new { ok = false, error = "未知操作。" },
                };
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidDataException)
            {
                return new { ok = false, error = ex.Message };
            }
            catch (OperationCanceledException) { return new { ok = false, error = "语音服务响应超时。" }; }
            catch (System.Net.Http.HttpRequestException) { return new { ok = false, error = "语音服务连接失败，请检查 Key 和厂商状态。" }; }
        }

        private AutoVoiceSettings Voice() => AutoVoiceSettings.LoadOrDefault(_root);

        private static (string id, string label)[] Devices()
        {
            using var audio = new MMDeviceEnumerator();
            return audio.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).Select(device =>
            {
                using (device) return (device.ID, device.FriendlyName);
            }).ToArray();
        }

        private object ReadVoice()
        {
            var config = Voice();
            var profiles = SpeechProviders.All.Select(provider =>
            {
                var defaults = SpeechProviders.Defaults(provider.Id);
                var saved = config.Profiles?.GetValueOrDefault(provider.Id) ?? defaults;
                var model = provider.Id == config.Provider ? config.Model : saved.Model;
                var voice = provider.Id == config.Provider ? config.Voice : saved.Voice;
                return new { id = provider.Id, label = provider.Name, model, voice, keyUrl = provider.KeyUrl,
                    hasKey = !string.IsNullOrWhiteSpace(BreezeSpeech.LoadKey(SpeechProviders.KeyFile(_root, provider.Id))),
                    instructions = provider.Id == config.Provider ? config.Instructions : saved.Instructions,
                    models = Choices(SpeechProviders.Choices(provider.Id, null, model, false)),
                    voices = Choices(SpeechProviders.Choices(provider.Id, null, voice, true, model)) };
            });
            return new
            {
                ok = true,
                enabled = config.Enabled,
                probability = config.Probability,
                groups = config.Groups,
                privateChats = config.Private,
                provider = config.Provider,
                model = config.Model,
                voice = config.Voice,
                device = config.Device,
                instructions = config.Instructions,
                hotkey = config.RecordingHotkey,
                timeout = config.SynthTimeoutSec,
                hasKey = SpeechProviders.All.Any(p => p.Id == config.Provider) &&
                    !string.IsNullOrWhiteSpace(BreezeSpeech.LoadKey(SpeechProviders.KeyFile(_root, config.Provider))),
                profiles,
                devices = config.Enabled ? Devices().Select(device => new { device.id, device.label }) : [],
                test = VoiceTestStatus(),
            };
        }

        private object ToggleVoice(JsonElement body)
        {
            var enabled = Boolean(body, "enabled");
            AutoVoiceSettings.SetEnabled(_root, enabled);
            if (!enabled) _voiceTestCancel?.Cancel();
            return new { ok = true, enabled, message = enabled ? "语音发送实验开关已开启。" : "已关闭语音发送。" };
        }

        private object SaveVoice(JsonElement body)
        {
            var config = Voice();
            if (!config.Enabled) throw new ArgumentException("请先打开语音发送实验开关。");
            var provider = SpeechProviders.Get(Text(body, "provider", 32));
            var model = Text(body, "model", 160);
            var voice = Text(body, "voice", 160);
            var device = Text(body, "device", 250);
            var instructions = Text(body, "instructions", 1000);
            var hotkey = RecordingShortcut.Parse(Text(body, "hotkey", 60)).Label;
            var apiKey = Text(body, "apiKey", 250, optional: true);
            if (apiKey.Any(char.IsWhiteSpace)) throw new ArgumentException("API Key 不能包含空格或换行。");
            var keyFile = SpeechProviders.KeyFile(_root, provider.Id);
            if (string.IsNullOrWhiteSpace(apiKey) && string.IsNullOrWhiteSpace(BreezeSpeech.LoadKey(keyFile)))
                throw new ArgumentException("请填写当前语音厂商的 API Key。");
            if (string.IsNullOrWhiteSpace(model) || string.IsNullOrWhiteSpace(voice) || !Devices().Any(item => item.id == device))
                throw new ArgumentException("请填写模型、音色，并选择电脑上已连接的播放设备。");
            config.Probability = Number(body, "probability", 0, 100);
            config.SynthTimeoutSec = Number(body, "timeout", 5, 90);
            config.Groups = Boolean(body, "groups");
            config.Private = Boolean(body, "privateChats");
            config.Provider = provider.Id;
            config.Address = provider.BaseUrl;
            config.Model = model;
            config.Voice = voice;
            config.Device = device;
            config.Instructions = instructions;
            config.RecordingHotkey = hotkey;
            config.Profiles ??= new();
            if (!config.Profiles.TryGetValue(provider.Id, out var profile) || profile == null) profile = new SpeechProfile();
            profile.Model = model;
            profile.Voice = voice;
            profile.Instructions = instructions;
            profile.ModelVoices ??= new();
            profile.ModelVoices[model] = voice;
            config.Profiles[provider.Id] = profile;
            BreezeSpeech.SaveKey(keyFile, apiKey);
            config.Save(_root);
            return new { ok = true, message = "语音配置已保存。" };
        }

        private (string id, string key) VoiceCredentials(JsonElement body)
        {
            if (!Voice().Enabled) throw new ArgumentException("请先打开语音发送实验开关。");
            var id = SpeechProviders.Get(Text(body, "provider", 32)).Id;
            var key = Text(body, "apiKey", 250, optional: true);
            if (key.Any(char.IsWhiteSpace)) throw new ArgumentException("API Key 不能包含空格或换行。");
            return (id, key.Length == 0 ? BreezeSpeech.LoadKey(SpeechProviders.KeyFile(_root, id)) : key);
        }

        private async Task<object> CheckVoiceKeyAsync(JsonElement body)
        {
            var (id, key) = VoiceCredentials(body);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var result = await SpeechProviders.CheckKey(id, key, timeout.Token);
            return new { ok = result.Available, message = result.Message, error = result.Message };
        }

        private static object Choices(IEnumerable<BreezeSpeech.Choice> choices) => choices.Take(500)
            .Select(choice => new { id = choice.Id, label = choice.Name }).ToArray();

        private async Task<object> VoiceCatalogAsync(JsonElement body)
        {
            var (id, key) = VoiceCredentials(body);
            var model = Text(body, "model", 160);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(24));
            var models = SpeechProviders.Catalog(id, key, false, "", timeout.Token);
            var voices = SpeechProviders.Catalog(id, key, true, "", timeout.Token, model: model);
            await Task.WhenAll(models, voices);
            return new { ok = true, models = Choices(await models), voices = Choices(await voices) };
        }

        private object StartVoiceTest(JsonElement body)
        {
            if (!Boolean(body, "confirm")) throw new ArgumentException("请确认发送测试语音。");
            if (_voiceTest != null && !_voiceTest.IsCompleted) throw new ArgumentException("已有测试正在进行。");
            SaveVoice(body);
            _voiceTestCancel?.Dispose();
            _voiceTestCancel = new CancellationTokenSource();
            _voiceTest = RunVoiceTestAsync(_voiceTestCancel.Token);
            return new { ok = true, message = "测试已提交，刷新本页可查看结果。" };
        }

        private async Task<string> RunVoiceTestAsync(CancellationToken token)
        {
            try { return await VoiceSendTest.Run(_root, token); }
            catch (OperationCanceledException) { return "测试语音已取消。"; }
            catch (Exception) { return "测试未完成。请检查电脑上的桥接状态和文件传输助手。"; }
        }

        private object VoiceTestStatus() => new
        {
            ok = true,
            running = _voiceTest is { IsCompleted: false },
            message = _voiceTest?.IsCompletedSuccessfully == true ? _voiceTest.Result : "",
        };

        private object InstallVoiceDriver(JsonElement body)
        {
            if (!Boolean(body, "confirm")) throw new ArgumentException("请确认在电脑上打开驱动安装程序。");
            VbCablePackage.OpenInstaller(_root);
            return new { ok = true, message = "驱动安装程序已打开，请在电脑上完成确认和安装。" };
        }

        private object OpenCollectedStickers()
        {
            var folder = Path.Combine(_supervisor.DataDir, "收集的表情包");
            Directory.CreateDirectory(folder);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(folder) { UseShellExecute = true });
            return new { ok = true, message = "已在电脑上请求打开表情包收集文件夹。" };
        }

        private async Task<object> OpenStickerLibraryAsync(JsonElement body)
        {
            var emotion = Text(body, "emotion", 80, optional: true);
            var target = "";
            if (_supervisor.NodeRunning)
            {
                var result = await Api.PostJson(_supervisor.Url, "/api/stickers/open-folder", new { emotion, open = false });
                if (result.Ok) target = result.Str("dir");
            }

            if (string.IsNullOrWhiteSpace(target))
            {
                if (emotion.Length != 0) throw new ArgumentException("请开启内核与表情包后再打开分类目录。");
                target = Path.Combine(_supervisor.DataDir, "stickers");
            }
            Directory.CreateDirectory(target);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
            return new { ok = true, message = "已在电脑上请求打开表情包文件夹。" };
        }

        private async Task<object> OpenMomentsPicturesAsync(JsonElement body)
        {
            var emotion = Text(body, "emotion", 12);
            if (emotion is not ("happy" or "cute" or "angry")) throw new ArgumentException("图片分类无效。");
            if (!_supervisor.NodeRunning) throw new ArgumentException("请先启动鲸鲸内核。");
            var result = await Api.PostJson(_supervisor.Url, "/api/moments/publish-folder", new { emotion });
            var target = result.Ok ? result.Str("dir") : "";
            if (string.IsNullOrWhiteSpace(target) || !Directory.Exists(target)) throw new ArgumentException("找不到朋友圈配图目录。");
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
            return new { ok = true, message = "已在电脑上请求打开配图目录。" };
        }

        private static object SaveAppearance(JsonElement body)
        {
            var enabled = Boolean(body, "enabled");
            switch (Text(body, "setting", 16))
            {
                case "dark":
                    Appearance.SetTheme(enabled ? "dark" : "light");
                    break;
                case "monet": Appearance.SetMonet(enabled); break;
                case "halo": Appearance.SetTextHalo(enabled); break;
                default: throw new ArgumentException("未知的外观设置。");
            }
            return new { ok = true, message = "桌面外观已保存。" };
        }

        private async Task<object> ReadMarketAsync()
        {
            var installed = _market.Installed().ToDictionary(package => package.Id);
            PluginInfo[] catalog;
            try { catalog = await PluginCatalog.CatalogAsync().WaitAsync(TimeSpan.FromSeconds(15)); }
            catch { catalog = Array.Empty<PluginInfo>(); }
            var version = UpdateManifestService.LocalVersion(_root);
            var epoch = UpdateManifestService.LocalEpoch(_root);
            var items = installed.Values.Concat(catalog).GroupBy(info => info.Id).Select(group =>
            {
                var local = installed.GetValueOrDefault(group.Key);
                var available = group.Last();
                var item = local ?? available;
                return new
                {
                    id = item.Id, label = item.Name, description = item.Description, author = item.Author,
                    version = item.Version, kind = item.Kind, api = item.Api, permissions = item.Permissions,
                    installed = local != null, enabled = local != null && _market.Enabled(item.Id),
                    canInstall = PluginMarket.Compatible(available, version, epoch) &&
                        (local == null || Version.Parse(available.Version) > Version.Parse(local.Version)),
                    fullAccess = item.RequiresFullAccess,
                };
            });
            return new { ok = true, online = catalog.Length > 0, items };
        }

        private async Task<object> InstallAsync(JsonElement body)
        {
            var id = Text(body, "id", 48);
            var listing = (await PluginCatalog.CatalogAsync().WaitAsync(TimeSpan.FromSeconds(15)))
                .FirstOrDefault(item => item.Id == id);
            if (listing == null) throw new ArgumentException("市场里找不到这个插件。");
            await _market.InstallAsync(listing);
            return new { ok = true, message = "插件已安装。请在插件卡片上确认并启用。" };
        }

        private object ChangePlugin(JsonElement body, bool remove)
        {
            var id = Text(body, "id", 48);
            var current = _market.Installed().FirstOrDefault(item => item.Id == id);
            if (current == null) throw new ArgumentException("电脑上找不到这个插件。");
            if (remove) _market.Uninstall(id);
            else
            {
                var enabled = Boolean(body, "enabled");
                if (enabled && (current.RequiresFullAccess || current.RequiresChatAccess))
                    throw new ArgumentException("请在电脑的插件市场确认并授权此 JavaScript 插件。");
                _market.SetEnabled(id, enabled, fullAccessApproved: false);
            }
            return new { ok = true, message = remove ? "插件已卸载。" : "插件启用状态已保存。" };
        }

        private static string Text(JsonElement body, string field, int limit, bool optional = false)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty(field, out var value) &&
                value.ValueKind == JsonValueKind.String && value.GetString() is string text && text.Length <= limit) return text.Trim();
            if (optional) return "";
            throw new ArgumentException("有填写内容超出长度限制或格式无效。");
        }

        private static bool Boolean(JsonElement body, string field)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty(field, out var value)
                && value.ValueKind is JsonValueKind.True or JsonValueKind.False) return value.GetBoolean();
            throw new ArgumentException("开关选项无效。");
        }

        private static double Number(JsonElement body, string field, double min, double max)
        {
            if (body.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number &&
                value.TryGetDouble(out var number) && double.IsFinite(number) && number >= min && number <= max) return number;
            throw new ArgumentException("数字设置超出允许范围。");
        }
    }
}
