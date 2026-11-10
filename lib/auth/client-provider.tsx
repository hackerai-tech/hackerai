"use client";
import * as workos from "@workos-inc/authkit-nextjs/components";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ComponentProps,
} from "react";
import { isSelfHosted } from "@/lib/selfhost/config";
export * from "@workos-inc/authkit-nextjs/components";

type State = ReturnType<typeof workos.useAuth>;
type TokenState = ReturnType<typeof workos.useAccessToken>;
const Context = createContext<{ auth: State; token: TokenState } | null>(null);

function LocalProvider({
  children,
  initialAuth,
}: ComponentProps<typeof workos.AuthKitProvider>) {
  const [state, setState] = useState(initialAuth);
  const [accessToken, setToken] = useState<string>();
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/local-auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Não foi possível verificar a sessão.");
      const next = await response.json();
      setState(next.auth);
      setToken(next.accessToken);
      return next.accessToken as string | undefined;
    } finally {
      setLoading(false);
    }
  }, []);
  const refreshAuth = useCallback(async () => {
    await refresh();
  }, [refresh]);
  const signOut = useCallback(async () => {
    const response = await fetch("/api/local-auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Não foi possível sair.");
    setState({ user: null });
    setToken(undefined);
    window.location.assign("/local-login");
  }, []);
  const auth: State = {
    user: state?.user ?? null,
    sessionId: state && "sessionId" in state ? state.sessionId : undefined,
    organizationId: undefined,
    role: undefined,
    roles: undefined,
    permissions: undefined,
    entitlements:
      state && "entitlements" in state ? state.entitlements : undefined,
    featureFlags: undefined,
    impersonator: undefined,
    loading: false,
    getAuth: refreshAuth,
    refreshAuth,
    signOut,
    switchToOrganization: async () => ({
      error: "Esta instalação usa uma conta local.",
    }),
  };
  return (
    <Context.Provider
      value={{
        auth,
        token: {
          accessToken,
          loading,
          error: null,
          refresh,
          getAccessToken: refresh,
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}

export const AuthKitProvider = isSelfHosted()
  ? LocalProvider
  : workos.AuthKitProvider;
const useLocalAuth = () => {
  const context = useContext(Context);
  if (!context) throw new Error("Provedor de autenticação não disponível.");
  return context.auth;
};
const useLocalToken = () => {
  const context = useContext(Context);
  if (!context) throw new Error("Provedor de autenticação não disponível.");
  return context.token;
};
export const useAuth = (
  isSelfHosted() ? useLocalAuth : workos.useAuth
) as typeof workos.useAuth;
export const useAccessToken = isSelfHosted()
  ? useLocalToken
  : workos.useAccessToken;
