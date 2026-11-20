'use strict';

module.exports = {
  id: 'stickers',
  order: 120,
  create(runtime, { store, logger }) {
    const { StickerService } = require('./service');
    return new StickerService(runtime.config, { store, logger: logger.child('sticker') });
  },
  routes: require('./routes'),
};
