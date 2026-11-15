import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Home } from './routes/Home';

const queryClient = new QueryClient();

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  // Every client route renders the placeholder until the shell exists.
  { path: '*', element: <Home /> },
]);

/** The token scope (`.tl`) is on <body> in index.html. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
