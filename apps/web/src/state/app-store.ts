import { create } from 'zustand';

interface AppState {
  readonly hasAcceptedSecurityNotice: boolean;
  readonly acceptSecurityNotice: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  hasAcceptedSecurityNotice: false,
  acceptSecurityNotice: () => set({ hasAcceptedSecurityNotice: true }),
}));
