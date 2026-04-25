"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { SignOutButton, useUser } from "@/auth/clerk";
import { clearLocalAuthToken, isLocalAuthMode } from "@/auth/localAuth";
import {
  Activity,
  Bot,
  Boxes,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Moon,
  Plus,
  Server,
  Settings,
  Store,
  Sun,
  Trello,
  Zap,
} from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTheme, type Theme } from "@/components/providers/ThemeProvider";
import { cn } from "@/lib/utils";

type UserMenuProps = {
  className?: string;
  displayName?: string;
  displayEmail?: string;
};

export function UserMenu({
  className,
  displayName: displayNameFromDb,
  displayEmail: displayEmailFromDb,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const { user } = useUser();
  const { theme, setTheme } = useTheme();
  const localMode = isLocalAuthMode();
  if (!user && !localMode) return null;

  const avatarUrl = localMode ? null : (user?.imageUrl ?? null);
  const avatarLabelSource =
    displayNameFromDb ?? (localMode ? "Local User" : user?.id) ?? "U";
  const avatarLabel = avatarLabelSource.slice(0, 1).toUpperCase();
  const displayName =
    displayNameFromDb ?? (localMode ? "Local User" : "Account");
  const displayEmail =
    displayEmailFromDb ?? (localMode ? "local@localhost" : "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-9 items-center gap-2 rounded-[10px] bg-transparent px-1 py-1 transition",
            "hover:bg-[color:var(--surface-muted)]",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]",
            "data-[state=open]:bg-[color:var(--surface-muted)]",
            className,
          )}
          aria-label="Open user menu"
        >
          <span
            className={cn(
              "relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] text-xs font-semibold text-white shadow-sm",
              avatarUrl
                ? "bg-[color:var(--neutral-200,var(--surface-muted))]"
                : "bg-gradient-to-br from-[color:var(--primary-navy,var(--accent))] to-[color:var(--secondary-navy,var(--accent-strong))]",
            )}
          >
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt="User avatar"
                width={36}
                height={36}
                className="h-9 w-9 object-cover"
              />
            ) : (
              avatarLabel
            )}
          </span>
          <ChevronDown className="h-4 w-4 text-[color:var(--neutral-700,var(--text-quiet))] transition group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={12}
        className="w-80 overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)]/95 p-0 shadow-[0_12px_40px_rgba(0,0,0,0.6)] backdrop-blur"
      >
        <div className="border-b border-[color:var(--border)] px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl text-sm font-semibold text-white",
                avatarUrl
                  ? "bg-[color:var(--neutral-200,var(--surface-muted))]"
                  : "bg-gradient-to-br from-[color:var(--primary-navy,var(--accent))] to-[color:var(--secondary-navy,var(--accent-strong))]",
              )}
            >
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt="User avatar"
                  width={40}
                  height={40}
                  className="h-10 w-10 object-cover"
                />
              ) : (
                avatarLabel
              )}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[color:var(--text)]">
                {displayName}
              </div>
              {displayEmail ? (
                <div className="truncate text-xs text-[color:var(--text-muted)]">
                  {displayEmail}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="p-2">
          <div className="grid grid-cols-2 gap-2">
            <Link
              href="/boards"
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--surface-muted)] px-3 py-2 text-sm font-semibold text-[color:var(--text)] transition hover:border-[color:var(--accent-strong)] hover:bg-[color:var(--surface-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]"
              onClick={() => setOpen(false)}
            >
              <Trello className="h-4 w-4 text-[color:var(--text-quiet)]" />
              Open boards
            </Link>
            <Link
              href="/boards/new"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--primary-navy,var(--accent))] px-3 py-2 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(10,22,40,0.15)] transition hover:bg-[color:var(--secondary-navy,var(--accent-strong))] hover:translate-y-[-1px] hover:shadow-[0_4px_12px_rgba(10,22,40,0.20)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-teal,var(--accent))] focus-visible:ring-offset-2"
              onClick={() => setOpen(false)}
            >
              <Plus className="h-4 w-4 opacity-90" />
              Create board
            </Link>
          </div>

          <div className="my-2 h-px bg-[color:var(--border)]" />

          {(
            [
              { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
              { href: "/activity", label: "Activity", icon: Activity },
              { href: "/agents", label: "Agents", icon: Bot },
              { href: "/gateways", label: "Gateways", icon: Server },
              {
                href: "/skills/marketplace",
                label: "Skills marketplace",
                icon: Store,
              },
              { href: "/skills/packs", label: "Skill packs", icon: Boxes },
              { href: "/settings", label: "Settings", icon: Settings },
            ] as const
          ).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-[color:var(--text)] transition hover:bg-[color:var(--surface-muted)] hover:text-[color:var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]"
              onClick={() => setOpen(false)}
            >
              <item.icon className="h-4 w-4 text-[color:var(--accent)]" />
              {item.label}
            </Link>
          ))}

          <div className="my-2 h-px bg-[color:var(--border)]" />

          <div className="px-1 pb-1">
            <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-quiet)]">
              Appearance
            </p>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  { id: "jarvis" as Theme, label: "Jarvis", Icon: Zap },
                  { id: "dark" as Theme, label: "Dark", Icon: Moon },
                  { id: "light" as Theme, label: "Light", Icon: Sun },
                ] as const
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTheme(id)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-semibold transition",
                    theme === id
                      ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] ring-1 ring-[color:var(--accent)]/30"
                      : "text-[color:var(--text-quiet)] hover:bg-[color:var(--surface-muted)] hover:text-[color:var(--text)]",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="my-2 h-px bg-[color:var(--border)]" />

          {localMode ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-[color:var(--text)] transition hover:bg-[color:var(--surface-muted)] hover:text-[color:var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]"
              onClick={() => {
                clearLocalAuthToken();
                setOpen(false);
                window.location.reload();
              }}
            >
              <LogOut className="h-4 w-4 text-[color:var(--accent)]" />
              Sign out
            </button>
          ) : (
            <SignOutButton>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-[color:var(--text)] transition hover:bg-[color:var(--surface-muted)] hover:text-[color:var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]"
                onClick={() => setOpen(false)}
              >
                <LogOut className="h-4 w-4 text-[color:var(--accent)]" />
                Sign out
              </button>
            </SignOutButton>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
