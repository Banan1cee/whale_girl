using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using WhaleLauncher;

/// <summary>
/// DeepSeek 语音合成：请求形状（/v1/tools/tts + voice_id）、默认音色、
/// 以及流式 WAV 头修复。
/// </summary>
static class DeepSeekChecks
{
    sealed class Handler(byte[] bytes) : HttpMessageHandler
    {
        public HttpRequestMessage Request;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage q, CancellationToken ct)
        {
            Request = q;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
        }
    }

    // 复刻 DeepSeek 的流式 WAV：RIFF 和 data 的长度都是 0xFFFFFFFF 占位。
    static byte[] StreamingWave(int dataSize)
    {
        using var memory = new MemoryStream();
        using var w = new BinaryWriter(memory);
        w.Write(Encoding.ASCII.GetBytes("RIFF"));
        w.Write(uint.MaxValue);
        w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        w.Write(16); w.Write((ushort)1); w.Write((ushort)1); w.Write(32000); w.Write(64000);
        w.Write((ushort)2); w.Write((ushort)16);
        w.Write(Encoding.ASCII.GetBytes("data"));
        w.Write(uint.MaxValue);
        w.Write(Enumerable.Range(0, dataSize).Select(n => (byte)(n % 127)).ToArray());
        return memory.ToArray();
    }

    public static async Task Run(string directory)
    {
        int count = 0;
        void Check(bool ok) { if (!ok) throw new Exception("DeepSeek voice check failed #" + (count + 1)); count++; }

        var provider = SpeechProviders.Get("deepseek");
        Check(provider.Name == "DeepSeek");
        Check(provider.BaseUrl == "https://api.deepseek.com");

        var defaults = SpeechProviders.Defaults("deepseek");
        Check(defaults.Model == SpeechProviders.DeepSeekModel);
        Check(defaults.Voice == "stella");

        Check(SpeechProviders.Choices("deepseek", null, "", false).Single().Id == SpeechProviders.DeepSeekModel);
        var voices = SpeechProviders.Choices("deepseek", null, "", true).Select(c => c.Id).ToArray();
        Check(voices.Contains("stella") && voices.Contains("tide"));

        using (var request = SpeechProviders.CreateRequest("deepseek", "test-only-key", SpeechProviders.DeepSeekModel, "stella", "测试", ""))
        {
            Check(request.RequestUri.Host == "api.deepseek.com");
            Check(request.RequestUri.AbsolutePath == "/v1/tools/tts");
            Check(request.Headers.Authorization?.Parameter == "test-only-key");
            using var json = JsonDocument.Parse(await request.Content.ReadAsStringAsync());
            Check(json.RootElement.GetProperty("text").GetString() == "测试");
            Check(json.RootElement.GetProperty("voice_id").GetString() == "stella");
            Check(json.RootElement.GetProperty("format").GetString() == "wav");
            Check(json.RootElement.GetProperty("filter_markdown").GetBoolean());
            Check(!json.RootElement.TryGetProperty("model", out _));
        }

        // 音色留空时不能把空串发给接口，否则 DeepSeek 会 400。
        using (var fallback = SpeechProviders.CreateRequest("deepseek", "k", SpeechProviders.DeepSeekModel, "", "测试", ""))
        using (var json = JsonDocument.Parse(await fallback.Content.ReadAsStringAsync()))
            Check(json.RootElement.GetProperty("voice_id").GetString() == "stella");

        // 流式 WAV 的头要按真实字节数改写，长度字段才是有效值。
        var file = Path.Combine(directory, "deepseek-stream.wav");
        var handler = new Handler(StreamingWave(128000));
        using (var client = new HttpClient(handler))
            await SpeechProviders.Generate("deepseek", "fake-key", SpeechProviders.DeepSeekModel, "stella", "测试", "",
                file, CancellationToken.None, null, null, client);
        Check(Math.Abs(VoiceSendEngine.ValidateWave(file) - 2) < 0.01);
        var fixedBytes = File.ReadAllBytes(file);
        Check(BitConverter.ToUInt32(fixedBytes, 4) == fixedBytes.Length - 8);
        Check(BitConverter.ToUInt32(fixedBytes, 40) == 128000);
        Check(handler.Request.RequestUri.AbsolutePath == "/v1/tools/tts");



        Console.WriteLine("PASS " + count + " DeepSeek TTS request/default/streaming-WAV checks; no network or audio playback.");
    }
}
