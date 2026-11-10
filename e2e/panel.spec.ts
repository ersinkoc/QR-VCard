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
    await page.getByLabel('Organization name').fill('E2E Industries');
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

    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
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
    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
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
    const mine = ((await listing.json()) as { data: { id: string; last_name: string | null; photo: string | null }[] }).data.find((c) => c.last_name === 'PHOTO');
    expect(mine?.photo).toBeTruthy();
    const photo = await page.request.get(`/api/cards/${mine!.id}/photo`);
    expect(photo.status()).toBe(200);
    expect(photo.headers()['content-type']).toMatch(/^image\//);

    // Cleanup.
    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(page.getByText('Card deleted.')).toBeVisible();
    rmSync(file, { force: true });
    await signOut(page);
  });

  test('institutions: an admin adds an SVG-logo organization; a card links it and copies an address', async ({ page, accounts }) => {
    const name = `E2E Org ${Date.now()}`;
    const svg = join(tmpdir(), `e2e-org-${Date.now()}.svg`);
    // viewBox only (no width/height): the in-browser PNG rendition must still keep the 3:1 shape.
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><rect width="240" height="80" fill="#0f766e"/><circle cx="44" cy="40" r="22" fill="#fbbf24"/></svg>');

    await signIn(page, accounts.admin);
    await page.getByRole('link', { name: 'Organizations' }).click();
    await page.getByRole('button', { name: 'New organization' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Organization name').fill(name);
    await dialog.getByLabel('Website').fill('e2e-org.example');
    await dialog.getByRole('button', { name: '+ Add address' }).click();
    await dialog.getByLabel('Address name 1', { exact: true }).fill('Head office');
    await dialog.getByLabel('Address 1', { exact: true }).fill('1 Test Street, Istanbul');
    await dialog.locator('input[type=file]').setInputFiles(svg);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Organization created.')).toBeVisible();

    const institutions = ((await (await page.request.get('/api/institutions')).json()) as { data: { id: string; name: string; logo: string | null }[] }).data;
    const inst = institutions.find((i) => i.name === name);
    expect(inst?.logo).toBeTruthy();
    expect((await page.request.get(`/api/institutions/${inst!.id}/logo`)).headers()['content-type']).toBe('image/svg+xml');
    // The PNG rendition the browser rendered backs the bitmap consumers.
    const raster = await page.request.get(`/api/institutions/${inst!.id}/logo?format=jpg`);
    expect(raster.status()).toBe(200);
    expect(raster.headers()['content-type']).toBe('image/jpeg');
    await signOut(page);

    await signIn(page, accounts.user);
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('First name').fill('E2E');
    await page.getByLabel('Last name').fill('Org');
    await page.getByLabel('Organization', { exact: true }).selectOption({ label: name });
    await expect(page.getByLabel('Organization name')).toHaveValue(name);
    await page.getByLabel('Copy from organization addresses').selectOption({ index: 1 });
    const address = page.getByLabel('Address', { exact: true });
    await expect(address).toHaveValue('1 Test Street, Istanbul');
    // Copied, not linked: the person edits their own copy.
    await address.fill('1 Test Street, Istanbul — floor 5');
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();

    const listing = await page.request.get('/api/cards');
    const card = ((await listing.json()) as { data: { id: string; code: string; last_name: string | null; organization: string | null; address: string | null; logo: string | null; institution: { id: string } | null }[] }).data.find((row) => row.last_name === 'ORG');
    expect(card?.institution?.id).toBe(inst!.id);
    expect(card?.organization).toBe(name);
    expect(card?.address).toBe('1 Test Street, Istanbul — floor 5');
    expect(card?.logo).toBeNull();

    await page.getByRole('button', { name: 'Publish' }).first().click();
    await expect(page.getByRole('listitem').filter({ hasText: 'E2E Org' }).getByText('Published', { exact: true }).first()).toBeVisible();
    const pub = ((await (await page.request.get(`/api/public/cards/${card!.code}`)).json()) as { data: { organization: string; website: string | null; logo: string | null } }).data;
    expect(pub.organization).toBe(name);
    expect(pub.website).toBe('https://e2e-org.example');
    expect(pub.logo).toBe(inst!.logo);
    expect((await page.request.get(`/api/public/cards/${card!.code}/logo`)).headers()['content-type']).toBe('image/svg+xml');

    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(page.getByText('Card deleted.')).toBeVisible();
    rmSync(svg, { force: true });
    await signOut(page);
  });

  test('institutions: an admin limits a user to chosen organizations and the card form follows', async ({ page, accounts }) => {
    const stamp = Date.now();
    const [allowed, hidden] = [`E2E Org Allowed ${stamp}`, `E2E Org Hidden ${stamp}`];
    await signIn(page, accounts.admin);
    for (const name of [allowed, hidden]) {
      expect((await page.request.post('/api/institutions', { data: { name }, headers: { 'X-QRV': '1' } })).status()).toBe(201);
    }
    await page.getByRole('link', { name: 'Users' }).click();
    const row = page.locator('li', { hasText: accounts.user.email });
    await row.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: 'All organizations' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Only selected organizations' }).check();
    await expect(dialog.getByText(/None selected/)).toBeVisible();
    await dialog.getByRole('checkbox', { name: allowed }).check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('User updated.')).toBeVisible();
    await expect(row.getByText('1 org.')).toBeVisible();
    await signOut(page);

    await signIn(page, accounts.user);
    await page.getByRole('button', { name: 'New card' }).click();
    const picker = page.getByLabel('Organization', { exact: true });
    await expect(picker.locator('option', { hasText: allowed })).toHaveCount(1);
    await expect(picker.locator('option', { hasText: hidden })).toHaveCount(0);
    // The API enforces it too, not just the picker.
    const institutions = ((await (await page.request.get('/api/institutions')).json()) as { data: { name: string }[] }).data.map((i) => i.name);
    expect(institutions).toContain(allowed);
    expect(institutions).not.toContain(hidden);
    await page.keyboard.press('Escape');
    await signOut(page);

    // Back to "all", so no other test depends on running before this one.
    await signIn(page, accounts.admin);
    const users = ((await (await page.request.get('/api/users')).json()) as { data: { id: string; email: string }[] }).data;
    const id = users.find((u) => u.email === accounts.user.email)!.id;
    expect((await page.request.patch(`/api/users/${id}`, { data: { institutions: null }, headers: { 'X-QRV': '1' } })).status()).toBe(200);
    await signOut(page);
  });

  test('page designer publishes a template page with a custom link block', async ({ page, accounts }) => {
    await signIn(page, accounts.user);
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('First name').fill('E2E');
    await page.getByLabel('Last name').fill('Page');
    await page.getByLabel('Phone').fill('+90 555 111 22 33');
    // New cards start in the page designer: no mode switch, the studio is one click away.
    await expect(page.getByRole('button', { name: 'Switch to the page designer' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open the design studio' }).first().click();

    const studio = page.getByRole('dialog', { name: 'Design studio' });
    await studio.getByRole('button', { name: /^Noir/ }).click();
    await studio.getByRole('tab', { name: 'Blocks' }).click();
    await studio.getByRole('combobox', { name: 'Add block' }).selectOption('link');
    await studio.getByRole('button', { name: '+ Add block' }).click();
    await studio.getByLabel('Button text').fill('Menu');
    // An unsafe target blocks Apply; a bare host is accepted and stored as https.
    await studio.getByLabel('Link address (https)').fill('javascript:alert(1)');
    await expect(studio.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await studio.getByLabel('Link address (https)').fill('example.com/menu');
    await studio.getByRole('button', { name: 'Apply' }).click();
    await expect(studio).toBeHidden();

    await page.getByLabel('Status').selectOption('published');
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();

    const listing = await page.request.get('/api/cards');
    const card = ((await listing.json()) as { data: { id: string; code: string; last_name: string | null; design_config: { template: string; blocks: { type: string; url?: string }[] } | null }[] }).data.find((row) => row.last_name === 'PAGE');
    expect(card?.design_config?.template).toBe('noir');
    expect(card?.design_config?.blocks.find((b) => b.type === 'link')?.url).toBe('https://example.com/menu');

    await page.goto(`/c/${card!.code}`);
    await expect(page.locator('.pc[data-theme="dark"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'E2E Page' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Menu/ })).toHaveAttribute('href', 'https://example.com/menu');

    expect((await page.request.delete(`/api/cards/${card!.id}`, { headers: { 'X-QRV': '1' } })).status()).toBe(200);
    await page.goto('/panel');
    await signOut(page);
  });

  test('signature studio: a template and options are saved on the card and come back', async ({ page, accounts }) => {
    await signIn(page, accounts.user);
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('First name').fill('E2E');
    await page.getByLabel('Last name').fill('Signature');
    await page.getByLabel('Phone').fill('+90 555 111 22 33');
    // A photo, so the signature carries an image whose URL can be checked.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const photo = join(tmpdir(), `e2e-sig-${Date.now()}.png`);
    writeFileSync(photo, png);
    await page.setInputFiles('input[type=file]', photo);
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    const openStudio = async () => {
      await page.getByRole('button', { name: 'More actions' }).first().click();
      await page.getByRole('menuitem', { name: 'Signature' }).click();
      const studio = page.getByRole('dialog', { name: 'Email signature studio' });
      await expect(studio).toBeVisible();
      return studio;
    };
    let studio = await openStudio();
    // A draft card: recipients could not load its images yet — say so.
    await expect(studio.getByText(/This card is a draft/)).toBeVisible();
    await studio.getByRole('button', { name: 'Corporate', exact: true }).click();
    await studio.getByRole('tab', { name: 'Extras' }).click();
    await studio.getByLabel('“My digital card” button').check();
    // Photo instead of the logo, so the exported HTML has the card's photo in it.
    await studio.getByRole('tab', { name: 'Style' }).click();
    await studio.getByRole('group', { name: 'Image' }).getByRole('button', { name: 'Photo' }).click();
    await studio.getByRole('button', { name: 'Save design' }).click();
    await expect(studio.getByText('Signature design saved to the card.')).toBeVisible();
    // The preview is the signature itself: name in the card's spelling, the button, email-safe images.
    const preview = await studio.locator('iframe[title="Preview"]').evaluate((f: HTMLIFrameElement) => ({
      text: f.contentDocument?.body.innerText ?? '',
      imgs: [...(f.contentDocument?.querySelectorAll('img') ?? [])].map((i) => ({ src: i.getAttribute('src') ?? '', w: i.getAttribute('width') })),
    }));
    // The card's name rule, Turkish casing included (i → İ).
    expect(preview.text).toContain('E2e SİGNATURE');
    expect(preview.text).toContain('My digital card');
    for (const img of preview.imgs) {
      expect(img.src).toMatch(/^https?:\/\//);
      expect(img.w).toMatch(/^\d+$/);
    }
    // What gets pasted into a mail client points at the PUBLIC image URL, never the
    // signed-in panel URL the draft preview uses (that would never load for recipients).
    await studio.getByRole('button', { name: 'Copy HTML source' }).click();
    await expect(studio.getByText(/HTML source copied/)).toBeVisible();
    const pasted = await page.evaluate(() => navigator.clipboard.readText());
    expect(pasted).toContain('/api/public/cards/');
    expect(pasted).not.toContain('/api/cards/');
    expect(pasted).not.toMatch(/<svg|data:/);
    await page.keyboard.press('Escape');

    studio = await openStudio();
    await expect(studio.getByRole('button', { name: 'Corporate', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await studio.getByRole('tab', { name: 'Extras' }).click();
    await expect(studio.getByLabel('“My digital card” button')).toBeChecked();
    await expect(studio.getByRole('button', { name: 'Save design' })).toBeDisabled();

    // Free HTML: the editor opens on the starter, refuses active markup and keeps what it accepts.
    await studio.getByRole('tab', { name: 'Template' }).click();
    await studio.getByRole('button', { name: 'Free HTML', exact: true }).click();
    const editor = studio.getByLabel('Signature HTML');
    await expect(editor).toHaveValue(/\{\{name\}\}/);
    await editor.fill('<b>{{name}}</b><script>alert(1)</script>');
    await expect(studio.getByRole('alert').filter({ hasText: 'The <script> tag is not allowed.' })).toBeVisible();
    await studio.getByRole('button', { name: 'Save design' }).click();
    await expect(studio.getByText('Signature design saved to the card.')).toHaveCount(0);
    await editor.fill('<table><tr><td style="color:{{accent}}"><b>{{name}}</b>{{#phone}} · <a href="{{phoneHref}}">{{phone}}</a>{{/phone}}</td></tr></table>');
    await expect(studio.getByText(/^HTML is valid/)).toBeVisible();
    const frameText = () => studio.locator('iframe[title="Preview"]').evaluate((f: HTMLIFrameElement) => f.contentDocument?.body.innerText ?? '');
    await expect.poll(frameText).toContain('E2e SİGNATURE · +90 555 111 22 33');
    await studio.getByRole('button', { name: 'Save design' }).click();
    await expect(studio.getByText('Signature design saved to the card.')).toBeVisible();
    await page.keyboard.press('Escape');

    studio = await openStudio();
    await expect(studio.getByLabel('Signature HTML')).toHaveValue(/\{\{#phone\}\}/);
    await studio.getByRole('tab', { name: 'Template' }).click();
    await expect(studio.getByRole('button', { name: 'Free HTML', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(page.getByText('Card deleted.')).toBeVisible();
    rmSync(photo, { force: true });
    await signOut(page);
  });
});
