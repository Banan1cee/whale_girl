using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// 插件详情里的声明式设置面板：只由已安装清单的 settingsSchema 生成，不扩展包格式。
    ///
    /// 契约（与 task-22 报备一致）：
    /// - 不读取包内其他文件，不提供 XAML/HTML/脚本/WebView、任意能力或文件/网络入口。
    /// - 字段只来自 settingsSchema 已允许的关键字与标量类型；保存仍走既有 SetMessageSettings，
    ///   不新增权限、不改变授权语义。
    /// - 未修改的字段保持原状（缺失仍缺失、空值仍空值、未知但允许的字段原样保留）。
    /// - 唯一按钮是既有 tool.run@1 手动入口，由调用方传入与原来完全相同的 /api/plugins/run 路径。
    /// - schema 不可渲染或现有设置不符合 schema 时 TryCreate 返回 false，调用方回退原有 JSON 编辑器。
    /// </summary>
    internal sealed class PluginDetailPanel : StackPanel
    {
        private readonly PluginSettingsDocument _document;
        private readonly Func<string, Task<string>> _save;
        private readonly Func<string, Task<string>> _run;
        private readonly TextBlock _status;
        private bool _building;

        private PluginDetailPanel(PluginInfo info, PluginSettingsDocument document,
            Func<string, Task<string>> save, Func<string, Task<string>> run)
        {
            _document = document;
            _save = save;
            _run = run;
            Margin = new Thickness(0, 8, 0, 8);
            Children.Add(new TextBlock
            {
                Text = string.IsNullOrEmpty(document.Root.Title)
                    ? "插件设置（按清单 settingsSchema 生成）"
                    : PluginMarket.SafeText(document.Root.Title, document.TitleLimit),
                Style = Res("H2"), TextWrapping = TextWrapping.Wrap,
            });
            if (!string.IsNullOrEmpty(document.Root.Description))
                Children.Add(Small(PluginMarket.SafeText(document.Root.Description, document.DescriptionLimit)));
            Children.Add(Small("未修改的字段保持原状；保存按插件声明的 schema 校验，已启用插件会按现有规则更新授权代次。"));
            _building = true;
            BuildObject(document.Root, this, 0);
            _building = false;

            var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
            var saveButton = new Button { Content = "保存设置", Style = Res("Primary"), Margin = new Thickness(0, 0, 8, 0) };
            saveButton.Click += async (_, _) => await SaveAsync(saveButton);
            buttons.Children.Add(saveButton);
            Children.Add(buttons);

            _status = new TextBlock { Style = Res("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0) };
            Children.Add(_status);

            if (info.Provides?.ContainsKey("tool.run@1") == true) AddRunBlock();
        }

        internal static bool TryCreate(PluginInfo info, string settingsJson,
            Func<string, Task<string>> save, Func<string, Task<string>> run,
            out PluginDetailPanel panel, out string reason)
        {
            panel = null;
            reason = null;
            if (info?.IsUnified != true) { reason = "不是统一协议插件"; return false; }
            if (info.SettingsSchema is not JsonElement schema || schema.ValueKind != JsonValueKind.Object)
            {
                reason = "插件清单没有 settingsSchema";
                return false;
            }
            if (!PluginSettingsDocument.TryParse(schema, settingsJson, out var document, out reason)) return false;
            if (save == null) { reason = "缺少设置保存入口"; return false; }
            panel = new PluginDetailPanel(info, document, save, run);
            return true;
        }

        private void BuildObject(PluginSettingNode node, Panel parent, int depth)
        {
            if (node.Name.Length > 0)
            {
                parent.Children.Add(new TextBlock
                {
                    Text = Label(node, _document.TitleLimit),
                    FontWeight = FontWeights.SemiBold,
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(depth * 12, depth == 0 ? 8 : 10, 0, 0),
                });
                if (!string.IsNullOrEmpty(node.Description))
                    parent.Children.Add(Small(PluginMarket.SafeText(node.Description, _document.DescriptionLimit)));
            }
            if (node.Children.Count == 0 && node.Name.Length > 0)
            {
                parent.Children.Add(Small("（此对象没有可声明的字段）"));
                return;
            }
            foreach (var child in node.Children)
            {
                if (child.Kind == PluginSettingKind.Object) BuildObject(child, parent, depth + (node.Name.Length > 0 ? 1 : 0));
                else BuildScalar(child, parent, depth + (node.Name.Length > 0 ? 1 : 0));
            }
        }

        private void BuildScalar(PluginSettingNode node, Panel parent, int depth)
        {
            var row = new StackPanel { Margin = new Thickness(depth * 12, 8, 0, 0) };
            row.Children.Add(new TextBlock
            {
                Text = Label(node, _document.TitleLimit) + (node.Current == null && !node.Touched ? "（未设置）" : ""),
                TextWrapping = TextWrapping.Wrap,
            });
            if (!string.IsNullOrEmpty(node.Description))
                row.Children.Add(Small(PluginMarket.SafeText(node.Description, _document.DescriptionLimit)));
            parent.Children.Add(row);

            switch (node.Kind)
            {
                case PluginSettingKind.String when node.HasEnum:
                    BuildEnum(node, row, depth);
                    break;
                case PluginSettingKind.String:
                {
                    var box = new TextBox
                    {
                        Text = node.Text, Width = 320, HorizontalAlignment = HorizontalAlignment.Left,
                        Margin = new Thickness(0, 4, 0, 0),
                    };
                    box.TextChanged += (_, _) =>
                    {
                        if (_building) return;
                        node.Touched = true;
                        node.Unset = false;
                        node.Text = box.Text;
                    };
                    row.Children.Add(box);
                    AddUnsetButton(node, row, () => { box.Text = ""; });
                    break;
                }
                case PluginSettingKind.Integer:
                case PluginSettingKind.Number:
                {
                    var box = new TextBox
                    {
                        Text = node.Text, Width = 180, HorizontalAlignment = HorizontalAlignment.Left,
                        Margin = new Thickness(0, 4, 0, 0), ToolTip = "数字；清空表示未设置",
                    };
                    box.TextChanged += (_, _) =>
                    {
                        if (_building) return;
                        node.Touched = true;
                        node.Text = box.Text;
                        // 数字无法用空串表达有效值：清空即「未设置」，不会替用户写成 0。
                        node.Unset = box.Text.Trim().Length == 0;
                    };
                    row.Children.Add(box);
                    AddUnsetButton(node, row, () => { box.Text = ""; });
                    break;
                }
                case PluginSettingKind.Boolean:
                {
                    var check = new CheckBox
                    {
                        Content = "启用",
                        IsThreeState = !node.Required,
                        IsChecked = node.BooleanValue,
                        Margin = new Thickness(0, 4, 0, 0), HorizontalAlignment = HorizontalAlignment.Left,
                    };
                    check.Click += (_, _) =>
                    {
                        if (_building) return;
                        node.Touched = true;
                        node.BooleanValue = check.IsChecked;
                        node.Unset = check.IsChecked == null;
                    };
                    row.Children.Add(check);
                    break;
                }
            }
        }

        private void BuildEnum(PluginSettingNode node, Panel parent, int depth)
        {
            var combo = new ComboBox { Width = 260, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 4, 0, 0) };
            if (!node.Required) combo.Items.Add("（未设置）");
            foreach (var value in node.EnumValues)
                combo.Items.Add(PluginMarket.SafeText(DisplayEnum(value), 80));
            var offset = node.Required ? 0 : 1;
            var selected = node.EnumIndex >= 0 ? node.EnumIndex + offset : -1;
            combo.SelectedIndex = selected >= 0 ? selected : (node.Required ? -1 : 0);
            combo.SelectionChanged += (_, _) =>
            {
                if (_building) return;
                node.Touched = true;
                var index = combo.SelectedIndex;
                if (!node.Required && index == 0)
                {
                    node.Unset = true;
                    node.EnumIndex = -1;
                    return;
                }
                var valueIndex = index - offset;
                node.Unset = false;
                node.EnumIndex = valueIndex >= 0 && valueIndex < node.EnumValues.Length ? valueIndex : -1;
            };
            parent.Children.Add(combo);
        }

        private void AddUnsetButton(PluginSettingNode node, Panel parent, Action clear)
        {
            if (node.Required) return;
            var button = new Button
            {
                Content = "清除（未设置）", Style = Res("Ghost"),
                Margin = new Thickness(0, 4, 0, 0), HorizontalAlignment = HorizontalAlignment.Left,
            };
            button.Click += (_, _) =>
            {
                _building = true;
                node.Touched = true;
                node.Unset = true;
                clear();
                _building = false;
                ShowStatus("保存后这一项将回到「未设置」。");
            };
            parent.Children.Add(button);
        }

        private async Task SaveAsync(Button button)
        {
            try
            {
                var json = _document.Serialize(out var errors);
                if (errors.Count > 0)
                {
                    ShowStatus("无法保存：" + errors[0]);
                    return;
                }
                button.IsEnabled = false;
                var message = await _save(json.ToJsonString());
                ShowStatus(string.IsNullOrWhiteSpace(message) ? "设置已保存。" : message);
            }
            catch (Exception ex)
            {
                ShowStatus("保存失败：" + ex.Message);
            }
            finally
            {
                button.IsEnabled = true;
            }
        }

        private void AddRunBlock()
        {
            Children.Add(new TextBlock { Text = "手动运行", Style = Res("H2"), Margin = new Thickness(0, 16, 0, 0) });
            Children.Add(Small("复用原有 tool.run@1 手动入口：需要内核已启动、插件总开关与插件授权均已就绪。"));
            var input = new TextBox
            {
                Text = "{}", AcceptsReturn = true, MinHeight = 70, TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 6, 0, 0),
            };
            var result = new TextBox
            {
                IsReadOnly = true, AcceptsReturn = true, MinHeight = 100, TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 6, 0, 0), VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            };
            Children.Add(input);
            var actions = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            var run = new Button { Content = "运行一次", Style = Res("Primary") };
            run.Click += async (_, _) =>
            {
                try
                {
                    run.IsEnabled = false;
                    result.Text = await _run(input.Text);
                    ShowStatus("运行完成");
                }
                catch (Exception ex)
                {
                    ShowStatus("运行失败：" + ex.Message);
                }
                finally
                {
                    run.IsEnabled = true;
                }
            };
            actions.Children.Add(run);
            Children.Add(actions);
            Children.Add(result);
        }

        private void ShowStatus(string text)
        {
            if (_status != null) _status.Text = text ?? "";
        }

        private static string Label(PluginSettingNode node, int titleLimit) =>
            PluginMarket.SafeText(string.IsNullOrEmpty(node.Title) ? node.Name : node.Title, titleLimit)
            + (node.Required ? "（必填）" : "");

        private static string DisplayEnum(JsonElement value) => value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => value.GetRawText(),
        };

        private Style Res(string key) => TryFindResource(key) as Style;

        private TextBlock Small(string text) => new()
        {
            Text = text, Style = Res("Small"), TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
        };
    }

    internal enum PluginSettingKind { Object, String, Integer, Number, Boolean }

    /// <summary>
    /// 宿主 settingsSchema 策略：直接复用嵌入的共享注册表（WhaleLauncher.PluginProtocolRegistry.json），
    /// 不在启动器里另抄一份 supportedKeywords / allowedTypes / maxDepth。
    /// </summary>
    internal sealed class PluginSchemaPolicy
    {
        internal HashSet<string> Keywords { get; } = new(StringComparer.Ordinal);
        internal HashSet<string> Types { get; } = new(StringComparer.Ordinal);
        internal Dictionary<string, int> AnnotationLimits { get; } = new(StringComparer.Ordinal);
        internal List<(int Low, int High)> ForbiddenRanges { get; } = new();
        internal int MaxDepth { get; private set; }

        internal static bool TryCreate(JsonElement policy, out PluginSchemaPolicy result, out string reason)
        {
            result = null;
            reason = null;
            if (policy.ValueKind != JsonValueKind.Object
                || !policy.TryGetProperty("supportedKeywords", out var keywords) || keywords.ValueKind != JsonValueKind.Array
                || !policy.TryGetProperty("allowedTypes", out var types) || types.ValueKind != JsonValueKind.Array
                || !policy.TryGetProperty("maxDepth", out var depth) || depth.ValueKind != JsonValueKind.Number
                || !depth.TryGetInt32(out var max) || max < 1
                || !policy.TryGetProperty("annotations", out var annotations) || annotations.ValueKind != JsonValueKind.Object
                || !annotations.TryGetProperty("forbiddenRanges", out var forbidden) || forbidden.ValueKind != JsonValueKind.Array)
            {
                reason = "宿主 settingsSchema 策略不可用";
                return false;
            }
            var value = new PluginSchemaPolicy { MaxDepth = max };
            foreach (var item in keywords.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String) value.Keywords.Add(item.GetString());
            foreach (var item in types.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String) value.Types.Add(item.GetString());
            foreach (var name in new[] { "title", "description" })
            {
                if (!annotations.TryGetProperty(name, out var limit) || limit.ValueKind != JsonValueKind.Number
                    || !limit.TryGetInt32(out var bound) || bound < 0)
                {
                    reason = "宿主 settingsSchema 注解策略不可用";
                    return false;
                }
                value.AnnotationLimits[name] = bound;
            }
            foreach (var range in forbidden.EnumerateArray())
            {
                if (range.ValueKind != JsonValueKind.Array || range.GetArrayLength() != 2
                    || !range[0].TryGetInt32(out var low) || !range[1].TryGetInt32(out var high) || low > high)
                {
                    reason = "宿主 settingsSchema 注解策略不可用";
                    return false;
                }
                value.ForbiddenRanges.Add((low, high));
            }
            if (value.Keywords.Count == 0 || value.Types.Count == 0) { reason = "宿主 settingsSchema 策略不可用"; return false; }
            result = value;
            return true;
        }

        /// <summary>null = 可展示；与 Node / CLI / 安装校验同一策略。</summary>
        internal string AnnotationProblem(string name, string text)
        {
            if (!AnnotationLimits.TryGetValue(name, out var limit)) return name + " 注解策略不可用";
            if (name == "title" && string.IsNullOrWhiteSpace(text)) return "title 不能为空";
            var count = 0;
            foreach (var rune in text.EnumerateRunes())
            {
                count++;
                if (ForbiddenRanges.Any(range => rune.Value >= range.Low && rune.Value <= range.High))
                    return name + " 不能包含控制字符";
            }
            return count > limit ? name + " 不能超过 " + limit + " 个字符" : null;
        }
    }

    /// <summary>
    /// settingsSchema 驱动的纯数据模型（不含 WPF，便于单独验证）：
    /// 解析既有设置 + schema，记录控件状态，序列化时只改用户动过的字段。
    /// 未知但允许的字段从原始 JSON 深拷贝保留；缺失与空值分离。
    /// </summary>
    internal sealed class PluginSettingsDocument
    {
        private readonly JsonObject _source;
        private readonly JsonElement _schema;
        private readonly PluginSchemaPolicy _policy;

        internal PluginSettingNode Root { get; }
        internal int TitleLimit => _policy.AnnotationLimits["title"];
        internal int DescriptionLimit => _policy.AnnotationLimits["description"];

        private PluginSettingsDocument(JsonObject source, JsonElement schema, PluginSchemaPolicy policy, PluginSettingNode root)
        {
            _source = source;
            _schema = schema;
            _policy = policy;
            Root = root;
        }

        /// <summary>复用 csproj 已嵌入的共享注册表，不另抄 settingsSchema 策略。</summary>
        internal static bool TryParse(JsonElement schema, string settingsJson,
            out PluginSettingsDocument document, out string reason)
        {
            document = null;
            if (!TryLoadPolicy(out var policy, out reason)) return false;
            return TryParse(schema, settingsJson, policy, out document, out reason);
        }

        private static bool TryLoadPolicy(out PluginSchemaPolicy policy, out string reason)
        {
            policy = null;
            reason = null;
            try
            {
                using var stream = typeof(PluginSettingsDocument).Assembly
                    .GetManifestResourceStream("WhaleLauncher.PluginProtocolRegistry.json");
                if (stream == null) { reason = "缺少共享插件协议注册表"; return false; }
                using var registry = JsonDocument.Parse(stream);
                if (!registry.RootElement.TryGetProperty("settingsSchema", out var settingsSchema))
                {
                    reason = "共享注册表缺少 settingsSchema 策略";
                    return false;
                }
                return PluginSchemaPolicy.TryCreate(settingsSchema, out policy, out reason);
            }
            catch (Exception ex) when (ex is IOException or JsonException)
            {
                reason = "读取共享插件协议注册表失败";
                return false;
            }
        }

        internal static bool TryParse(JsonElement schema, string settingsJson, PluginSchemaPolicy policy,
            out PluginSettingsDocument document, out string reason)
        {
            document = null;
            reason = null;
            if (policy == null)
            {
                reason = "宿主 settingsSchema 策略不可用";
                return false;
            }
            if (schema.ValueKind != JsonValueKind.Object || Text(schema, "type") != "object")
            {
                reason = "settingsSchema 根节点必须是 object";
                return false;
            }
            if (!Supported(schema, policy, 0))
            {
                reason = "settingsSchema 含有面板不支持的写法";
                return false;
            }
            JsonObject source;
            try
            {
                using var parsed = JsonDocument.Parse(string.IsNullOrWhiteSpace(settingsJson) ? "{}" : settingsJson);
                if (parsed.RootElement.ValueKind != JsonValueKind.Object)
                {
                    reason = "当前设置不是 JSON 对象";
                    return false;
                }
                source = JsonNode.Parse(parsed.RootElement.GetRawText()) as JsonObject;
            }
            catch (JsonException)
            {
                reason = "当前设置不是合法 JSON";
                return false;
            }
            if (source == null)
            {
                reason = "当前设置不是 JSON 对象";
                return false;
            }

            var root = new PluginSettingNode
            {
                Name = "", Label = "", Kind = PluginSettingKind.Object, Required = true,
                Current = source.DeepClone(), Path = "",
                Title = Text(schema, "title") ?? "", Description = Text(schema, "description") ?? "",
            };
            if (schema.TryGetProperty("properties", out var properties))
            {
                var required = RequiredNames(schema);
                foreach (var field in properties.EnumerateObject())
                    root.Children.Add(BuildNode(field.Name, field.Value, source, required.Contains(field.Name), 1, field.Name));
            }
            // 现有设置不符合 schema 时不在面板里猜默认值，直接让调用方回退原始编辑器。
            var errors = new List<string>();
            Validate(schema, source, "", errors, 0, policy);
            if (errors.Count > 0)
            {
                reason = "当前设置不符合插件 schema：" + errors[0];
                return false;
            }
            document = new PluginSettingsDocument(source, schema, policy, root);
            return true;
        }

        private static PluginSettingNode BuildNode(string name, JsonElement schema, JsonObject parent,
            bool required, int depth, string path)
        {
            var kind = KindOf(Text(schema, "type"));
            var node = new PluginSettingNode
            {
                Name = name, Label = name, Kind = kind, Required = required, Path = path,
                Title = Text(schema, "title") ?? "", Description = Text(schema, "description") ?? "",
            };
            JsonNode existing = null;
            if (parent != null) parent.TryGetPropertyValue(name, out existing);
            node.Current = existing?.DeepClone();
            if (kind == PluginSettingKind.Object)
            {
                var childParent = node.Current as JsonObject;
                if (schema.TryGetProperty("properties", out var properties))
                {
                    var requiredNames = RequiredNames(schema);
                    foreach (var field in properties.EnumerateObject())
                        node.Children.Add(BuildNode(field.Name, field.Value, childParent, requiredNames.Contains(field.Name),
                            depth + 1, path + "." + field.Name));
                }
            }
            else if (schema.TryGetProperty("enum", out var choices))
            {
                node.EnumValues = choices.EnumerateArray().Select(item => item.Clone()).ToArray();
            }
            InitState(node);
            return node;
        }

        private static void InitState(PluginSettingNode node)
        {
            node.Text = "";
            node.BooleanValue = null;
            node.EnumIndex = -1;
            if (node.Current is not JsonValue value) return;
            switch (node.Kind)
            {
                case PluginSettingKind.String:
                    if (value.TryGetValue<string>(out var text)) node.Text = text;
                    break;
                case PluginSettingKind.Integer:
                case PluginSettingKind.Number:
                    node.Text = value.ToJsonString();
                    break;
                case PluginSettingKind.Boolean:
                    if (value.TryGetValue<bool>(out var flag)) node.BooleanValue = flag;
                    break;
            }
            if (node.HasEnum)
            {
                for (var index = 0; index < node.EnumValues.Length; index++)
                    if (JsonNode.DeepEquals(node.Current, JsonNode.Parse(node.EnumValues[index].GetRawText())))
                    {
                        node.EnumIndex = index;
                        break;
                    }
            }
        }

        /// <summary>用户改动后的设置 JSON；错误通过 errors 返回，不静默改值。</summary>
        internal JsonObject Serialize(out List<string> errors)
        {
            errors = new List<string>();
            var result = (JsonObject)_source.DeepClone();
            ApplyObject(Root, result, errors);
            if (errors.Count == 0) Validate(_schema, result, "", errors, 0, _policy);
            return result;
        }

        private static void ApplyObject(PluginSettingNode node, JsonObject target, List<string> errors)
        {
            foreach (var child in node.Children)
            {
                if (child.Kind == PluginSettingKind.Object)
                {
                    var existing = target[child.Name] as JsonObject;
                    var copy = existing?.DeepClone() as JsonObject ?? new JsonObject();
                    ApplyObject(child, copy, errors);
                    if (copy.Count > 0 || existing != null) target[child.Name] = copy;
                    continue;
                }
                if (!child.Touched) continue;
                if (child.Unset)
                {
                    target.Remove(child.Name);
                    continue;
                }
                if (!TryValue(child, out var value, errors)) continue;
                target[child.Name] = value;
            }
        }

        private static bool TryValue(PluginSettingNode node, out JsonNode value, List<string> errors)
        {
            value = null;
            switch (node.Kind)
            {
                case PluginSettingKind.String:
                    if (node.HasEnum)
                    {
                        if (node.EnumIndex < 0 || node.EnumIndex >= node.EnumValues.Length)
                        {
                            errors.Add(node.Path + "：请选择一个枚举值");
                            return false;
                        }
                        value = JsonNode.Parse(node.EnumValues[node.EnumIndex].GetRawText());
                        return true;
                    }
                    value = JsonValue.Create(node.Text ?? "");
                    return true;
                case PluginSettingKind.Integer:
                {
                    if (!long.TryParse(node.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                    {
                        errors.Add(node.Path + "：需要整数");
                        return false;
                    }
                    value = JsonValue.Create(number);
                    return true;
                }
                case PluginSettingKind.Number:
                {
                    if (!double.TryParse(node.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                        || !double.IsFinite(number))
                    {
                        errors.Add(node.Path + "：需要数字");
                        return false;
                    }
                    value = JsonValue.Create(number);
                    return true;
                }
                case PluginSettingKind.Boolean:
                    if (node.BooleanValue is not bool flag)
                    {
                        errors.Add(node.Path + "：需要 true 或 false");
                        return false;
                    }
                    value = JsonValue.Create(flag);
                    return true;
                default:
                    errors.Add(node.Path + "：不支持的类型");
                    return false;
            }
        }

        private static void Validate(JsonElement schema, JsonNode value, string path, List<string> errors, int depth, PluginSchemaPolicy policy)
        {
            if (depth > policy.MaxDepth)
            {
                errors.Add(path + "：层级过深");
                return;
            }
            var type = Text(schema, "type");
            if (!MatchesType(value, type))
            {
                errors.Add(Label(path) + "：类型应为 " + type);
                return;
            }
            if (schema.TryGetProperty("enum", out var choices)
                && !choices.EnumerateArray().Any(item => JsonNode.DeepEquals(value, JsonNode.Parse(item.GetRawText()))))
            {
                errors.Add(Label(path) + "：不在可选值内");
                return;
            }
            if (type == "object")
            {
                var obj = value as JsonObject;
                if (obj == null) return;
                var properties = schema.TryGetProperty("properties", out var props) ? props : default;
                var known = new HashSet<string>(StringComparer.Ordinal);
                if (properties.ValueKind == JsonValueKind.Object)
                {
                    foreach (var field in properties.EnumerateObject())
                    {
                        known.Add(field.Name);
                        if (obj.TryGetPropertyValue(field.Name, out var child))
                            Validate(field.Value, child, path + "." + field.Name, errors, depth + 1, policy);
                        else if (RequiredNames(schema).Contains(field.Name))
                            errors.Add(Label(path + "." + field.Name) + "：必填项缺失");
                    }
                }
                var allowExtra = !schema.TryGetProperty("additionalProperties", out var additional)
                    || additional.ValueKind != JsonValueKind.False;
                if (!allowExtra)
                    foreach (var field in obj)
                        if (!known.Contains(field.Key)) errors.Add(Label(path + "." + field.Key) + "：schema 不允许该字段");
                return;
            }
            if (type == "string")
            {
                var text = value is JsonValue json && json.TryGetValue<string>(out var stringValue) ? stringValue : null;
                if (text == null) return;
                var length = text.EnumerateRunes().Count();
                if (schema.TryGetProperty("minLength", out var min) && length < min.GetInt32())
                    errors.Add(Label(path) + "：长度不足 " + min.GetInt32());
                if (schema.TryGetProperty("maxLength", out var max) && length > max.GetInt32())
                    errors.Add(Label(path) + "：长度超过 " + max.GetInt32());
                return;
            }
            if (type is "integer" or "number")
            {
                if (value is not JsonValue number || !number.TryGetValue<double>(out var parsed)) return;
                if (type == "integer")
                {
                    if (!number.TryGetValue<long>(out var integer))
                    {
                        errors.Add(Label(path) + "：需要整数");
                        return;
                    }
                    if (schema.TryGetProperty("minimum", out var min) && integer < min.GetDouble())
                        errors.Add(Label(path) + "：小于最小值 " + min.GetDouble().ToString(CultureInfo.InvariantCulture));
                    if (schema.TryGetProperty("maximum", out var max) && integer > max.GetDouble())
                        errors.Add(Label(path) + "：大于最大值 " + max.GetDouble().ToString(CultureInfo.InvariantCulture));
                }
                else
                {
                    if (schema.TryGetProperty("minimum", out var numberMin) && parsed < numberMin.GetDouble())
                        errors.Add(Label(path) + "：小于最小值 " + numberMin.GetDouble().ToString(CultureInfo.InvariantCulture));
                    if (schema.TryGetProperty("maximum", out var numberMax) && parsed > numberMax.GetDouble())
                        errors.Add(Label(path) + "：大于最大值 " + numberMax.GetDouble().ToString(CultureInfo.InvariantCulture));
                }
            }
        }

        private static bool Supported(JsonElement schema, PluginSchemaPolicy policy, int depth)
        {
            if (depth > policy.MaxDepth || schema.ValueKind != JsonValueKind.Object) return false;
            if (schema.EnumerateObject().Any(field => !policy.Keywords.Contains(field.Name))) return false;
            if (!schema.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String
                || !policy.Types.Contains(type.GetString())) return false;
            var kind = type.GetString();
            // 这里是渲染器自身能力：宿主以后登记了数组等类型，本面板也只会回退原始编辑器。
            if (kind is not ("object" or "string" or "integer" or "number" or "boolean")) return false;
            foreach (var name in new[] { "title", "description" })
                if (schema.TryGetProperty(name, out var annotation))
                {
                    if (annotation.ValueKind != JsonValueKind.String) return false;
                    if (policy.AnnotationProblem(name, annotation.GetString() ?? "") != null) return false;
                }
            if (kind == "object")
            {
                if (schema.TryGetProperty("properties", out var properties))
                {
                    if (properties.ValueKind != JsonValueKind.Object) return false;
                    foreach (var field in properties.EnumerateObject())
                        if (!Supported(field.Value, policy, depth + 1)) return false;
                }
                if (schema.TryGetProperty("required", out var required)
                    && (required.ValueKind != JsonValueKind.Array
                        || required.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String))) return false;
                if (schema.TryGetProperty("additionalProperties", out var additional)
                    && additional.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
                return !schema.TryGetProperty("enum", out _);
            }
            if (schema.TryGetProperty("properties", out _) || schema.TryGetProperty("required", out _)
                || schema.TryGetProperty("additionalProperties", out _)) return false;
            if (schema.TryGetProperty("enum", out var choices)
                && (choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0
                    || choices.EnumerateArray().Any(item => !MatchesType(JsonNode.Parse(item.GetRawText()), kind)))) return false;
            var numeric = kind is "integer" or "number";
            foreach (var bound in new[] { "minimum", "maximum" })
                if (schema.TryGetProperty(bound, out var value)
                    && (!numeric || value.ValueKind != JsonValueKind.Number || !double.IsFinite(value.GetDouble()))) return false;
            foreach (var bound in new[] { "minLength", "maxLength" })
                if (schema.TryGetProperty(bound, out var value)
                    && (kind != "string" || value.ValueKind != JsonValueKind.Number
                        || !value.TryGetInt32(out var length) || length < 0)) return false;
            if (schema.TryGetProperty("minimum", out var lower) && schema.TryGetProperty("maximum", out var upper)
                && lower.GetDouble() > upper.GetDouble()) return false;
            return true;
        }

        private static HashSet<string> RequiredNames(JsonElement schema)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            if (schema.TryGetProperty("required", out var required) && required.ValueKind == JsonValueKind.Array)
                foreach (var item in required.EnumerateArray())
                    if (item.ValueKind == JsonValueKind.String) names.Add(item.GetString());
            return names;
        }

        private static PluginSettingKind KindOf(string type) => type switch
        {
            "object" => PluginSettingKind.Object,
            "integer" => PluginSettingKind.Integer,
            "number" => PluginSettingKind.Number,
            "boolean" => PluginSettingKind.Boolean,
            _ => PluginSettingKind.String,
        };

        private static bool MatchesType(JsonNode value, string type) => type switch
        {
            "object" => value is JsonObject,
            "string" => value is JsonValue text && text.TryGetValue<string>(out _),
            "boolean" => value is JsonValue flag && flag.TryGetValue<bool>(out _),
            "integer" => value is JsonValue number && number.TryGetValue<long>(out _),
            "number" => value is JsonValue number && number.TryGetValue<double>(out var parsed) && double.IsFinite(parsed),
            _ => false,
        };

        private static string Text(JsonElement value, string key) =>
            value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;

        private static string Label(string path) => string.IsNullOrEmpty(path) ? "设置" : path.TrimStart('.');
    }

    internal sealed class PluginSettingNode
    {
        internal string Name = "";
        internal string Label = "";
        internal string Path = "";
        internal string Title = "";
        internal string Description = "";
        internal PluginSettingKind Kind;
        internal bool Required;
        internal JsonNode Current;
        internal List<PluginSettingNode> Children = new();
        internal JsonElement[] EnumValues = [];
        internal bool HasEnum => EnumValues.Length > 0;

        // 控件状态：未 Touched 的字段在序列化时保持原状。
        internal bool Touched;
        internal bool Unset;
        internal string Text = "";
        internal bool? BooleanValue;
        internal int EnumIndex = -1;
    }
}
