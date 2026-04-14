export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const rawGeoCache = new Map<string, any>();
