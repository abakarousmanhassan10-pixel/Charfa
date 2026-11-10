export interface MediaItem {
  id: string;
  type: 'IMAGE' | 'VIDEO';
  status: string;
  mimeType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  originalFilename: string;
  folder: string;
  tags: string[];
  altText: string | null;
  createdAt: string;
  url: string | null;
  position?: number;
}
