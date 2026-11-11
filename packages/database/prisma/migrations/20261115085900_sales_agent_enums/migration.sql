-- New enum values must be committed before use: they live in their own migration.
ALTER TYPE "ConversationChannel" ADD VALUE 'WEB_CHAT';
ALTER TYPE "MessageAuthorType" ADD VALUE 'AI_REPLY';
