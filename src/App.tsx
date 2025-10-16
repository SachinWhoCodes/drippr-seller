import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Register from "./pages/Register";
import PasswordReset from "./pages/PasswordReset";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";
import Orders from "./pages/Orders";
import Payments from "./pages/Payments";
import Analytics from "./pages/Analytics";
import Support from "./pages/Support";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import SellerSupportAI from "./pages/SellerSupportAI";
import { AuthProvider } from "@/providers/AuthProvider";
import RequireAuth from "@/components/RequireAuth";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
  <TooltipProvider delayDuration={0}>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* public */}
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/password-reset" element={<PasswordReset />} />

          {/* protected */}
          <Route path="/dashboard" element={
            <RequireAuth><Dashboard /></RequireAuth>
          } />
          <Route path="/dashboard/products" element={
            <RequireAuth><Products /></RequireAuth>
          } />
          <Route path="/dashboard/orders" element={
            <RequireAuth><Orders /></RequireAuth>
          } />
          <Route path="/dashboard/payments" element={
            <RequireAuth><Payments /></RequireAuth>
          } />
          <Route path="/dashboard/analytics" element={
            <RequireAuth><Analytics /></RequireAuth>
          } />
          <Route path="/dashboard/sellersupportai" element={
            <RequireAuth><SellerSupportAI /></RequireAuth>
          } />
          <Route path="/dashboard/support" element={
            <RequireAuth><Support /></RequireAuth>
          } />
          <Route path="/dashboard/settings" element={
            <RequireAuth><Settings /></RequireAuth>
          } />

          {/* catch-all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </TooltipProvider>
</QueryClientProvider>
);

export default App;