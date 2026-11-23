'use strict';

exports.providers = {
  'chat.reply@1': ({ message, text }) => ({
    text: message.text.startsWith('要点：') && text.length <= 16000 - '要点回复\n'.length
      ? `要点回复\n${text}` : text,
  }),
};
