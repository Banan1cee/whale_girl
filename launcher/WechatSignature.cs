using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;

namespace WhaleLauncher
{
    internal static class WechatSignature
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FileInfo
        {
            public uint Size;
            [MarshalAs(UnmanagedType.LPWStr)] public string Name;
            public IntPtr FileHandle;
            public IntPtr KnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TrustData
        {
            public uint Size;
            public IntPtr PolicyCallback;
            public IntPtr ClientData;
            public uint UiChoice;
            public uint RevocationChecks;
            public uint UnionChoice;
            public IntPtr File;
            public uint StateAction;
            public IntPtr StateData;
            public IntPtr Url;
            public uint ProviderFlags;
            public uint UiContext;
            public IntPtr SignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true)]
        private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);

        public static bool Verify(string path)
        {
            var file = new FileInfo { Size = (uint)Marshal.SizeOf<FileInfo>(), Name = path };
            var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<FileInfo>());
            Marshal.StructureToPtr(file, pointer, false);
            try
            {
                var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
                var data = new TrustData
                {
                    Size = (uint)Marshal.SizeOf<TrustData>(),
                    UiChoice = 2, // WTD_UI_NONE
                    UnionChoice = 1, // WTD_CHOICE_FILE
                    File = pointer,
                    StateAction = 1, // WTD_STATEACTION_VERIFY
                    ProviderFlags = 0x1000, // WTD_CACHE_ONLY_URL_RETRIEVAL
                };
                var result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
                data.StateAction = 2; // WTD_STATEACTION_CLOSE
                WinVerifyTrust(new IntPtr(-1), ref action, ref data);
                if (result != 0) return false;
#pragma warning disable SYSLIB0057
                using var signer = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
                var name = signer.GetNameInfo(X509NameType.SimpleName, false);
                return Regex.IsMatch(name, @"\ATencent Technology \(Shenzhen\) Company (?:Limited|Ltd\.?)\z",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            }
            finally
            {
                Marshal.DestroyStructure<FileInfo>(pointer);
                Marshal.FreeHGlobal(pointer);
            }
        }
    }
}
