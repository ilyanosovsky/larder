"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { AppHeader } from "./app-header";
import styles from "./app-shell.module.css";
import { NAV_ICONS } from "./nav-icons";
import {
  isNavItemActive,
  SIDEBAR_FOOTER_ITEM,
  TAB_ITEMS,
  type NavItem,
} from "./nav-items";

function NavLink({
  item,
  pathname,
  label,
  variant,
}: {
  item: NavItem;
  pathname: string;
  label: string;
  variant: "tab" | "sidebar";
}) {
  const Icon = NAV_ICONS[item.key];
  const active = isNavItemActive(pathname, item.href);
  const itemClass = variant === "tab" ? styles.tabItem : styles.sidebarItem;
  const activeClass =
    variant === "tab" ? styles.tabItemActive : styles.sidebarItemActive;

  return (
    <Link
      href={item.href}
      className={active ? `${itemClass} ${activeClass}` : itemClass}
      aria-current={active ? "page" : undefined}
    >
      <span className={styles.icon}>
        <Icon />
      </span>
      <span>{label}</span>
    </Link>
  );
}

export function AppShell({
  children,
  householdName,
  userName,
  userImage,
}: {
  children: ReactNode;
  /** Passed down from the `(app)` layout, which already loads it for the gate. */
  householdName: string;
  userName: string;
  userImage: string | null;
}) {
  const pathname = usePathname();
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const navLabel = tCommon("mainNavigation");

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label={navLabel}>
        <nav className={styles.sidebarNav}>
          {TAB_ITEMS.map((item) => (
            <NavLink
              key={item.key}
              item={item}
              pathname={pathname}
              label={tNav(item.key)}
              variant="sidebar"
            />
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <NavLink
            item={SIDEBAR_FOOTER_ITEM}
            pathname={pathname}
            label={tNav(SIDEBAR_FOOTER_ITEM.key)}
            variant="sidebar"
          />
        </div>
      </aside>

      <div className={styles.main}>
        <AppHeader
          householdName={householdName}
          userName={userName}
          userImage={userImage}
        />
        <div className={styles.content}>{children}</div>
      </div>

      <nav className={styles.tabBar} aria-label={navLabel}>
        {TAB_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            item={item}
            pathname={pathname}
            label={tNav(item.key)}
            variant="tab"
          />
        ))}
      </nav>
    </div>
  );
}
