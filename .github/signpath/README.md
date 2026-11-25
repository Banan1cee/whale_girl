# SignPath 配置对照表

CI 里的两步签名（`.github/workflows/installer.yml`）对应 SignPath 后台里的这些东西。
**这些 XML 不能当文件被 CI 读取** —— SignPath 的 artifact configuration 存在它自己那边，
这里放一份是为了有版本记录、方便复制粘贴进后台。

| 后台里要建的 | slug | 内容 |
| --- | --- | --- |
| Artifact configuration（启动器） | `whale-launcher` | `whale-launcher.xml` 的内容 |
| Artifact configuration（安装包） | `whale-setup` | `whale-setup.xml` 的内容 |
| Signing policy（发版） | `release-signing` | 只在 tag 上签；可以配成需要人工审批 |
| Signing policy（测试） | `test-signing` | 在分支手动运行时勾选测试签名，只生成测试 Artifact |

CI 里怎么用：

```yaml
signing-policy-slug: ${{ github.ref_type == 'tag' && 'release-signing' || 'test-signing' }}
artifact-configuration-slug: whale-launcher   # 第二轮换成 whale-setup
github-artifact-id: ${{ steps.upload-unsigned-*.outputs.artifact-id }}
parameters: |
  version: ${{ toJSON(env.version) }}          # 填 metadata restrictions 里的 ${version}
```

注意：

- **metadata restrictions 是 SignPath Foundation 的硬要求**：`product-name` / `company-name` /
  `product-version` 会去核对 exe 里真实的版本资源，对不上就不给签。
  - 启动器这三个值来自 `launcher/WhaleLauncher.csproj` 的 `<Product>` / `<Company>` / `<Version>`
  - 安装包来自 `installer/whale.iss` 的 `VersionInfoProductName` / `VersionInfoCompany` / `VersionInfoProductTextVersion`
  - 两个 EXE 的 PE 产品名和公司名使用 `WhaleGirl`。SignPath 对旧的中文 PE 产品名报告了额外字符，使用固定 ASCII 标识仍保留精确校验。
  - Inno Setup 会在版本资源中为上述三个字段填充空格。送签前由 `scripts/normalize-inno-version.js` 移除填充并校验值，保留精确匹配。
  - 版本号必须每次构建都一致，所以用 `${version}` 参数从 CI 传，而不是写死
- GitHub Actions 上传的是 ZIP，所以 artifact configuration 的文件根元素是 `<zip-file>`，
  `<pe-file>` 写在它里面。SignPath 步骤下载后自动解包。
- `signpath-test.cer` 是 `test-signing` 使用的公开证书。只有手动测试签名时，临时 Windows
  构建机才信任这张证书。两轮回包都要通过 Authenticode 校验，且实际签名者必须与测试证书一致。
- 测试产物名是 `whale-girl-test-signed-setup-版本号`。正式签名仅在版本 tag 上按仓库变量启用。
- 通配符默认 `max-matches=1`：安装包那条 `whale-girl-*-setup.exe` 必须只匹配到一个文件。
- `pe-file` 只签 PE 本身。安装包里的 `WhaleLauncher.exe` 是**先单独签好**再被 Inno 压进包里的，
  SignPath 不会（也做不到）去改 Inno 里的压缩数据。
- 仓库首页（`README.md`）和 `docs/CODE_SIGNING_POLICY.md` 里必须有 SignPath 要求的
  「Code signing policy」段落，否则审核不通过。
- 完整申请与配置步骤见 `docs/打包与签名.md` 第四节。
