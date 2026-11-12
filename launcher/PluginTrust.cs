using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;

namespace WhaleLauncher
{
    /// <summary>
    /// 插件市场信任根：只认这里内置的公钥，不认下载域名、镜像或目录里的自报作者。
    /// 目录和插件包都走 ECDSA P-256 / SHA-256；签名格式是 Node crypto.sign 生成的
    /// DER 序列再 Base64。公钥可以轮换，多个公钥用逗号或换行分隔。
    ///
    /// 当前公钥指纹（SHA-256）：135bd43efa206a50668291659154e74cb85779ca33cb13da61176b15736f7418
    /// 私钥只放在维护者离线环境，禁止入库；签名方法见 docs/插件市场签名.md。
    /// </summary>
    internal static class PluginTrust
    {
        private const string DefaultPublicKeys =
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJj+ZQszjWlg3igJIAIHy0MYNJifdSfve/GQ1E8sGg30dBzoXg4fZWshcp0pp7paO7znDLU85aFodHp8plSg0KQ==";

        private static string[] _publicKeys = SplitKeys(DefaultPublicKeys);

        internal static bool HasTrustedKey => _publicKeys.Length > 0;

        internal static bool Verify(byte[] data, string signatureBase64)
        {
            if (data == null || data.Length == 0 || string.IsNullOrWhiteSpace(signatureBase64)) return false;
            byte[] signature;
            try { signature = Convert.FromBase64String(signatureBase64.Trim().TrimStart('\uFEFF')); }
            catch (FormatException) { return false; }
            foreach (var key in _publicKeys)
            {
                try
                {
                    using var ecdsa = ECDsa.Create();
                    ecdsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(key), out _);
                    if (ecdsa.VerifyData(data, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence))
                        return true;
                }
                catch
                {
                    // 某个公钥损坏不应让其他已配置的公钥失效；最终由返回值统一拒绝。
                }
            }
            return false;
        }

        private static string[] SplitKeys(string value) => (value ?? "")
            .Split(new[] { ',', ';', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(key => key.Trim())
            .Where(key => key.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        /// <summary>只供回归测试替换信任根；生产代码不要调用。</summary>
        internal static void UsePublicKeysForTests(params string[] keys)
        {
            _publicKeys = SplitKeys(string.Join("\n", keys ?? Array.Empty<string>()));
        }

        internal static void ResetForTests() => _publicKeys = SplitKeys(DefaultPublicKeys);

        internal static IReadOnlyList<string> PublicKeysForDiagnostics() => _publicKeys;
    }
}
