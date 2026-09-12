import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { OUT_FILE } from './global-setup.js';

/**
 * Shared fixtures and helpers for both Playwright projects.
 *
 * - `panel` (panel.spec.ts) drives the real UI, so the English dictionary is
 *   pinned before any app code runs (the app defaults to Turkish when
 *   localStorage is empty), and tests receive the throwaway accounts
 *   provisioned by global-setup.
 * - `smoke` (smoke.spec.ts) is pure API checks against a running deployment
 *   and never opens a page or touches the accounts.
 */
export interface Credentials {
  email: string;
  password: string;
}
export interface E2eAccounts {
  run: string;
  admin: Credentials;
  editor: Credentials;
  user: Credentials;
}

let cached: E2eAccounts | null = null;

/** Accounts provisioned by global-setup — one throwaway set per run. */
export function loadAccounts(): E2eAccounts {
  if (!cached) cached = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as E2eAccounts;
  return cached;
}

export const test = base.extend<{ accounts: E2eAccounts }>({
  accounts: async ({}, use) => {
    await use(loadAccounts());
  },
  page: async ({ page }, use) => {
    await page.addInitScript(() => localStorage.setItem('qrv.lang', 'en'));
    await use(page);
  },
});

export { expect };

/** Sign the given account into the panel and wait for the cards view. */
export async function signIn(page: Page, account: Credentials): Promise<void> {
  await page.goto('/panel');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Cards' })).toBeVisible();
}

/** Sign out through the header button. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}
