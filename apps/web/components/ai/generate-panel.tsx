'use client';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { useBusiness } from '@/components/business-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/** Common form footer: instructions, generate and regenerate buttons, permission notice. */
export function GeneratePanel({
  children,
  instructions,
  onInstructions,
  pending,
  canGenerate = true,
  onGenerate,
  onRegenerate,
  configured,
}: {
  children: React.ReactNode;
  instructions: string;
  onInstructions: (v: string) => void;
  pending: boolean;
  canGenerate?: boolean;
  onGenerate: () => void;
  onRegenerate?: () => void;
  configured: boolean;
}) {
  const { t } = useI18n();
  const { can } = useBusiness();
  const allowed = can('ai.use');
  return (
    <Card className="mb-6">
      <CardContent className="grid gap-4 pt-6">
        {children}
        <Field id="ai-instructions" label={t('ai.fields.instructions')} hint={t('ai.instructionsHint')} optional optionalLabel={t('common.optional')}>
          <Textarea id="ai-instructions" rows={2} maxLength={500} value={instructions} onChange={(e) => onInstructions(e.target.value)} aria-describedby="ai-instructions-hint" />
        </Field>
        {!allowed && <p className="text-sm text-muted-foreground">{t('ai.noPermission')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onGenerate} disabled={pending || !allowed || !canGenerate || !configured}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
            {pending ? t('ai.generating') : t('ai.generate')}
          </Button>
          {onRegenerate && (
            <Button variant="outline" onClick={onRegenerate} disabled={pending || !allowed || !configured}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t('ai.regenerate')}
            </Button>
          )}
        </div>
        {pending && <p className="text-xs text-muted-foreground" aria-live="polite">{t('ai.generatingHint')}</p>}
      </CardContent>
    </Card>
  );
}
