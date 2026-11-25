'use strict';

const fs = require('node:fs');
const { versionMetadata } = require('./version-policy');

const align4 = (value) => (value + 3) & ~3;

function requireFormat(condition, message) {
  if (!condition) throw new Error(message);
}

function locateVersionResource(image) {
  const pe = image.readUInt32LE(0x3c);
  requireFormat(image.readUInt16LE(0) === 0x5a4d && image.readUInt32LE(pe) === 0x4550, '安装包不是 PE 文件');
  const optional = pe + 24;
  const magic = image.readUInt16LE(optional);
  requireFormat(magic === 0x10b || magic === 0x20b, '无法识别 PE 可选头');
  const directory = optional + (magic === 0x10b ? 96 : 112);
  const sectionCount = image.readUInt16LE(pe + 6);
  const sectionStart = optional + image.readUInt16LE(pe + 20);
  requireFormat(directory + 40 <= sectionStart, 'PE 数据目录缺失');
  requireFormat(image.readUInt32LE(directory + 32) === 0 && image.readUInt32LE(directory + 36) === 0,
    '只能处理还未签名的安装包');

  function fileOffset(rva, length) {
    for (let index = 0; index < sectionCount; index++) {
      const section = sectionStart + index * 40;
      const delta = rva - image.readUInt32LE(section + 12);
      const rawSize = image.readUInt32LE(section + 16);
      if (delta < 0 || delta + length > rawSize) continue;
      const offset = image.readUInt32LE(section + 20) + delta;
      requireFormat(offset + length <= image.length, 'PE 节区超出文件范围');
      return offset;
    }
    throw new Error('找不到 PE 资源所在节区');
  }

  const resourceSize = image.readUInt32LE(directory + 20);
  const resource = fileOffset(image.readUInt32LE(directory + 16), resourceSize);
  const flags = 0x80000000;
  function children(offset) {
    requireFormat((offset & flags) || offset === 0, '预期 PE 资源子目录');
    const start = resource + (offset & ~flags);
    requireFormat(start + 16 <= resource + resourceSize, 'PE 资源目录超出范围');
    const count = image.readUInt16LE(start + 12) + image.readUInt16LE(start + 14);
    requireFormat(start + 16 + count * 8 <= resource + resourceSize, 'PE 资源条目超出范围');
    return Array.from({ length: count }, (_, index) => {
      const entry = start + 16 + index * 8;
      return { id: image.readUInt32LE(entry), offset: image.readUInt32LE(entry + 4) };
    });
  }
  const version = children(0).find(({ id }) => id === 16); // RT_VERSION
  requireFormat(version, '缺少 PE 版本资源');
  const languages = children(version.offset).flatMap(({ offset }) => children(offset));
  requireFormat(languages.length === 1 && !(languages[0].offset & flags), '预期 Inno Setup 的单一版本资源');
  const entry = resource + languages[0].offset;
  requireFormat(entry + 16 <= resource + resourceSize, 'PE 版本资源记录超出范围');
  const size = image.readUInt32LE(entry + 4);
  const start = fileOffset(image.readUInt32LE(entry), size);
  requireFormat(start >= resource && start + size <= resource + resourceSize, 'PE 版本资源超出范围');
  return { start, size, sizeOffset: entry + 4, checksumOffset: optional + 64 };
}

