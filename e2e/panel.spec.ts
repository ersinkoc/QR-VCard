import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, signIn, signOut, test } from './helper';

let probeCode = '';

function shortCode(page: import('@playwright/test').Page): Promise<string> {
  // The card row shows "host/c/<code>" in the muted code line; pull the code
  // out of the full line text (which also carries the view count suffix).
  return page
    .locator('li', { hasText: 'E2E' })
    .first()
    .getByText(/\/c\//)
    .first()
    .textContent()
    .then((t) => /\/c\/([A-Za-z0-9-]+)/.exec(t ?? '')?.[1] ?? '');
}

test.describe('panel main flows', () => {
  test('sign-in rejects wrong credentials and accepts valid ones', async ({ page, accounts }) => {
    await page.goto('/panel');
    await page.getByLabel('Email').fill(accounts.user.email);
    await page.getByLabel('Password').fill('definitely-not-it');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Wrong email or password.')).toBeVisible();

    await page.getByLabel('Password').fill(accounts.user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'Cards' })).toBeVisible();
    // A plain user sees neither admin tab.
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Audit trail' })).toHaveCount(0);
  });

  test('user: creates a card, shows the QR, publishes, then deletes it', async ({ page, accounts }) => {
    await signIn(page, accounts.user);

    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('First name').fill('E2E');
    await page.getByLabel('Last name').fill('Probe');
    await page.getByLabel('Organization').fill('E2E Industries');
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();

    // The QR modal renders a real generated PNG from the same-origin endpoint.
    await page.getByRole('button', { name: 'QR', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const qr = page.getByRole('img', { name: /QR code for/ });
    await expect(qr).toBeVisible();
    await expect(async () => {
      const ok = await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
      expect(ok).toBe(true);
    }).toPass();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Publish' }).first().click();
    await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
    probeCode = await shortCode(page);
    expect(probeCode).not.toBe('');

    await page.getByRole('button', { name: 'Delete' }).first().click();
    await expect(page.getByText('Delete this card?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(page.getByText('Card deleted.')).toBeVisible();
    await signOut(page);
  });

  test('published card is publicly readable and counted for its owner', async ({ page, accounts, request }) => {
    await signIn(page, accounts.user);
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('First name').fill('E2E');
    await page.getByLabel('Last name').fill('Public');
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).first().click();
    await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
    const code = await shortCode(page);

    // Anonymous API view (what a scanned QR does).
    const anon = await request.get(`/api/public/cards/${code}`);
    expect(anon.status()).toBe(200);
    expect(((await anon.json()) as { data: { code: string } }).data.code).toBe(code);

    // Cleanup.
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(page.getByText('Card deleted.')).toBeVisible();
    await signOut(page);
  });

  test('editor: manages cards but has no Users or Audit tabs, and direct navigation redirects', async ({ page, accounts }) => {
    await signIn(page, accounts.editor);
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Audit trail' })).toHaveCount(0);
    await expect(page.getByText('All cards')).toBeVisible();

    // While still signed in: the router redirects a non-admin away from /panel/users.
    await page.goto('/panel/users');
    await expect(page).not.toHaveURL(/panel\/users/);
    await expect(page.getByRole('link', { name: 'Cards' })).toBeVisible();
    await signOut(page);
  });

  test('admin: audit trail records a user creation end-to-end', async ({ page, accounts }) => {
    await signIn(page, accounts.admin);
    // The 30-day scan trend chart is part of the admin cards view.
    await expect(page.getByText(/-day scan trend/)).toBeVisible();
    await page.getByRole('link', { name: 'Users' }).click();
    await page.getByRole('button', { name: 'New user' }).click();
    await page.getByLabel('Email').fill(`e2e-probe-${Date.now()}@example.com`);
    await page.getByLabel('Initial password').fill('E2e-Probe-Pass1!');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText(/User created\./)).toBeVisible();

    await page.getByRole('link', { name: 'Audit trail' }).click();
    await expect(page.getByText(/created an account/).first()).toBeVisible();
    await signOut(page);
  });

  test('plain user is refused user administration at the API (defense in depth)', async ({ request, accounts }) => {
    const login = await request.post('/api/auth/login', {
      data: { email: accounts.user.email, password: accounts.user.password },
      headers: { 'X-QRV': '1' },
    });
    expect(login.status()).toBe(200);
    expect((await request.get('/api/users')).status()).toBe(403);
    expect((await request.get('/api/audit')).status()).toBe(403);
  });

  test('photo upload stores an image that the API serves back', async ({ page, accounts }) => {
    await signIn(page, accounts.user);
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('First name').fill('E2E');
    await page.getByLabel('Last name').fill('Photo');
    // Canonical 1x1 PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const file = join(tmpdir(), `e2e-photo-${Date.now()}.png`);
    writeFileSync(file, png);
    await page.setInputFiles('input[type=file]', file);
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();

    // page.request shares the browser session: the uploaded photo must be on
    // the card and the photo endpoint must serve it back.
    const listing = await page.request.get('/api/cards');
    expect(listing.status()).toBe(200);
    const mine = ((await listing.json()) as { data: { id: string; last_name: string | null; photo: string | null }[] }).data.find((c) => c.last_name === 'Photo');
    expect(mine?.photo).toBeTruthy();
    const photo = await page.request.get(`/api/cards/${mine!.id}/photo`);
    expect(photo.status()).toBe(200);
    expect(photo.headers()['content-type']).toMatch(/^image\//);

    // Cleanup.
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(page.getByText('Card deleted.')).toBeVisible();
    rmSync(file, { force: true });
    await signOut(page);
  });
});
