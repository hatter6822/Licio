import { parseClientEnv } from '@licio/shared/env/client';

export const clientEnv = parseClientEnv(
  Object.fromEntries(Object.entries(import.meta.env).filter(([key]) => key.startsWith('VITE_'))),
);
