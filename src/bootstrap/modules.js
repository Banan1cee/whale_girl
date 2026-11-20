'use strict';

/**
 * 启动期模块发现器：只扫描 src/modules/<id>/manifest.js。
 *
 * 清单是「声明」，不是「执行」：这里只 require 清单本身，不创建实例、不启动任务，
 * 免得一次加载就把模型、定时器或文件句柄带起来。所有清单错误在启动时带着目录名报出，
 * 不留到第一次请求才炸。
 *
 * routes 两种写法：
 *   routes: register(router)          // 单路由，order 写在 manifest 顶层
 *   routes: [{ order, register }, …]  // 多路由（settings/wechat 等），order 写在注册项上
 */
const fs = require('node:fs');
const path = require('node:path');

const MODULES_DIR = path.join(__dirname, '..', 'modules');

function manifestError(dirName, message) {
  return new Error(`模块清单错误（src/modules/${dirName}/manifest.js）：${message}`);
}

function normalizeRoutes(manifest, dirName) {
  if (manifest.routes === undefined) return [];
  if (typeof manifest.routes === 'function') {
    if (typeof manifest.order !== 'number' || !Number.isFinite(manifest.order)) {
      throw manifestError(dirName, '单路由模块必须提供有限数字 order');
    }
    return [{ order: manifest.order, register: manifest.routes }];
  }
  if (Array.isArray(manifest.routes)) {
    const seen = new Set();
    return manifest.routes.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw manifestError(dirName, `routes[${index}] 必须是 { order, register } 对象`);
      }
      if (typeof item.order !== 'number' || !Number.isFinite(item.order)) {
        throw manifestError(dirName, `routes[${index}].order 必须是有限数字`);
      }
      if (typeof item.register !== 'function') {
        throw manifestError(dirName, `routes[${index}].register 必须是函数`);
      }
      if (seen.has(item.order)) {
        throw manifestError(dirName, `routes[${index}].order=${item.order} 在本模块内重复`);
      }
      seen.add(item.order);
      return { order: item.order, register: item.register };
    });
  }
  throw manifestError(dirName, 'routes 必须是函数或 [{ order, register }] 数组');
}

/**
 * 读取并按 order 升序返回所有模块。
 * @returns {Array<{ id: string, order?: number, create?: Function, routes?: Function|Array, routeEntries: Array<{order:number,register:Function}>, dir: string }>}
 */
function loadModules(modulesDir = MODULES_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch (err) {
    // 还没迁任何模块时目录可以不存在；空列表是合法状态。
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const modules = [];
  const seenIds = new Map();
  const seenOrders = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const manifestPath = path.join(modulesDir, dirName, 'manifest.js');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = require(manifestPath);
    } catch (err) {
      throw manifestError(dirName, '加载失败：' + ((err && err.message) || err));
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw manifestError(dirName, '必须导出对象');
    }
    if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
      throw manifestError(dirName, 'id 必须是非空字符串');
    }
    if (manifest.id !== dirName) {
      throw manifestError(dirName, `id="${manifest.id}" 必须与目录名 "${dirName}" 一致`);
    }
    const routeEntries = normalizeRoutes(manifest, dirName);
    if (manifest.create !== undefined && typeof manifest.create !== 'function') {
      throw manifestError(dirName, 'create 必须是函数');
    }
    if (seenIds.has(manifest.id)) {
      throw manifestError(dirName, `id="${manifest.id}" 与 ${seenIds.get(manifest.id)} 重复`);
    }
    for (const item of routeEntries) {
      if (seenOrders.has(item.order)) {
        throw manifestError(dirName, `order=${item.order} 与 ${seenOrders.get(item.order)} 重复`);
      }
      seenOrders.set(item.order, `${manifest.id}`);
    }
    seenIds.set(manifest.id, dirName);

    const order = typeof manifest.order === 'number' && Number.isFinite(manifest.order)
      ? manifest.order
      : (routeEntries.length ? routeEntries[0].order : undefined);

    modules.push({
      id: manifest.id,
      order,
      create: manifest.create,
      routes: manifest.routes,
      routeEntries,
      dir: path.join(modulesDir, dirName),
    });
  }

  modules.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  return modules;
}

module.exports = { loadModules };
