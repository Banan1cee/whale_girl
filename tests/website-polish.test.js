'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'website/polish.css'), 'utf8');
const motion = fs.readFileSync(path.join(root, 'website/site-motion.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
const build = fs.readFileSync(path.join(root, 'scripts/build-website.js'), 'utf8');

function luminance(hex) {
  const rgb = hex.match(/[a-f0-9]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
const dark = css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1];
const colors = Object.fromEntries([...dark.matchAll(/--([a-z-]+)\s*:\s*(#[a-f0-9]{6})/gi)].map(match => [match[1], match[2]]));
for (const background of ['bg', 'surface', 'surface-raised']) {
  for (const text of ['text', 'muted', 'accent']) assert.ok(contrast(colors[text], colors[background]) >= 4.5, `${text} on ${background} 应清晰可读`);
}
assert.ok(contrast(colors['button-text'], colors.button) >= 4.5);
assert.match(home, /data-whale-mark/);
assert.match(build, /data-whale-mark/);
assert.match(home, /polish\.css/);
assert.match(build, /polish\.css/);
assert.match(motion, /disclosureState/);
assert.match(motion, /panelState/);
assert.match(motion, /themeReady/);
assert.doesNotMatch(motion, /observer\.unobserve/, '场景持续观察进出，不能入场后立即注销');
console.log('website polish: dark contrast, shared brand, reversible states and theme coordination passed');
