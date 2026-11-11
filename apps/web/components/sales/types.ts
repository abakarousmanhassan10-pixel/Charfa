export type AgentMode = 'AI_ACTIVE' | 'AI_PAUSED' | 'HUMAN';
export type ConvStatus = 'OPEN' | 'PENDING_HUMAN' | 'RESOLVED' | 'ARCHIVED';
export type LeadStatus = 'NEW' | 'ENGAGED' | 'QUALIFIED' | 'OPPORTUNITY' | 'WON' | 'LOST';
export type Intent = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface AgentConfig {
  enabled: boolean;
  name: string;
  languages: string[];
  defaultLanguage: string;
  tone: string | null;
  greeting: string | null;
  handoffMessage: string | null;
  replyMode: 'REVIEW' | 'AUTO';
  autoReplyAuthorizedAt: string | null;
  maxAiRepliesPerConversation: number;
}

export interface ConversationRow {
  id: string;
  channel: string;
  status: ConvStatus;
  aiMode: AgentMode;
  isTest: boolean;
  language: string | null;
  intent: string | null;
  purchaseIntent: Intent;
  escalated: boolean;
  handoffReason: string | null;
  lastMessageAt: string | null;
  customer: { id: string; name: string | null; leadStatus: LeadStatus } | null;
  lastMessage: { body: string; author: string } | null;
  pendingDrafts: number;
}

export interface Card {
  type: string;
  id: string;
  name: string;
  price: string | null;
  discountPrice: string | null;
  currency: string | null;
  availability: string | null;
  url: string | null;
}

export interface SalesMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  author: 'CUSTOMER' | 'HUMAN_AGENT' | 'AI_REPLY' | 'AI_SUGGESTION' | 'SYSTEM';
  authorName: string | null;
  body: string;
  language: string | null;
  intent: string | null;
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  sent: boolean;
  createdAt: string;
  ai: { kind: string | null; confidence: string | null; sources: string[]; cards: Card[]; handoffReason: string | null; flagged: boolean; edited: boolean; nextStep: string | null } | null;
  injectionFlags: string[];
}

export interface ConversationDetail {
  conversation: ConversationRow & { humanTakeoverById: string | null; aiRepliesCount: number; createdAt: string };
  customer: { id: string; name: string | null; email: string | null; phone: string | null; language: string | null; leadStatus: LeadStatus; purchaseIntent: Intent; interests: string[]; consent: boolean; anonymized: boolean } | null;
  messages: SalesMessage[];
  notes: Array<{ id: string; body: string; authorName: string | null; createdAt: string; conversationId: string | null }>;
  feedback: Array<{ id: string; messageId: string; note: string; correction: string | null; status: 'OPEN' | 'RESOLVED' }>;
  outcome?: string;
}

export interface CustomerRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  language: string | null;
  leadStatus: LeadStatus;
  purchaseIntent: Intent;
  lastIntent: string | null;
  interests: string[];
  consent: boolean;
  followUpAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  anonymized: boolean;
  conversations?: number;
}
export interface CustomerDetail extends CustomerRow {
  conversationList: Array<{ id: string; status: ConvStatus; aiMode: AgentMode; intent: string | null; purchaseIntent: Intent; lastMessageAt: string | null }>;
  notes: Array<{ id: string; body: string; authorName: string | null; createdAt: string }>;
}

export const LEAD_STATUSES: LeadStatus[] = ['NEW', 'ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'WON', 'LOST'];
export const LANGS = ['en', 'fr', 'tr', 'ar'] as const;
