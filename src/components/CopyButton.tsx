import { useState } from 'react';
import { useI18n } from '../i18n';
import { copyText } from '../lib/clipboard';

export default function CopyButton({ text, label, className = 'btn btn-secondary' }: { text: string; label?: string; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      <span aria-live="polite">{copied ? t('common.copied') : (label ?? t('common.copyLink'))}</span>
    </button>
  );
}
