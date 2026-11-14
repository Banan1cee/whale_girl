'use strict';

// 由浏览器验收脚本注入页面执行，检查真实计算颜色与祖先背景的透明叠加。
function auditContrast() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const colors = new Map();
  function rgba(value) {
    if (colors.has(value)) return colors.get(value);
    context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
    const pixel = [...context.getImageData(0, 0, 1, 1).data];
    pixel[3] /= 255; colors.set(value, pixel); return pixel;
  }
  function composite(front, back) {
    return front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])).concat(1);
  }
  function luminance(color) {
    const values = color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  }
  const failures = [];
  let checked = 0;
  let minimum = 100;
  function inspect(element, text, pseudo) {
    if (element.closest('[aria-hidden="true"], [inert], [hidden], :disabled, svg, .motion-ghost-layer')) return;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element, pseudo);
    if (!rect.width || !rect.height || rect.right <= 0 || style.visibility !== 'visible' || style.display === 'none') return;
    const ancestors = [];
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) {
      const computed = getComputedStyle(node);
      opacity *= Number(computed.opacity);
      ancestors.push(computed.backgroundColor);
    }
    if (opacity < 0.95) return;
    let background = [255, 255, 255, 1];
    for (const value of ancestors.reverse()) background = composite(rgba(value), background);
    const foreground = rgba(style.color);
    const effective = composite([foreground[0], foreground[1], foreground[2], foreground[3] * opacity], background);
    const values = [luminance(effective), luminance(background)].sort((a, b) => b - a);
    const ratio = (values[0] + 0.05) / (values[1] + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    const required = large ? 3 : 4.5;
    checked += 1; minimum = Math.min(minimum, ratio);
    if (ratio + 0.03 < required) failures.push({ text: text.trim().slice(0, 65), selector: element.tagName.toLowerCase() + (element.className ? '.' + String(element.className).trim().split(' ').join('.') : ''), ratio: Number(ratio.toFixed(2)), required, color: style.color, background, fontSize: style.fontSize, placeholder: Boolean(pseudo) });
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.trim() && !node.parentElement.closest('script, style, noscript')) inspect(node.parentElement, node.textContent);
  }
  for (const input of document.querySelectorAll('input[placeholder]')) if (!input.value) inspect(input, input.placeholder, '::placeholder');
  return { theme: document.documentElement.dataset.theme, checked, minimum: Number(minimum.toFixed(2)), failures };
}

module.exports = { auditContrast };
