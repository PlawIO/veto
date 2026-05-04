import type { OutputRule } from '../rules/types.js';

export const NVIDIA_GLINER_PII_DETECTOR_ID = 'nvidia-gliner-pii';

const NVIDIA_GLINER_PII_DETECTORS = new Set([
  NVIDIA_GLINER_PII_DETECTOR_ID,
  'nvidia/gliner-pii',
]);

export function isSemanticOutputRule(rule: OutputRule): boolean {
  const detector = rule.metadata?.detector;
  return typeof detector === 'string'
    && NVIDIA_GLINER_PII_DETECTORS.has(detector.trim().toLowerCase());
}
