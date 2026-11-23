'use strict';

exports.providers = {
  'task.tick@1': async (_input, { host }) => {
    const status = await host.call('status.read@1', {});
    return { checked: true, status };
  },
};
