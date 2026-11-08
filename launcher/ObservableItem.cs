using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace WhaleLauncher
{
    /// <summary>
    /// 列表行状态的基类：属性变了通知 WPF，避免靠「清空 ItemsSource 再重建」来刷新复选框 / 标签。
    /// </summary>
    public class ObservableItem : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;

        protected bool Set<T>(ref T field, T value, [CallerMemberName] string name = null)
        {
            if (EqualityComparer<T>.Default.Equals(field, value)) return false;
            field = value;
            OnPropertyChanged(name);
            return true;
        }

        protected void OnPropertyChanged([CallerMemberName] string name = null)
            => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}
