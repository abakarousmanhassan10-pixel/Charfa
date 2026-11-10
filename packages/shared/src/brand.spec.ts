import { BRAND, brandSlogan } from './brand';
import { renderEmail } from './email-layout';

describe('brand', () => {
  it('exposes the official identity', () => {
    expect(BRAND.name).toBe('TOUMA');
    expect(BRAND.productName).toBe('TOUMA AI');
    expect(brandSlogan('en')).toBe('Your Business. Your AI Marketing Team.');
    expect(brandSlogan('fr')).toBe('Votre entreprise. Votre équipe marketing IA.');
    expect(brandSlogan('tr')).toBe(brandSlogan('en'));
  });
});

describe('renderEmail', () => {
  it('renders a branded email and escapes dynamic content', () => {
    const { html, text } = renderEmail({
      locale: 'en',
      preheader: 'Confirm your email',
      heading: 'Welcome <script>',
      paragraphs: ['Hi "Awa" & team'],
      action: { label: 'Confirm', url: 'https://app.example.com/verify?t=abc' },
    });
    expect(html).toContain('TOUMA AI');
    expect(html).toContain('Your Business. Your AI Marketing Team.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Hi &quot;Awa&quot; &amp; team');
    expect(text).toContain('Confirm: https://app.example.com/verify?t=abc');
  });

  it('rejects non-http action URLs', () => {
    expect(() =>
      renderEmail({ locale: 'en', preheader: '', heading: 'x', paragraphs: [], action: { label: 'x', url: 'javascript:alert(1)' } }),
    ).toThrow();
  });

  it('sets rtl direction for Arabic', () => {
    expect(renderEmail({ locale: 'ar', preheader: '', heading: 'x', paragraphs: [] }).html).toContain('dir="rtl"');
  });
});
