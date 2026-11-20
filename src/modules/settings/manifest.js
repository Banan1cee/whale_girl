'use strict';

module.exports = {
  id: 'settings',
  routes: [
    { order: 20, register: require('./routes/features') },
    { order: 30, register: require('./routes/settings') },
    { order: 70, register: require('./routes/config') },
  ],
};
