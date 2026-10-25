import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useMatch } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import EventList from '@/pages/customer/EventList'
import EventDetail from '@/pages/customer/EventDetail'
import Cart from '@/pages/customer/Cart'
import OrderStatus from '@/pages/customer/OrderStatus'
import EventManage from '@/pages/admin/EventManage'
import EventForm from '@/pages/admin/EventForm'

const queryClient = new QueryClient()

// The lab (simulation engine + charts) is its own chunk, loaded only on /lab.
const LabHome = lazy(() => import('@/pages/lab/LabHome'))
const LabScenario = lazy(() => import('@/pages/lab/LabScenario'))

// The GitHub Pages build (`npm run build:pages`) has no backend, so it serves only the lab routes.
const labOnly = import.meta.env.MODE === 'pages'

// The lab's four panels need more room than the shop pages.
function Main({ children }: { children: ReactNode }) {
  const lab = useMatch('/lab/*')
  return (
    <main className={`mx-auto p-4 ${lab ? 'max-w-7xl' : 'max-w-5xl'}`}>
      <Suspense fallback={<p className="text-muted-foreground">Loading...</p>}>{children}</Suspense>
    </main>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <header className="border-b">
          <nav className="mx-auto flex max-w-7xl items-center gap-2 p-4">
            <Link to="/" className="mr-auto text-lg font-semibold">SuperTickets</Link>
            <Button asChild variant="ghost"><Link to="/lab">Lab</Link></Button>
            {!labOnly && (
              <>
                <Button asChild variant="ghost"><Link to="/cart">Cart</Link></Button>
                <Button asChild variant="ghost"><Link to="/manage">Manage</Link></Button>
              </>
            )}
          </nav>
        </header>
        <Main>
          <Routes>
            {labOnly ? (
              <Route path="/" element={<Navigate to="/lab" replace />} />
            ) : (
              <>
                <Route path="/" element={<EventList />} />
                <Route path="/event/:id" element={<EventDetail />} />
                <Route path="/cart" element={<Cart />} />
                <Route path="/order/:id" element={<OrderStatus />} />
                <Route path="/manage" element={<EventManage />} />
                <Route path="/manage/new" element={<EventForm />} />
                <Route path="/manage/:id" element={<EventForm />} />
              </>
            )}
            {/* Outside the branch above, so the Pages build serves them too. */}
            <Route path="/lab" element={<LabHome />} />
            <Route path="/lab/:scenario" element={<LabScenario />} />
          </Routes>
        </Main>
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
