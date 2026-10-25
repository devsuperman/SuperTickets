import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import EventList from '@/pages/customer/EventList'
import EventDetail from '@/pages/customer/EventDetail'
import Cart from '@/pages/customer/Cart'
import OrderStatus from '@/pages/customer/OrderStatus'
import EventManage from '@/pages/admin/EventManage'
import EventForm from '@/pages/admin/EventForm'

const queryClient = new QueryClient()

// The GitHub Pages build (`npm run build:pages`) has no backend, so it serves only the lab routes.
const labOnly = import.meta.env.MODE === 'pages'

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <header className="border-b">
          <nav className="mx-auto flex max-w-5xl items-center gap-2 p-4">
            <Link to="/" className="mr-auto text-lg font-semibold">SuperTickets</Link>
            {!labOnly && (
              <>
                <Button asChild variant="ghost"><Link to="/cart">Cart</Link></Button>
                <Button asChild variant="ghost"><Link to="/manage">Manage</Link></Button>
              </>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-5xl p-4">
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
            {/* Lab routes (T18) go here, outside the branch above, so the Pages build serves them too. */}
          </Routes>
        </main>
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
