using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>联系人（私聊或群）的展示信息。名单、主人搜索、账号页共用。</summary>
    public class ContactInfo : ObservableItem
    {
        public string Wxid { get; set; } = "";
        public string Name { get; set; } = "";
        public string Remark { get; set; } = "";
        public bool IsGroup { get; set; }

        public string Display => !string.IsNullOrWhiteSpace(Name)
            ? Name
            : (!string.IsNullOrWhiteSpace(Remark) ? Remark : Wxid);
    }

    /// <summary>一次联系人读取的结果；失败时带上上次缓存，页面仍然能显示已选条目。</summary>
    public sealed class ContactSnapshot
    {
        public bool Ok;
        public string Error = "";
        public long UpdatedAt;
        public string Account = "";
        public List<ContactInfo> Items = new List<ContactInfo>();
    }

    /// <summary>
    /// 联系人缓存入口。以前每个页面自己 GET、自己解析、自己拼搜索条件：
    /// 发言范围开一次窗口要拉两遍全量，主人搜索又走服务端过滤，语义迟早对不上。
    /// 现在统一从这里取，短时间内的重复请求合并成一个，搜索规则只维护这一份。
    /// </summary>
    public sealed class ContactDirectory
    {
        private const int CacheSeconds = 10;

        private readonly RuntimeSupervisor _sup;
        private readonly object _gate = new object();
        private List<ContactInfo> _items = new List<ContactInfo>();
        private long _updatedAt;
        private DateTime _loadedAt = DateTime.MinValue;
        private bool _loaded;
        private Task<ContactSnapshot> _loading;

        public ContactDirectory(RuntimeSupervisor sup)
        {
            _sup = sup;
        }

        /// <summary>force=true 用于「刷新列表」；并发请求会共用同一个 Task，不会重复拉。</summary>
        public Task<ContactSnapshot> LoadAsync(bool force = false)
        {
            lock (_gate)
            {
                if (_loading != null && !_loading.IsCompleted) return _loading;
                if (!force && _loaded && (DateTime.UtcNow - _loadedAt).TotalSeconds < CacheSeconds)
                    return Task.FromResult(Snapshot(true, ""));
                _loading = FetchAsync();
                return _loading;
            }
        }

        public Task<ContactSnapshot> RefreshAsync() => LoadAsync(true);

        private async Task<ContactSnapshot> FetchAsync()
        {
            var res = await Api.Get(_sup.Url, "/api/wechat/contacts?type=all");
            if (!res.Ok)
            {
                lock (_gate)
                {
                    // 失败不覆盖旧缓存：页面至少还能把已经选中的联系人画出来。
                    _loaded = false;
                    return Snapshot(false, Api.Message(res));
                }
            }

            var items = new List<ContactInfo>();
            var arr = res.Prop("items");
            if (arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var it in arr.EnumerateArray())
                {
                    if (it.ValueKind != JsonValueKind.Object) continue;
                    var wxid = JsonRead.Str(it, "wxid");
                    if (wxid.Length == 0 || wxid == "*") continue;
                    items.Add(new ContactInfo
                    {
                        Wxid = wxid,
                        Name = JsonRead.Str(it, "name"),
                        Remark = JsonRead.Str(it, "remark"),
                        IsGroup = JsonRead.Bool(it, "isGroup")
                    });
                }
            }

            lock (_gate)
            {
                _items = items;
                _updatedAt = res.Long("updatedAt");
                _loaded = true;
                _loadedAt = DateTime.UtcNow;
                return Snapshot(true, "");
            }
        }

        private ContactSnapshot Snapshot(bool ok, string error)
        {
            return new ContactSnapshot
            {
                Ok = ok,
                Error = error,
                UpdatedAt = _updatedAt,
                Items = new List<ContactInfo>(_items)
            };
        }

        /// <summary>按 wxid / 名字 / 备注匹配（大小写不敏感），和内核的 search 保持同一规则。</summary>
        public static bool Matches(ContactInfo item, string q)
        {
            if (item == null) return false;
            var key = (q ?? "").Trim();
            if (key.Length == 0) return true;
            return Contains(item.Wxid, key) || Contains(item.Name, key) || Contains(item.Remark, key);
        }

        private static bool Contains(string value, string q)
            => !string.IsNullOrEmpty(value)
               && value.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
    }
}
