'use strict';

const { createHostCapabilities } = require('./hostCapabilities');

function pluginFailure(code, statusCode = 400) { return Object.assign(Error(code), { code, statusCode }); }

class PluginHost {
  constructor(runtime, dependencies) {
    this.runtime = runtime;
    this.host = createHostCapabilities(runtime, dependencies);
  }

  async call(name, input, plugin, options = {}) {
    if (!this.runtime.plugins.isApproved(plugin)) throw pluginFailure('grant_revoked', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw pluginFailure('invalid_host_capability_input');
    try {
      return await this.host.call(name, input, plugin, options);
    } catch (failure) {
      if (failure?.code) throw failure;
      throw pluginFailure('host_capability_failed');
    }
  }
}

module.exports = { PluginHost };
