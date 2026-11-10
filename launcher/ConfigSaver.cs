using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>
    /// 配置保存协调器：同一页面的多个输入共用，保证请求串行、按触发顺序落地。
    ///
    /// 关键点是 build 在拿到锁之后才执行：等前一个请求结束时再读当前界面状态，
    /// 不会把排队前的旧快照发出去覆盖刚改好的值。多个字段各存各的 patch，
    /// 因此不能只保留「最后一个 builder」，否则先触发的表单会被吞掉。
    /// </summary>
    public sealed class ConfigSaver
    {
        private readonly RuntimeSupervisor _sup;
        private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);

        public ConfigSaver(RuntimeSupervisor sup)
        {
            _sup = sup;
        }

        public async Task<ApiResult> SaveAsync(Func<IDictionary<string, object>> build)
        {
            await _gate.WaitAsync();
            try
            {
                return await _sup.PatchConfigurationAsync(build());
            }
            catch (Exception ex)
            {
                return new ApiResult { Ok = false, Error = Api.FriendlyError(ex) };
            }
            finally
            {
                _gate.Release();
            }
        }
    }
}
