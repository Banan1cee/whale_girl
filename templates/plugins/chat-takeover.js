'use strict';

exports.providers = {
  'chat.handle@1': ({ message }) => {
    if (message.text.trim() !== '你好') return { action: 'ignore' };
    return { action: 'reply', reply: '你好！这条回复来自接管插件。' };
  },
};
