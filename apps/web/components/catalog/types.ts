import type { MediaItem } from '@/components/media/media-types';

export interface Category {
  id: string;
  kind: 'PRODUCT' | 'SERVICE';
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  sortOrder: number;
  itemCount: number;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  price: string | null;
  discountPrice: string | null;
  currency: string | null;
  stockQuantity: number | null;
  availability: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  features: string[];
  benefits: string[];
  targetAudience: string | null;
  url: string | null;
  media: MediaItem[];
  updatedAt: string;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  price: string | null;
  currency: string | null;
  durationMinutes: number | null;
  availability: string;
  availabilityNotes: string | null;
  bookingInfo: string | null;
  bookingUrl: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  features: string[];
  benefits: string[];
  targetAudience: string | null;
  updatedAt: string;
}
