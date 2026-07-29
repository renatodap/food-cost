import { Nav } from "@/components/Nav";

/** The authenticated shell. Everything past the login gate renders inside it. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
