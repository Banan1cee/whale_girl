using System;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal static class PluginHostActions
    {
        internal static async Task<string> SummarizeAsync(RuntimeSupervisor supervisor, string range)
        {
            if (!supervisor.NodeRunning) throw new InvalidOperationException("请先启动鲸鲸内核");
            if (range is not ("today" or "yesterday")) throw new InvalidOperationException("汇总日期无效");

            var current = await Api.Get(supervisor.Url, "/api/digest", 5);
            if (!current.Ok) throw new InvalidOperationException("当前内核没有提供消息汇总");
            if (current.Str("status") == "running") throw new InvalidOperationException("已有汇总正在生成，请等它完成");
            var started = await Api.PostJson(supervisor.Url, "/api/digest/generate", new { range }, 10);
            if (!started.Ok) throw new InvalidOperationException(Api.Message(started));

            var deadline = DateTimeOffset.UtcNow.AddMinutes(2);
            var result = started;
            while (true)
            {
                if (result.Str("range") != range)
                    throw new InvalidOperationException("汇总任务已切换，请重新运行插件");
                switch (result.Str("status"))
                {
                    case "done": return result.Str("text");
                    case "empty":
                    case "failed": throw new InvalidOperationException(result.Str("message"));
                    case "running": break;
                    default: throw new InvalidOperationException("未收到汇总结果");
                }
                if (DateTimeOffset.UtcNow >= deadline) throw new TimeoutException("等待汇总超时");
                await Task.Delay(1000);
                result = await Api.Get(supervisor.Url, "/api/digest", 5);
                if (!result.Ok) throw new InvalidOperationException(Api.Message(result));
            }
        }
    }
}
