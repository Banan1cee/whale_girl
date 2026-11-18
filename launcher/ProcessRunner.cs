using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed class ProcessRunResult
    {
        public int? ExitCode;
        public string Output = "";
        public string Error = "";
        public bool TimedOut;
        public bool Cancelled;
        public bool OutputComplete;
        public bool TerminationConfirmed;
        public bool CleanupUncertain;
        public bool Started;
        public bool Success => Started && ExitCode == 0 && OutputComplete && !TimedOut && !Cancelled;
    }

    // 仅运行调用者明确创建的短命令；环境、参数、编码和路径策略仍由调用者决定。
    internal static class ProcessRunner
    {
        // readOutput仅为受控排空故障注入；真实snapshot调用保持两路并发ReadToEndAsync。
        internal static async Task<ProcessRunResult> RunAsync(ProcessStartInfo start, string input,
            TimeSpan timeout, CancellationToken cancellationToken = default,
            Func<StreamReader, Task<string>> readOutput = null)
        {
            if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
            if (start.UseShellExecute || !start.RedirectStandardOutput || !start.RedirectStandardError)
                throw new ArgumentException("命令必须独立重定向stdout/stderr。", nameof(start));
            var result = new ProcessRunResult();
            if (cancellationToken.IsCancellationRequested) { result.Cancelled = true; return result; }
            var elapsed = Stopwatch.StartNew();
            // 把收尾预算包含在总时限内，而不是超时后再无界等待管道。
            var cleanup = TimeSpan.FromMilliseconds(Math.Min(250, timeout.TotalMilliseconds / 5));
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(timeout - cleanup);
            using var process = new Process { StartInfo = start };
            Task<string> output = null;
            Task<string> errors = null;
            try
            {
                result.Started = process.Start();
                if (!result.Started) return result;
                deadline.Token.ThrowIfCancellationRequested();
                output = readOutput == null ? process.StandardOutput.ReadToEndAsync() : readOutput(process.StandardOutput);
                errors = readOutput == null ? process.StandardError.ReadToEndAsync() : readOutput(process.StandardError);
                if (input != null)
                {
                    await process.StandardInput.WriteAsync(input.AsMemory(), deadline.Token);
                    process.StandardInput.Close();
                }
                await process.WaitForExitAsync(deadline.Token);
                await Task.WhenAll(output, errors).WaitAsync(deadline.Token);
                deadline.Token.ThrowIfCancellationRequested();
                if (elapsed.Elapsed >= timeout) throw new OperationCanceledException(deadline.Token);
                result.Output = await output;
                result.Error = await errors;
                result.OutputComplete = true;
                result.ExitCode = process.ExitCode;
                result.TerminationConfirmed = true;
                return result;
            }
            catch (OperationCanceledException)
            {
                result.Cancelled = cancellationToken.IsCancellationRequested;
                result.TimedOut = !result.Cancelled;
            }
            catch (Exception)
            {
                // 调用者保留自己的错误话术；不把命令参数/标准输入拼进错误或自动重放。
            }
            finally
            {
                if (result.Started && !result.TerminationConfirmed)
                {
                    try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
                    var remaining = timeout - elapsed.Elapsed;
                    if (remaining > cleanup) remaining = cleanup;
                    if (remaining > TimeSpan.Zero)
                    {
                        try
                        {
                            await Task.WhenAll(process.WaitForExitAsync(),
                                output ?? Task.FromResult(""), errors ?? Task.FromResult("")).WaitAsync(remaining);
                        }
                        catch { }
                    }
                    try
                    {
                        result.TerminationConfirmed = process.HasExited;
                        if (process.HasExited) result.ExitCode = process.ExitCode;
                    }
                    catch { }
                    if (output?.IsCompletedSuccessfully == true) result.Output = output.Result;
                    if (errors?.IsCompletedSuccessfully == true) result.Error = errors.Result;
                    result.OutputComplete = output?.IsCompletedSuccessfully == true && errors?.IsCompletedSuccessfully == true;
                    result.CleanupUncertain = !result.TerminationConfirmed || !result.OutputComplete;
                    // 超时后未完成的读取也必须被观察；关闭owned管道，不等待其继承者。
                    _ = ObserveAsync(output);
                    _ = ObserveAsync(errors);
                }
            }
            return result;
        }

        private static async Task ObserveAsync(Task<string> task)
        {
            if (task == null) return;
            try { await task; } catch { }
        }
    }
}
