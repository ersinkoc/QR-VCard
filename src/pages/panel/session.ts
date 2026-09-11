import { createContext, useContext } from 'react';
import type { Me } from '../../lib/api';

export interface Session {
  me: Me;
  setMe: (me: Me) => void;
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside the panel');
  return ctx;
}
