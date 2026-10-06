/** Runtime list of case tags (mirrors the EvalCaseTag union in contracts.ts). */
import type { EvalCaseTag } from './contracts.ts';

export const EVAL_CASE_TAGS: readonly EvalCaseTag[] = [
  'BUSINESS_TYPE',
  'INDUSTRY',
  'SPECIALTY',
  'SUB_SPECIALTY',
  'BRAND',
  'LOCATION',
  'PERSIAN',
  'ENGLISH',
  'MIXED',
  'ARABIC_VARIANTS',
  'ZWNJ',
  'AMBIGUOUS',
  'WEAK_EVIDENCE',
  'STRONG_EVIDENCE',
  'MISSING_LOCATION',
  'INACTIVE',
  'NOISY_AUDIENCE',
  'CANONICAL',
];
