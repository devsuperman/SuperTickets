import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import EventList from '@/pages/customer/EventList'
import EventDetail from '@/pages/customer/EventDetail'
import Cart from '@/pages/customer/Cart'
import OrderStatus from '@/pages/customer/OrderStatus'
import EventManage from '@/pages/admin/EventManage'
import EventForm from '@/pages/admin/EventForm'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <header className="border-b">
          <nav className="mx-auto flex max-w-5xl items-center gap-2 p-4">
            <Link to="/" className="mr-auto text-lg font-semibold">SuperTickets</Link>
            <Button asChild variant="ghost"><Link to="/cart">Cart</Link></Button>
            <Button asChild variant="ghost"><Link to="/manage">Manage</Link></Button>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl p-4">
          <Routes>
            <Route path="/" element={<EventList />} />
            <Route path="/event/:id" element={<EventDetail />} />
            <Route path="/cart" element={<Cart />} />
            <Route path="/order/:id" element={<OrderStatus />} />
            <Route path="/manage" element={<EventManage />} />
            <Route path="/manage/new" element={<EventForm />} />
            <Route path="/manage/:id" element={<EventForm />} />
          </Routes>
        </main>
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
