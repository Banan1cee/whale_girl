'use strict';

// dataAccess 里的 model.prompt 是读 system 的许可：没声明时宿主不会把 system 交给插件，
// 返回的 system 也会被宿主换回上一层，等于这段增强不生效（不会报错，也不会有提示）。
const DEFAULT_SUFFIX = '回复用短句，不要输出 Markdown。';

exports.providers = {
  'chat.prompt@1': ({ system }, { settings }) => {
    const suffix = typeof settings?.suffix === 'string' && settings.suffix.trim()
      ? settings.suffix.trim().slice(0, 200)
      : DEFAULT_SUFFIX;
    return { system: `${system}\n${suffix}`.slice(0, 64000) };
  },
};
