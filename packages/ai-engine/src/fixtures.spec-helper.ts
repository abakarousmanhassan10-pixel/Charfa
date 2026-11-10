import type { BusinessContext } from './context';

export function ctx(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
    businessId: 'biz1',
    business: { name: 'Café Awa', type: 'RESTAURANT', currency: 'XAF', city: "N'Djamena", country: 'TD', industry: 'Food', website: 'https://cafe-awa.example', brandVoice: 'Warm' },
    products: [
      { id: 'p1', name: 'Bissap juice', price: '1500.00', discountPrice: null, currency: 'XAF', features: ['Hibiscus', 'Cold'], benefits: ['Refreshing'], stock: 'not tracked' },
    ],
    services: [{ id: 's1', name: 'Catering', price: null, currency: 'XAF', features: [], benefits: [] }],
    knowledge: [{ id: 'k1', category: 'DELIVERY_POLICY', title: 'Delivery', body: 'Delivery in the city costs 1 000 XAF. Orders over 10 000 XAF get 10% off.' }],
    missingInformation: [],
    ...overrides,
  };
}
