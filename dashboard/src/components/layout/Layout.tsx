import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";

interface LayoutProps {
  onLogout?: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Mobile header */}
      <header className="fixed top-0 left-0 right-0 h-14 bg-[var(--sidebar-bg)] border-b border-[var(--sidebar-border)] flex items-center px-4 z-40 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <div className="w-6 h-6 rounded-md bg-[var(--primary)] flex items-center justify-center">
            <span className="text-white font-bold text-xs">P</span>
          </div>
          <span className="text-sm font-bold text-[var(--foreground)]">PoolProxy</span>
        </div>
      </header>

      {/* Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="md:ml-[240px] h-dvh overflow-y-auto p-4 pt-18 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6 md:pt-6">
        <Outlet />
      </main>
    </div>
  );
}
