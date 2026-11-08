using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace WhaleLauncher
{
    /// <summary>
    /// 数字输入框：只接受数字，并提供统一的区间 / 空值回退 / 错误文案。
    /// 以前各页面各写一套 TryParse + Clamp，出现了「非法输入静默变成默认值」的问题；
    /// 这里不偷偷改用户输入，校验失败时由页面把 ErrorText 显示出来。
    /// </summary>
    public sealed class NumberField : TextBox
    {
        public NumberField()
        {
            // 显式引用全局 TextBox 样式；隐式样式对派生控件不保证生效。
            SetResourceReference(StyleProperty, typeof(TextBox));
            VerticalContentAlignment = VerticalAlignment.Center;
            PreviewTextInput += OnPreviewTextInput;
            DataObject.AddPastingHandler(this, OnPaste);
        }

        public int Minimum { get; set; } = int.MinValue;
        public int Maximum { get; set; } = int.MaxValue;

        /// <summary>留空时按这个值保存，和旧界面的行为一致。</summary>
        public int Fallback { get; set; }

        /// <summary>false 时留空视为无效（配置页这类没有明确默认值的输入用）。</summary>
        public bool EmptyUsesFallback { get; set; } = true;

        public string Label { get; set; } = "";

        public string ErrorText => (string.IsNullOrWhiteSpace(Label) ? "这个值" : Label)
            + " 要填 " + Minimum + "～" + Maximum + " 的整数";

        public bool TryRead(out int value)
        {
            var text = (Text ?? "").Trim();
            if (text.Length == 0)
            {
                value = EmptyUsesFallback ? Fallback : 0;
                return EmptyUsesFallback;
            }
            return int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value)
                && value >= Minimum
                && value <= Maximum;
        }

        private void OnPreviewTextInput(object sender, TextCompositionEventArgs e)
            => e.Handled = !IsDigits(e.Text);

        private void OnPaste(object sender, DataObjectPastingEventArgs e)
        {
            if (e.DataObject.GetDataPresent(DataFormats.Text))
            {
                var text = e.DataObject.GetData(DataFormats.Text) as string ?? "";
                if (IsDigits(text)) return;
            }
            e.CancelCommand();
        }

        private static bool IsDigits(string text)
        {
            if (string.IsNullOrEmpty(text)) return true;
            foreach (var ch in text)
                if (ch < '0' || ch > '9') return false;
            return true;
        }
    }
}
