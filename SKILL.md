---
name: "expedia-virtual-card-reconciliation"
description: "Pull Expedia virtual card data into a PDF guest+amount report. Use: check Expedia VCs, VC reconciliation, cards ready to charge, virtual card refund."
tags: [hotel, expedia, virtual-cards, reconciliation, browser, accounting]
---

# Expedia Virtual Card Reconciliation

Pull and report virtual-card data from Expedia Partner Central's EVC Manage page: which cards are ready to charge, which need refunds, and for what amounts. Produces a styled PDF report.

## Prerequisites

- Expedia Partner Central login credentials (username + password)
- The hotel's Expedia property ID (`htid` parameter)
- Browser access to `expediapartnercentral.com`
- The property may have MFA/2FA enabled (SMS code to registered phone)

## Workflow

### 1. Accept credentials

Ask the user for their Expedia Partner Central credentials if not already provided:
- Email (username)
- Password

Also confirm the hotel's `htid` (Expedia property ID). Default to the hotel's configured property ID when the user hasn't specified one.

### 2. Navigate and log in

1. Navigate to `https://www.expediapartnercentral.com`
2. The page redirects to a login form with an **Email** field and a **Next** button.
3. Fill the email field via `evaluate`:

```js
() => {
  const e = document.querySelector('input[type="email"]') || document.querySelector('input[name="email"]') || document.querySelector('input[type="text"]');
  e.value = '<email>';
  e.dispatchEvent(new Event('input', {bubbles:true}));
  e.dispatchEvent(new Event('change', {bubbles:true}));
  return {found: !!e, valueLen: e.value.length};
}
```

4. Click the **Next** button.
5. On the password page (heading: "Enter your password"), fill the password field:

```js
() => {
  const p = document.querySelector('input[type="password"]');
  p.value = '<password>';
  p.dispatchEvent(new Event('input', {bubbles:true}));
  p.dispatchEvent(new Event('change', {bubbles:true}));
  p.dispatchEvent(new Event('keyup', {bubbles:true}));
  return {found: !!p, valueLen: p.value.length};
}
```

6. Click the **Continue** button (enables after password is filled).

### 3. Handle MFA (if required)

After successful password entry, Expedia may require additional verification:
- A verification code is sent via SMS to the registered phone
- The page shows: "Additional verification required — check your mobile"
- Ask the user for the verification code
- Type it into the **"Enter verification code"** textbox and click **VERIFY DEVICE**

If the code expires, Expedia sends a new one and shows an alert: "We've sent you a new verification code." Close that alert and use the new code.

After successful MFA, the dashboard loads showing "Welcome, <name>" and the property selector.

### 4. Navigate to the EVC Manage page

Navigate directly to:
```
https://apps.expediapartnercentral.com/supply/reservations/evc-manage?tab=EVC_MANAGE&htid=<HTID>
```

The page has two tabs: "Search for a card" and "Manage virtual cards" (selected by default via `tab=EVC_MANAGE`).

### 5. Extract virtual card data

Use `act: evaluate` to extract data from both sections:

```js
() => {
  const result = { refunds: [], refundsEmpty: true, toCharge: [] };

  const tables = [...document.querySelectorAll('table')];
  for (const table of tables) {
    const headerText = table.rows[0]?.textContent || '';
    if (headerText.includes('Remaining balance')) {
      const rows = [...table.rows];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const cells = [...row.cells];
        if (row.querySelector('button') && !row.querySelector('table') && cells.length >= 7) {
          result.toCharge.push({
            guest: cells[1].textContent.trim(),
            reservation: cells[2].textContent.trim(),
            checkIn: cells[3].textContent.trim(),
            remainingBalance: cells[6].textContent.trim(),
            originalPayout: ''
          });
        }
        if (row.querySelector('table') && result.toCharge.length > 0) {
          const text = row.textContent;
          const amt = text.match(/USD\s*([\d,]+\.\d{2})/);
          result.toCharge[result.toCharge.length - 1].originalPayout = amt ? amt[1] : '';
        }
      }
    }
  }

  result.refundsEmpty = document.body.textContent.includes('No virtual cards found');

  if (!result.refundsEmpty) {
    const h2s = [...document.querySelectorAll('h2')];
    const refundH2 = h2s.find(h => h.textContent.trim() === 'Virtual cards to refund');
    if (refundH2) {
      let parent = refundH2.parentElement;
      for (let d = 0; d < 6; d++) {
        const t = parent?.querySelector('table');
        if (t && [...t.rows].length > 0) {
          const rows = [...t.rows];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.querySelector('button') && !row.querySelector('table')) {
              const cells = [...row.cells];
              result.refunds.push({
                guest: cells[1]?.textContent?.trim() || '',
                reservation: cells[2]?.textContent?.trim() || '',
                amount: ''
              });
            }
            if (row.querySelector('table') && result.refunds.length > 0) {
              const amt = row.textContent.match(/USD\s*([\d,]+\.\d{2})/);
              result.refunds[result.refunds.length - 1].amount = amt ? amt[1] : '';
            }
          }
          break;
        }
        parent = parent?.parentElement;
      }
    }
  }

  return result;
}
```

