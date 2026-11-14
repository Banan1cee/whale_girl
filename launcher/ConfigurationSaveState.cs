using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    // 页面线程使用；只有成功响应能推进水位。ConfigSaver 取得写锁时才捕获本次快照。
    internal sealed class ConfigurationSaveState<T>
    {
        private readonly Func<T> _read;
        private readonly Func<Func<T>, Task<ApiResult>> _save;
        private readonly Action<T, ApiResult> _completed;
        private Task<ApiResult> _running;
        private bool _hasCommittedValue;
        private T _committedValue;

        public long DesiredRevision { get; private set; }
        public long InFlightRevision { get; private set; }
        public long CommittedRevision { get; private set; }
        public bool HasPendingChanges => DesiredRevision != CommittedRevision;
        public bool IsSaving => _running != null && !_running.IsCompleted;

        public ConfigurationSaveState(Func<T> read, Func<Func<T>, Task<ApiResult>> save,
            Action<T, ApiResult> completed = null)
        {
            _read = read;
            _save = save;
            _completed = completed;
        }

        public void MarkDesired() => DesiredRevision++;

        public void Initialize(T value)
        {
            if (IsSaving || HasPendingChanges) return;
            _committedValue = value;
            _hasCommittedValue = true;
        }

        public Task<ApiResult> SaveAsync()
        {
            MarkDesired();
            if (IsSaving) return _running;
            var completion = new TaskCompletionSource<ApiResult>();
            _running = completion.Task;
            _ = DrainAsync(completion);
            return completion.Task;
        }

        private async Task DrainAsync(TaskCompletionSource<ApiResult> completion)
        {
            var result = new ApiResult { Ok = true };
            try
            {
                while (HasPendingChanges)
                {
                    if (_hasCommittedValue && EqualityComparer<T>.Default.Equals(_read(), _committedValue))
                    {
                        CommittedRevision = DesiredRevision;
                        break;
                    }
                    var revision = DesiredRevision;
                    var snapshot = default(T);
                    var captured = false;
                    result = await _save(() =>
                    {
                        snapshot = _read();
                        revision = DesiredRevision;
                        InFlightRevision = revision;
                        captured = true;
                        return snapshot;
                    });
                    if (result.Ok && captured)
                    {
                        _committedValue = snapshot;
                        _hasCommittedValue = true;
                        CommittedRevision = revision;
                    }
                    InFlightRevision = 0;
                    if (captured) _completed?.Invoke(snapshot, result);
                    // 失败只为在途期间的新编辑继续一次；同值失败等下一次用户触发，不自旋重试。
                    if (!result.Ok && DesiredRevision == revision) break;
                }
            }
            catch (Exception ex) { result = new ApiResult { Ok = false, Error = Api.FriendlyError(ex) }; }
            finally
            {
                InFlightRevision = 0;
                completion.TrySetResult(result);
            }
        }
    }

    internal readonly struct ConfigurationSecretSnapshot
    {
        public readonly string Value;
        public readonly long Revision;
        public ConfigurationSecretSnapshot(string value, long revision) { Value = value; Revision = revision; }
    }

    internal sealed class ConfigurationSecretState
    {
        private long _revision;
        public void Changed() => _revision++;
        public ConfigurationSecretSnapshot Capture(string value) => new ConfigurationSecretSnapshot(value, _revision);
        public bool IsCurrent(ConfigurationSecretSnapshot snapshot, string current)
            => snapshot.Revision == _revision && string.Equals(snapshot.Value, current, StringComparison.Ordinal);
    }
}