function parseBlock(data, start, bound) {
  requireFormat(start + 6 <= bound, '版本资源块头截断');
  const end = start + data.readUInt16LE(start);
  const valueLength = data.readUInt16LE(start + 2);
  const type = data.readUInt16LE(start + 4);
  requireFormat(end > start + 6 && end <= bound && type <= 1, '版本资源块长度或类型错误');
  let keyEnd = start + 6;
  while (keyEnd + 2 <= end && data.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
  requireFormat(keyEnd + 2 <= end, '版本资源键缺少终止符');
  const key = data.toString('utf16le', start + 6, keyEnd);
  const valueStart = align4(keyEnd + 2);
  const valueEnd = valueStart + valueLength * (type === 1 ? 2 : 1);
  requireFormat(valueLength === 0 || valueEnd <= end, '版本资源值超出范围');
  const children = [];
  for (let pos = align4(valueEnd); pos < end;) {
    const child = parseBlock(data, pos, end);
    children.push(child);
    pos = align4(child.end);
  }
  return { key, value: data.subarray(valueStart, valueEnd), type, children, end };
}

function encodeBlock({ key, value, type, children }) {
  const keyBytes = Buffer.from(key + '\0', 'utf16le');
  const valueStart = align4(6 + keyBytes.length);
  const parts = children.map(encodeBlock);
  let length = value.length ? valueStart + value.length : 6 + keyBytes.length;
  for (const part of parts) length = align4(length) + part.length;
  const out = Buffer.alloc(length);
  out.writeUInt16LE(length, 0);
  out.writeUInt16LE(type === 1 ? value.length / 2 : value.length, 2);
  out.writeUInt16LE(type, 4);
  keyBytes.copy(out, 6);
  value.copy(out, valueStart);
  let pos = value.length ? valueStart + value.length : 6 + keyBytes.length;
  for (const part of parts) {
    const next = align4(pos);
    part.copy(out, next);
    pos = next + part.length;
  }
  return out;
}

function normalizeInstallerVersion(image, version) {
  const { start, size, sizeOffset, checksumOffset } = locateVersionResource(image);
  const definition = parseBlock(image.subarray(start, start + size), 0, size);
  requireFormat(definition.key === 'VS_VERSION_INFO', 'PE 版本资源根节点不正确');
  const strings = definition.children.find(({ key }) => key === 'StringFileInfo');
  requireFormat(strings?.children.length, '缺少 PE 版本文字字段');
  const expected = { ProductName: 'WhaleGirl', CompanyName: 'WhaleGirl', ProductVersion: version };
  let changed = false;
  for (const table of strings.children) {
    for (const [key, wanted] of Object.entries(expected)) {
      const fields = table.children.filter((field) => field.key === key);
      requireFormat(fields.length === 1 && fields[0].type === 1, '缺少唯一的 PE 字段 ' + key);
      const field = fields[0];
      const text = field.value.toString('utf16le');
      requireFormat(text.endsWith('\0') && text.slice(0, -1).replace(/ +$/, '') === wanted, 'PE 字段内容不正确：' + key);
      if (text === wanted + '\0') continue;
      field.value = Buffer.from(wanted + '\0', 'utf16le');
      changed = true;
    }
  }
  if (!changed) return false;
  const normalized = encodeBlock(definition);
  requireFormat(normalized.length <= size, '新版版本资源超过原 PE 分配空间');

  // 安装内容在 PE 之后，整个文件和资源起始位置不能移动。
  image.fill(0, start, start + size);
  normalized.copy(image, start);
  image.writeUInt32LE(normalized.length, sizeOffset);
  image.writeUInt32LE(0, checksumOffset);
  let checksum = 0;
  for (let i = 0; i < image.length; i += 2) {
    checksum += image[i] | ((image[i + 1] ?? 0) << 8);
    checksum = (checksum & 0xffff) + (checksum >>> 16);
  }
  image.writeUInt32LE(((checksum & 0xffff) + (checksum >>> 16) + image.length) >>> 0, checksumOffset);
  return true;
}

if (require.main === module) {
  try {
    const [file, version] = process.argv.slice(2);
    requireFormat(file && version, '用法：normalize-inno-version.js <安装包.exe> <版本号>');
    const meta = versionMetadata(version);
    const image = fs.readFileSync(file);
    if (normalizeInstallerVersion(image, meta.productVersion)) fs.writeFileSync(file, image);
    console.log('已核对安装包 PE 产品名、公司名和版本号');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { normalizeInstallerVersion };
