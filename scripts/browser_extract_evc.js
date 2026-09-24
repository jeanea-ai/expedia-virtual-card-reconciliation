(function attachExpediaEvcExtractor(root) {
  "use strict";

  const HEADER_ALIASES = {
    guest: ["guest", "guest name", "traveler", "traveler name"],
    reservationId: ["reservation", "reservation id", "itinerary", "itinerary id"],
    checkIn: ["check-in", "check in", "check-in date", "arrival", "arrival date"],
    status: ["status", "card status", "virtual card status"],
    remainingBalance: ["remaining balance", "available balance", "balance"],
    refundAmount: ["refund amount", "amount to refund", "refund", "amount"]
  };

  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function canonical(value) {
    return clean(value).toLowerCase().replace(/[?:]/g, "");
  }

  function findHeaderIndex(headers, field) {
    const aliases = HEADER_ALIASES[field];
    return headers.findIndex((header) => aliases.includes(canonical(header)));
  }

  function classifySection(label, headers) {
    const text = canonical(label);
    if (text.includes("refund")) return "refund_due";
    if (text.includes("ready to charge") || text.includes("charge")) return "ready_to_charge";
    if (findHeaderIndex(headers, "remainingBalance") >= 0) return "ready_to_charge";
    return null;
  }

  function moneyFromText(value) {
    const match = clean(value).match(/(?:[A-Z]{3}\s*)?\$?\s*[0-9]+(?:,[0-9]{3})*\.\d{2}(?:\s*[A-Z]{3})?/);
    return match ? clean(match[0]) : "";
  }

  function extractOriginalPayout(detailRows) {
    for (const detail of detailRows || []) {
      const text = clean(detail);
      if (/original payout/i.test(text)) return moneyFromText(text);
    }
    return "";
  }

  function extractTable(table, warnings) {
    const headers = (table.headers || []).map(clean);
    const queue = classifySection(table.sectionLabel || table.caption || table.ariaLabel, headers);
    if (!queue) return [];

    const guestIndex = findHeaderIndex(headers, "guest");
    const reservationIndex = findHeaderIndex(headers, "reservationId");
    const amountIndex = findHeaderIndex(headers, queue === "refund_due" ? "refundAmount" : "remainingBalance");
    const checkInIndex = findHeaderIndex(headers, "checkIn");
    const statusIndex = findHeaderIndex(headers, "status");
    const missing = [];
    if (guestIndex < 0) missing.push("guest");
    if (reservationIndex < 0) missing.push("reservationId");
    if (amountIndex < 0) missing.push(queue === "refund_due" ? "refundAmount" : "remainingBalance");
    if (missing.length) {
      warnings.push(`${queue} table missing required headers: ${missing.join(", ")}`);
      return [];
    }

    const records = [];
    for (const row of table.rows || []) {
      const cells = row.cells || [];
      if (row.isDetail || cells.length === 1) continue;
      const amountText = clean(cells[amountIndex]);
      const badgeStatus = canonical(amountText) === "deactivated" ? "Deactivated" : "";
      const record = {
        queue,
        guest: clean(cells[guestIndex]),
        reservationId: clean(cells[reservationIndex]),
        amount: badgeStatus ? null : amountText,
        checkIn: checkInIndex >= 0 ? clean(cells[checkInIndex]) : "",
        status: badgeStatus || (statusIndex >= 0 ? clean(cells[statusIndex]) : "")
      };
      if (queue === "ready_to_charge") record.originalPayout = extractOriginalPayout(row.detailRows);
      records.push(record);
    }
    return records;
  }

  function extractSnapshot(snapshot, pageNumber = 1) {
    const warnings = [];
    const tables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
    const records = tables.flatMap((table) => extractTable(table, warnings));
    const detectedQueues = new Set([
      ...tables.map((table) => classifySection(table.sectionLabel || table.caption || table.ariaLabel, table.headers || [])).filter(Boolean),
      ...(snapshot.emptyQueues || [])
    ]);
    for (const queue of ["ready_to_charge", "refund_due"]) {
      if (!detectedQueues.has(queue)) warnings.push(`Required section not found: ${queue}`);
    }
    const expectedCounts = snapshot.expectedCounts || {};
    const expectedCount = Number.isInteger(expectedCounts.total)
      ? expectedCounts.total
      : [expectedCounts.ready_to_charge, expectedCounts.refund_due].every(Number.isInteger)
        ? expectedCounts.ready_to_charge + expectedCounts.refund_due
        : null;
    if (expectedCount === null) warnings.push("Displayed result count was not found");
    if (!snapshot.property || !clean(snapshot.property.id) || !clean(snapshot.property.name)) warnings.push("Property identity was not verified");

    return {
      extractionVersion: "1.0.0",
      pageNumber,
      status: warnings.length ? "incomplete" : "complete",
      property: snapshot.property || null,
      expectedCount,
      pagination: snapshot.pagination || { hasNext: false, range: null },
      warnings,
      records
    };
  }

  function nearestSectionLabel(table) {
    const explicit = table.getAttribute("aria-label") || table.caption?.textContent;
    if (clean(explicit)) return clean(explicit);
    let cursor = table;
    for (let depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.parentElement) {
      const heading = cursor.querySelector?.("h1, h2, h3, h4, [role='heading']");
      if (heading && clean(heading.textContent)) return clean(heading.textContent);
      let sibling = cursor.previousElementSibling;
      while (sibling) {
        if (sibling.matches?.("h1, h2, h3, h4, [role='heading']")) return clean(sibling.textContent);
        sibling = sibling.previousElementSibling;
      }
    }
    return "";
  }

  function tableToSnapshot(table) {
    const allRows = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table);
    const headerRow = allRows.find((row) => row.querySelector("th")) || allRows[0];
    const cellsFor = (row) => [...row.children].filter((cell) => /^(TD|TH)$/i.test(cell.tagName));
    const headers = headerRow ? cellsFor(headerRow).map((cell) => clean(cell.textContent)) : [];
    const rows = [];
    let lastRecord = null;
    for (const row of allRows) {
      if (row === headerRow) continue;
      const nested = row.querySelector("table");
      const cells = cellsFor(row).map((cell) => clean(cell.textContent));
      if (nested || cells.length === 1) {
        if (lastRecord) lastRecord.detailRows.push(clean(row.textContent));
        continue;
      }
      lastRecord = { cells, detailRows: [] };
      rows.push(lastRecord);
    }
    return { sectionLabel: nearestSectionLabel(table), headers, rows };
  }

  function readText(rootNode, selectors) {
    for (const selector of selectors) {
      const node = rootNode.querySelector(selector);
      if (node && clean(node.textContent || node.value)) return clean(node.textContent || node.value);
    }
    return "";
  }

  function parseDisplayedCounts(text) {
    const counts = {};
    const total = clean(text).match(/(?:of|total)\s+([0-9,]+)\s+(?:results?|records?)/i);
    if (total) counts.total = Number(total[1].replaceAll(",", ""));
    return counts;
  }

  function validRange(text) {
    const match = clean(text).match(/\b([0-9,]+)\s*[-–]\s*([0-9,]+)\s+of\s+([0-9,]+)\b/i);
    if (!match) return null;
    const values = match.slice(1).map((value) => Number(value.replaceAll(",", "")));
    return values[0] >= 1 && values[0] <= values[1] && values[1] <= values[2] ? { text: match[0], total: values[2] } : null;
  }

  function isQueueHeading(element, heading) {
    return element !== heading && !heading.contains?.(element) && classifySection(element.textContent, []) !== null;
  }

  function boundedRegion(heading) {
    if (!heading.parentElement) return heading;
    let region = heading;
    let previous = heading;
    let cursor = heading.parentElement;
    for (let depth = 0; cursor && depth < 12; depth += 1, previous = cursor, cursor = cursor.parentElement) {
      const otherHeading = [...cursor.querySelectorAll("h1, h2, h3, h4, [role='heading']")].find((h) => isQueueHeading(h, heading));
      if (otherHeading) return previous;
      region = cursor;
    }
    return region;
  }

  function emptySections(document) {
    const queues = [];
    for (const heading of document.querySelectorAll("h1, h2, h3, h4, [role='heading']")) {
      const queue = classifySection(heading.textContent, []);
      if (!queue) continue;
      const semantic = heading.closest("section, article, [role='region']");
      const candidates = semantic ? [semantic, boundedRegion(heading)] : [boundedRegion(heading)];
      for (const region of candidates) {
        if (!region) continue;
        if (region.querySelector("table")) continue;
        if (/no virtual cards found\b/i.test(clean(region.textContent))) {
          queues.push(queue);
          break;
        }
      }
    }
    return [...new Set(queues)];
  }

  function wrapperRange(document) {
    const paginationNodes = [...document.querySelectorAll("[data-testid*='pagination' i], [aria-label*='pagination' i], nav, [class*='pagination' i]")];
    return paginationNodes.map((node) => validRange(node.textContent)).find(Boolean) || null;
  }

  function controlsRange(document) {
    const controlsButton = [...document.querySelectorAll("button")].find((button) =>
      /previous records|next records/i.test(clean(button.textContent || button.getAttribute("aria-label")))
    );
    if (!controlsButton || !controlsButton.parentElement) return null;
    let cursor = controlsButton.parentElement;
    for (let depth = 0; cursor && depth < 12; depth += 1, cursor = cursor.parentElement) {
      const leafTexts = [...cursor.querySelectorAll("*")]
        .filter((element) => element.children.length === 0)
        .map((element) => validRange(clean(element.textContent)))
        .filter(Boolean)
        .map((match) => match.text);
      const distinct = [...new Set(leafTexts)];
      if (distinct.length === 1) return validRange(distinct[0]);
      if (distinct.length > 1) return null;
    }
    return null;
  }

  function normalizePropertyName(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function observedPropertyIdentity(document) {
    const propertyId = document.querySelector("[data-property-id]")?.getAttribute("data-property-id") || new URL(document.location?.href || "https://invalid.local").searchParams.get("htid") || "";
    const propertyName = readText(document, ["[data-testid='property-name']", "[data-property-name]", "[aria-label*='property' i]"]);
    return { id: clean(propertyId), name: propertyName };
  }

  function hasLoginSurface(document) {
    if (document.querySelector("input[type='password']")) return true;
    if (document.querySelector("form input[type='email'], form input[name='email']")) return true;
    for (const heading of document.querySelectorAll("h1, h2, h3, h4, [role='heading']")) {
      if (/sign in|log in/i.test(clean(heading.textContent))) return true;
    }
    for (const form of document.querySelectorAll("form[action]")) {
      if (/login/i.test(form.getAttribute("action") || "")) return true;
    }
    return false;
  }

  function verifyInteractiveSession(document, expectedProperty) {
    const authenticated = !hasLoginSurface(document);
    if (!authenticated) {
      return { verificationVersion: "1.0.0", authenticated: false, property: null, propertyMatch: null, ok: false, reason: "login_required" };
    }

    const observed = observedPropertyIdentity(document);
    if (!observed.id || !observed.name) {
      return { verificationVersion: "1.0.0", authenticated: true, property: null, propertyMatch: null, ok: false, reason: "property_ambiguous" };
    }

    const property = { id: observed.id, name: observed.name };
    const idMatches = observed.id === clean(expectedProperty?.id);
    const nameMatches = normalizePropertyName(observed.name) === normalizePropertyName(expectedProperty?.name);
    const propertyMatch = idMatches && nameMatches;
    return {
      verificationVersion: "1.0.0",
      authenticated: true,
      property,
      propertyMatch,
      ok: propertyMatch,
      reason: propertyMatch ? "" : "property_mismatch"
    };
  }

  function extractDocument(document, pageNumber = 1) {
    const bodyText = clean(document.body?.textContent);
    const { id: propertyId, name: propertyName } = observedPropertyIdentity(document);
    const nextButton = [...document.querySelectorAll("button")].find((button) => /next records|next/i.test(clean(button.textContent || button.getAttribute("aria-label"))));
    const paginationRange = wrapperRange(document) || controlsRange(document);
    const snapshot = {
      property: { id: clean(propertyId), name: propertyName },
      expectedCounts: paginationRange ? { total: paginationRange.total } : parseDisplayedCounts(bodyText),
      pagination: {
        hasNext: Boolean(nextButton && !nextButton.disabled && nextButton.getAttribute("aria-disabled") !== "true"),
        range: paginationRange?.text || null
      },
      tables: [...document.querySelectorAll("table")].map(tableToSnapshot),
      emptyQueues: emptySections(document)
    };
    return extractSnapshot(snapshot, pageNumber);
  }

  const api = { extractDocument, extractSnapshot, verifyInteractiveSession };
  root.ExpediaEvcExtractor = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
