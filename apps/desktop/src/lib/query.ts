import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Everything here reads live local state; there is no server to be stale against,
      // and refetching on window focus would fire every time the user alt-tabs the game.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000,
    },
  },
});
