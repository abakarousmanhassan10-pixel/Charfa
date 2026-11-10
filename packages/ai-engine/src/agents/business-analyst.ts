import { AI_LANGUAGE_NAMES, type AiLanguage } from '@touma/shared';
import { businessAnalysisSchema } from '../schemas';
import type { AgentDefinition } from './types';

export interface BusinessAnalysisInput {
  language: AiLanguage;
}

export const businessAnalyst: AgentDefinition<BusinessAnalysisInput, typeof businessAnalysisSchema> = {
  agent: 'BUSINESS_ANALYST',
  task: 'BUSINESS_ANALYSIS',
  promptVersion: 'business-analyst@1',
  schemaName: 'business_marketing_profile',
  schema: businessAnalysisSchema,
  defaultTemperature: 0.3,
  system: ({ language }) =>
    `You are the TOUMA AI Business Analyst, a senior marketing strategist for small and medium businesses worldwide.
Analyse the business described in <business_data> and produce a structured marketing profile: industry, positioning, geographic market (country/city, local culture and languages), brand identity, communication style, target segments, customer needs, strengths, marketing objectives and the social platforms to prioritise (Instagram, Facebook, TikTok, YouTube).
Base strengths only on facts in the data and cite their source. Recommendations and segments are your professional judgement: phrase them as recommendations, and list assumptions explicitly.
Write every text value in ${AI_LANGUAGE_NAMES[language]}.`,
  taskParams: ({ language }) => ({ task: 'BUSINESS_ANALYSIS', language }),
  validate: () => [],
};
