import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useState } from "react";

export default function Login() {
  const navigate = useNavigate();
  const loc = useLocation();
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMsg, setModalMsg] = useState("");


  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "").trim();

    try {
      setBusy(true);
      await signInWithEmailAndPassword(auth, email, password);
      toast.success("Welcome back!");
      navigate((loc.state as any)?.from?.pathname || "/dashboard", { replace: true });
    } catch (err: any) {
      console.error(err);
      // Check for wrong password error
      if (err?.code === "auth/wrong-password") {
        setModalMsg("Incorrect password. Please try again.");
        setModalOpen(true);
        setTimeout(() => setModalOpen(false), 3000);
      } else {
        toast.error(err?.message || "Login failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    try {
      setBusy(true);
      const prov = new GoogleAuthProvider();
      await signInWithPopup(auth, prov);
      toast.success("Logged in!");
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-hero p-4 py-12">

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-40 z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 min-w-[300px] text-center">
            <p className="mb-4">{modalMsg}</p>
            <button
              className="bg-primary text-white px-4 py-2 rounded"
              onClick={() => setModalOpen(false)}
            >
              Okay!
            </button>
          </div>
        </div>
      )}

      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold text-2xl">
            D
          </div>
          <CardTitle className="text-2xl">Login</CardTitle>
          <CardDescription>Access your DRIPPR seller dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" placeholder="you@company.com" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </Button>
            <Button variant="outline" className="w-full" type="button" onClick={handleGoogle} disabled={busy}>
              Continue with Google
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              New here? <Link className="underline" to="/register">Create account</Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