### 6. Check for pagination

The "ready to charge" table may span multiple pages. Check for "Previous records" / "Next records" buttons and page counts (e.g. "1-2 of 2 results"). If there are more pages, click **Next records** and re-extract, merging results. Stop when "Next records" is disabled or you've seen all results.

### 7. Generate and deliver the PDF report

After extracting data, generate a styled PDF report:

**Step A — Build HTML report.** Write a styled HTML file to `/tmp/expedia-vc-report.html` using a heredoc or write tool. Template:

```html
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; max-width: 750px; margin: 40px auto; color: #1a1a2e; }
  h1 { font-size: 20px; margin-bottom: 2px; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 15px; border-bottom: 2px solid #2563eb; padding-bottom: 4px; margin-top: 28px; color: #2563eb; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #f1f5f9; text-align: left; padding: 8px 10px; font-size: 12px; text-transform: uppercase; color: #64748b; }
  td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
  .amount { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row td { font-weight: 700; border-top: 2px solid #2563eb; border-bottom: none; padding-top: 10px; }
  .empty { color: #94a3b8; font-style: italic; padding: 8px 0; }
  .footer { margin-top: 32px; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; }
  .badge-deactivated { background: #fef3c7; color: #92400e; }
</style></head><body>
<h1>Expedia Virtual Card Report</h1>
<p class="subtitle">PROPERTY_NAME (htid: HTID) · Generated REPORT_DATE</p>

<h2>Virtual Cards to Refund</h2>
<!-- refund rows or empty message -->

<h2>Virtual Cards Ready to Charge</h2>
<table><thead><tr><th>Guest</th><th>Reservation</th><th>Check-in</th><th>Status</th><th>Amount</th></tr></thead><tbody>
<!-- charge rows + total row -->
</tbody></table>

<div class="footer">Generated by Kolo · Data source: Expedia Partner Central EVC Manage · REPORT_DATE</div>
</body></html>
```

For each charge row:
```html
<tr><td>GUEST</td><td>RES_ID</td><td>CHECKIN</td><td><span class="badge badge-deactivated">STATUS</span></td><td class="amount">$AMOUNT</td></tr>
```

Total row at bottom:
```html
<tr class="total-row"><td colspan="4">Total Ready to Charge</td><td class="amount">$TOTAL</td></tr>
```

Empty refunds:
```html
<p class="empty">No virtual cards found — nothing to refund</p>
```

**Step B — Render to PDF.** Use headless Chromium:

```bash
chromium --headless --no-sandbox --disable-gpu --print-to-pdf=/tmp/expedia-vc-report.pdf /tmp/expedia-vc-report.html
```

**Step C — Deliver to the user.** 
- Announce a brief summary of the numbers
- Use the `message` tool to send the PDF: `message(action="send", channel="kolo", target="<kolo:uuid>", media="/tmp/expedia-vc-report.pdf", message="Here's your Expedia virtual card report.", filename="Expedia-VC-Report.pdf")`
- Log the delivery via `kolo log-action`

## Error handling

- **Login fails**: Re-verify field values via DOM check; re-submit once. If still failing, tell the user to verify their credentials.
- **MFA code expired**: Expedia sends a new code automatically with an alert. Close the alert and ask the user for the new code.
- **MFA code rejected**: Ask the user to confirm the correct code. Try once more.
- **"No virtual cards found"**: Normal — report it as empty, not an error.
- **All cards "Deactivated"**: Note it; original payout column still shows the amount.
- **Page fails to load / session expired**: Re-login from step 2.
- **Browser session lost** (only `newtab.html` visible): Re-login from scratch.
- **PDF generation fails with chromium**: Fall back to delivering the plain-text table report.

## Gotchas

- The login is a 2-step flow (email → Next → password → Continue), NOT a single form.
- The password field requires dispatching `input`, `change`, AND `keyup` events to enable the Continue button.
- The "ready to charge" table has expandable guest rows with nested detail tables. Use `table.rows` (not `querySelectorAll('tr')`) to avoid picking up nested table rows.
- Guest rows have 7 cells and contain an expand button; detail rows have 1 cell spanning full width.
- Card details show the full card number, CVV, and expiration. The report should only surface the **amount** — do NOT include full card numbers.
- The refund section heading says "Virtual cards to refund" (exact text) — match exactly.
- PDF: use `chromium --headless --no-sandbox --print-to-pdf`. The `--no-sandbox` flag is required inside this container.

## Model routing

Browser-heavy workflow. Pin `sonnet` or higher for reliable DOM extraction and PDF rendering. `qwen` works fine for the extraction evaluate call when the page is already loaded.
