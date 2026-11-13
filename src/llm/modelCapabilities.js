'use strict';

const MODEL_FAMILIES = [
  ['openaiReasoning', /^(gpt-5|gpt5|o[134](?:-|$)|chatgpt)/],
  ['claude', /^claude/],
  ['glm53', /(^|[/-])glm-5\.3(?!-flash)/],
  ['glm', /(^|[/-])glm/],
  ['deepseek', /(^|[/-])deepseek/],
  ['qwen', /(^|[/-])qwen/],
  ['hunyuan', /(^|[/-])hy\d/],
  ['kimi', /(^|[/-])kimi/],
  ['minimax', /(^|[/-])minimax/],
  ['thinkingDisabled', /(^|[/-])(mimo|longcat)/],
  ['noThinking', /(^|[/-])step-/],
  ['gemini', /^(gemini|grok)/],
];

function resolveModelCapabilities(model) {
  const name = String(model || '').toLowerCase();
  const match = MODEL_FAMILIES.find(([, pattern]) => pattern.test(name));
  const thinkingFamily = match ? match[0] : null;
  const openAIReasoning = thinkingFamily === 'openaiReasoning';
  return {
    thinkingFamily,
    maxTokensField: openAIReasoning ? 'max_completion_tokens' : 'max_tokens',
    supportsTemperature: !openAIReasoning,
    supportsFrequencyPenalty: !openAIReasoning,
    supportsPresencePenalty: !openAIReasoning,
  };
}

function normalizeTemperature(value, { safe = false, provider = '' } = {}) {
  const fallback = safe ? 0.7 : 0.95;
  const configured = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const retryTemperature = safe && configured === 0 ? fallback : configured;
  const ceiling = safe ? 0.7 : 2;
  const temperature = Math.max(0, Math.min(ceiling, retryTemperature));
  return provider === 'zhipu' ? Math.min(temperature, 0.99) : temperature;
}

module.exports = { resolveModelCapabilities, normalizeTemperature };
