import { useMemo } from 'react';
import { AppProviders } from './app/providers/AppProviders';
import { createAppQueryClient } from './app/providers/createQueryClient';
import { createAppRouter } from './app/router/AppRouter';
import { emitAuthRequired } from './app/auth/authRequiredBus';

/** 根组件：创建稳定 queryClient/router，不随 render 反复 new。 */
export function App() {
  const queryClient = useMemo(
    () => createAppQueryClient({ onAuthRequired: () => emitAuthRequired() }),
    [],
  );
  const router = useMemo(() => createAppRouter(queryClient), [queryClient]);
  return <AppProviders queryClient={queryClient} router={router} />;
}
