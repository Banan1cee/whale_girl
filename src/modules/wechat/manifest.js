'use strict';

module.exports = {
  id: 'wechat',
  routes: [
    { order: 60, register: require('./routes/wechat') },
    { order: 110, register: require('./routes/bridge') },
  ],
};
