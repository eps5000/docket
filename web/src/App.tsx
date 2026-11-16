import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { queryClient } from './app/queryClient';
import { createAppRouter } from './app/router';
import { ShellStateProvider } from './app/ShellState';

/** The token scope (`.tl`) is on <body> in index.html; the theme sets `data-theme` there. */
export function App() {
  const [router] = useState(createAppRouter);
  return (
    <QueryClientProvider client={queryClient}>
      <ShellStateProvider>
        <RouterProvider router={router} />
      </ShellStateProvider>
    </QueryClientProvider>
  );
}
