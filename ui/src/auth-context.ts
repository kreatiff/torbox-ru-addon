import { createContext } from 'react';

export interface AuthUser {
  email: string;
  name: string | null;
  picture: string | null;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  logout: async () => {},
});
