import { QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export async function fetchAndParse<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return schema.parse(await response.json());
}
